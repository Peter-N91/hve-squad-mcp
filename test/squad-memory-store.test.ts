/**
 * Squad memory-store + CAS unit tests (Phase 6, Step 6.1).
 *
 * Runs the security-critical store behaviors against BOTH realizations so the
 * shared-state broker has identical semantics in dev (file) and production
 * (Azure Table): a `write`→`read` round-trip, a compare-and-swap conflict on a
 * stale `expectedEtag`, and `tenantId:project` partition isolation. The table
 * store is driven against a minimal in-memory fake table behind an injected
 * `fetch` (mirroring test/azure-table-run-state.test.ts) — NO live Azure — and
 * the encrypted-at-rest assertion mirrors test/field-cipher.test.ts (the
 * `gcm1:` envelope prefix). The CAS-conflict assertion mirrors
 * test/run-state-cas.test.ts.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

import {
  isSafeMemoryPath,
  isSafeMemorySegment,
  type SquadMemoryStore,
} from "../src/engine/squad-memory-state.js";
import { FileSquadMemoryStore } from "../src/engine/backends/file-squad-memory.js";
import { AzureTableSquadMemoryStore } from "../src/engine/backends/azure-table-squad-memory.js";
import { AesGcmFieldCipher, type FieldCipher } from "../src/engine/field-cipher.js";

function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "squad-memory-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Azure Table Storage forbids `/`, `\`, `#`, `?`, and control characters
 * (U+0000-U+001F, U+007F-U+009F) in PartitionKey / RowKey values. The fake table
 * enforces this so a store that stored a raw multi-segment path in the RowKey
 * would fail here exactly as it would against live Azure (FR-01 regression guard).
 */
function isValidTableKey(key: string): boolean {
  // eslint-disable-next-line no-control-regex
  return !/[/\\#?\u0000-\u001f\u007f-\u009f]/.test(key);
}

/**
 * A minimal in-memory Table Storage backend behind an injectable `fetch`,
 * covering exactly the operations {@link AzureTableSquadMemoryStore} issues:
 *   * single-entity GET / PUT (Insert-Or-Replace or If-Match CAS) at
 *     `.../<table>(PartitionKey='..',RowKey='..')`;
 *   * a `$filter` collection query at `.../<table>()?$filter=...` (used by
 *     `list` with `PartitionKey eq` and `listProjects` with `ge`/`lt`).
 * The PUT response carries an `etag` header (the store's write etag); the GET
 * carries `odata.etag` (the store's read etag).
 */
class FakeMemoryTable {
  private readonly rows = new Map<string, { entity: Record<string, unknown>; etag: string }>();
  private seq = 0;
  /** WI-07 — count of `POST .../Tables` create calls, for auto-create assertions. */
  tablePosts = 0;
  private tableCreated = false;

  readonly fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;

    // WI-07 — table create (`POST .../Tables`): 204 on first create, 409
    // (already exists) thereafter, so both the create and swallow-409 paths run.
    if (method === "POST" && /\/Tables$/.test(url)) {
      this.tablePosts += 1;
      const created = this.tableCreated;
      this.tableCreated = true;
      return new Response(null, { status: created ? 409 : 204 });
    }

    // Single-entity operations carry the exact key in the path.
    const entityMatch = /\(PartitionKey='([^']*)',RowKey='([^']*)'\)/.exec(url);
    if (entityMatch) {
      const partitionKey = decodeURIComponent(entityMatch[1]);
      const rowKey = decodeURIComponent(entityMatch[2]);
      // Azure Table Storage rejects `/`, `\`, `#`, `?`, and control characters in
      // PartitionKey / RowKey with 400 (Bad Request). The store must never place a
      // raw multi-segment path in the key; enforce the real constraint here so a
      // regression cannot slip past this fake (FR-01).
      if (!isValidTableKey(partitionKey) || !isValidTableKey(rowKey)) {
        return new Response(null, { status: 400 });
      }
      const mapKey = this.key(partitionKey, rowKey);
      if (method === "GET") {
        const existing = this.rows.get(mapKey);
        if (!existing) {
          return new Response(null, { status: 404 });
        }
        return this.json({ ...existing.entity, "odata.etag": existing.etag });
      }
      if (method === "PUT") {
        const ifMatch = headers["If-Match"];
        const existing = this.rows.get(mapKey);
        if (ifMatch !== undefined && ifMatch !== "*" && (!existing || ifMatch !== existing.etag)) {
          return new Response(null, { status: 412 });
        }
        const entity = JSON.parse(init?.body as string) as Record<string, unknown>;
        const etag = this.nextEtag();
        this.rows.set(mapKey, { entity, etag });
        return new Response(null, { status: 204, headers: { etag } });
      }
      if (method === "DELETE") {
        this.rows.delete(mapKey);
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 405 });
    }

    // Collection query.
    if (method === "GET") {
      const filter = new URL(url).searchParams.get("$filter") ?? "";
      let matches = [...this.rows.values()];
      const eq = /PartitionKey eq '([^']+)'/.exec(filter);
      if (eq) {
        matches = matches.filter((r) => (r.entity.PartitionKey as string) === eq[1]);
      }
      const ge = /PartitionKey ge '([^']+)'/.exec(filter);
      const lt = /PartitionKey lt '([^']+)'/.exec(filter);
      if (ge && lt) {
        matches = matches.filter((r) => {
          const pk = r.entity.PartitionKey as string;
          return pk >= ge[1] && pk < lt[1];
        });
      }
      const value = matches.map((r) => ({ ...r.entity, "odata.etag": r.etag }));
      return this.json({ value });
    }
    return new Response(null, { status: 405 });
  };

  /** The raw stored (still-sealed) entity, for at-rest inspection. */
  raw(partitionKey: string, rowKey: string): Record<string, unknown> | undefined {
    return this.rows.get(this.key(partitionKey, rowKey))?.entity;
  }

  private key(partitionKey: string, rowKey: string): string {
    return `${partitionKey}\u0000${rowKey}`;
  }
  private nextEtag(): string {
    this.seq += 1;
    return `W/"etag-${this.seq}"`;
  }
  private json(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }
}

function tableStoreOn(table: FakeMemoryTable, cipher?: FieldCipher): AzureTableSquadMemoryStore {
  return new AzureTableSquadMemoryStore({
    account: "fakeacct",
    tableName: "squadmemory",
    getAccessToken: async () => "fake-token",
    fetchImpl: table.fetch,
    cipher,
  });
}

/** Run a body against a fresh file store and a fresh table store (CAS parity). */
async function forEachStore(body: (store: SquadMemoryStore) => Promise<void>): Promise<void> {
  const { dir, cleanup } = tempDir();
  try {
    await body(new FileSquadMemoryStore({ baseDir: dir }));
  } finally {
    cleanup();
  }
  await body(tableStoreOn(new FakeMemoryTable()));
}

test("write -> read round-trips the content and returns the write etag", async () => {
  await forEachStore(async (store) => {
    const result = await store.write("tenant-a", "alpha", "state", "the current working state");
    assert.equal(result.ok, true, "the first write succeeds");
    assert.ok(result.ok && result.etag.length > 0, "a write yields a non-empty CAS token");

    const read = await store.read("tenant-a", "alpha", "state");
    assert.ok(read, "the entry reads back");
    assert.equal(read?.content, "the current working state", "the content round-trips");
    assert.equal(read?.project, "alpha");
    assert.equal(read?.path, "state");
    assert.equal(read?.tenantId, "tenant-a");
    assert.equal(read?.etag, result.ok ? result.etag : "", "the read etag matches the write etag");
  });
});

test("read of a missing entry returns undefined (no throw, no leakage)", async () => {
  await forEachStore(async (store) => {
    assert.equal(await store.read("tenant-a", "alpha", "does-not-exist"), undefined);
  });
});

test("multi-segment path families round-trip (history/<agent>, repo-memory/<name>) (FR-01)", async () => {
  await forEachStore(async (store) => {
    const write = await store.write("tenant-a", "alpha", "history/lead", "lead history line");
    assert.equal(write.ok, true, "a multi-segment history path writes");
    const read = await store.read("tenant-a", "alpha", "history/lead");
    assert.equal(read?.path, "history/lead", "the raw multi-segment path round-trips");
    assert.equal(read?.content, "lead history line", "the content round-trips");

    const repo = await store.write("tenant-a", "alpha", "repo-memory/squad-planner", "repo note");
    assert.equal(repo.ok, true, "a multi-segment repo-memory path writes");
    const repoRead = await store.read("tenant-a", "alpha", "repo-memory/squad-planner");
    assert.equal(repoRead?.path, "repo-memory/squad-planner", "the raw repo-memory path round-trips");

    const listed = (await store.list("tenant-a", "alpha")).map((e) => e.path).sort();
    assert.deepEqual(listed, ["history/lead", "repo-memory/squad-planner"], "both families list by raw path");
  });
});

test("Azure Table store never places a raw multi-segment path in the RowKey (FR-01)", async () => {
  const table = new FakeMemoryTable();
  const store = tableStoreOn(table);
  const write = await store.write("tenant-a", "alpha", "history/lead", "lead history line");
  assert.equal(write.ok, true, "the write succeeds against the Azure key-constraint-enforcing fake");

  // The persisted RowKey must be the percent-encoded path, never the raw `/` form
  // (Azure Table forbids `/` in key fields; the fake would 400 otherwise).
  const raw = table.raw("tenant-a:alpha", encodeURIComponent("history/lead")) as Record<string, unknown>;
  assert.ok(raw, "the entity is stored under the percent-encoded RowKey");
  assert.equal(raw.RowKey, "history%2Flead", "the RowKey is percent-encoded (no forbidden separator)");
  assert.equal(raw.path, "history/lead", "the raw path is preserved in its own property for round-trip");
});

test("Azure Table store creates the table on first write, once, and never on read (WI-07)", async () => {
  const table = new FakeMemoryTable();
  const store = tableStoreOn(table);

  // Reads against a not-yet-created table must never issue a table-create POST.
  assert.equal(await store.read("tenant-a", "alpha", "state"), undefined, "a missing read returns undefined");
  assert.deepEqual(await store.list("tenant-a", "alpha"), [], "a missing list returns []");
  assert.deepEqual(await store.listProjects("tenant-a"), [], "a missing listProjects returns []");
  assert.equal(table.tablePosts, 0, "read / list / listProjects never issue POST /Tables");

  // The first write creates the table, then persists the entity.
  const first = await store.write("tenant-a", "alpha", "state", "v1");
  assert.equal(first.ok, true, "the first write against a not-yet-created table succeeds");
  assert.equal(table.tablePosts, 1, "the first write issues exactly one POST /Tables");
  assert.equal((await store.read("tenant-a", "alpha", "state"))?.content, "v1", "the entity persisted after create");

  // A second write is memoized — no re-create.
  const second = await store.write("tenant-a", "alpha", "state", "v2", first.ok ? first.etag : undefined);
  assert.equal(second.ok, true, "the second write wins the CAS");
  assert.equal(table.tablePosts, 1, "the table-create is memoized — no second POST /Tables");
});

test("Azure Table store swallows a 409 (table already exists) on first write (WI-07)", async () => {
  const table = new FakeMemoryTable();
  // A first store creates the table (204).
  await tableStoreOn(table).write("tenant-a", "alpha", "state", "seed");
  assert.equal(table.tablePosts, 1, "the first store created the table");

  // A fresh store (its own memo) issues its own create and sees a 409 — still succeeds.
  const store2 = tableStoreOn(table);
  const write = await store2.write("tenant-a", "alpha", "other", "content");
  assert.equal(write.ok, true, "a first write that races into a 409 already-exists still succeeds");
  assert.equal(table.tablePosts, 2, "the second store issued its own (409) create");
  assert.equal((await store2.read("tenant-a", "alpha", "other"))?.content, "content", "the entity persisted");
});

test("an unsafe-path write never issues a table-create POST (WI-07)", async () => {
  const table = new FakeMemoryTable();
  const store = tableStoreOn(table);
  const result = await store.write("tenant-a", "alpha", "../escape", "should never land");
  assert.equal(result.ok, false, "an unsafe path never writes");
  assert.equal(table.tablePosts, 0, "a rejected-key write never reaches the table-create guard");
});

test("CAS conflict: a write with a stale expectedEtag loses the race", async () => {
  await forEachStore(async (store) => {
    const first = await store.write("tenant-a", "alpha", "state", "v1");
    assert.ok(first.ok);
    const staleEtag = first.ok ? first.etag : "";

    // A matching-etag write wins and rotates the etag.
    const second = await store.write("tenant-a", "alpha", "state", "v2", staleEtag);
    assert.ok(second.ok, "a CAS write with the current etag wins");
    const currentEtag = second.ok ? second.etag : "";
    assert.notEqual(currentEtag, staleEtag, "the etag rotates on each write");

    // Re-using the now-stale etag loses the race and surfaces the current revision.
    const conflict = await store.write("tenant-a", "alpha", "state", "v3", staleEtag);
    assert.equal(conflict.ok, false, "a stale expectedEtag loses the CAS race");
    assert.equal(conflict.ok === false && conflict.conflict, true, "the loss is reported as a conflict");
    assert.ok(conflict.ok === false && conflict.current, "the conflict carries the current entry to re-read");
    assert.equal(
      conflict.ok === false ? conflict.current?.content : undefined,
      "v2",
      "the current entry reflects the winning write, not the clobber attempt",
    );
    assert.equal(
      conflict.ok === false ? conflict.current?.etag : undefined,
      currentEtag,
      "the conflict carries the current etag for a retry",
    );

    // The losing write never mutated the entry.
    const read = await store.read("tenant-a", "alpha", "state");
    assert.equal(read?.content, "v2", "the stale write did not clobber the winning content");
  });
});

test("list returns only the tenantId:project partition (isolation)", async () => {
  await forEachStore(async (store) => {
    await store.write("tenant-a", "alpha", "state", "alpha-state");
    await store.write("tenant-a", "alpha", "decisions", "alpha-decisions");
    await store.write("tenant-a", "beta", "state", "beta-state");
    await store.write("tenant-b", "alpha", "state", "b-alpha-state");

    const alpha = await store.list("tenant-a", "alpha");
    const paths = alpha.map((e) => e.path).sort();
    assert.deepEqual(paths, ["decisions", "state"], "only tenant-a/alpha entries are listed");
    for (const entry of alpha) {
      assert.equal(entry.project, "alpha", "no foreign project leaks into the partition list");
      assert.equal(entry.tenantId, "tenant-a", "no foreign tenant leaks into the partition list");
    }
    assert.ok(!alpha.some((e) => e.content === "beta-state"), "another project's content never appears");
    assert.ok(!alpha.some((e) => e.content === "b-alpha-state"), "another tenant's content never appears");
  });
});

test("listProjects returns only the tenant's own project namespaces", async () => {
  await forEachStore(async (store) => {
    await store.write("tenant-a", "alpha", "state", "x");
    await store.write("tenant-a", "beta", "state", "y");
    await store.write("tenant-b", "gamma", "state", "z");

    const projects = (await store.listProjects("tenant-a")).sort();
    assert.deepEqual(projects, ["alpha", "beta"], "only tenant-a's projects are visible");
    assert.ok(!projects.includes("gamma"), "another tenant's project namespace never leaks");
  });
});

test("Azure Table store persists an AES-GCM envelope prefix at rest when a cipher is injected", async () => {
  const table = new FakeMemoryTable();
  const store = tableStoreOn(table, new AesGcmFieldCipher(randomBytes(32)));
  await store.write("tenant-a", "alpha", "state", "SECRET-MEMORY-CONTENT-77");

  const raw = table.raw("tenant-a:alpha", "state") as Record<string, unknown>;
  assert.ok(raw, "the entity is stored under the tenantId:project partition key");
  const serialized = JSON.stringify(raw);
  assert.ok(!serialized.includes("SECRET-MEMORY-CONTENT-77"), "content is encrypted at rest");
  assert.equal(typeof raw.content, "string", "content is a sealed string property");
  assert.ok((raw.content as string).startsWith("gcm1:"), "the sealed content is an AES-GCM envelope");

  // A read decrypts the content back.
  const read = await store.read("tenant-a", "alpha", "state");
  assert.equal(read?.content, "SECRET-MEMORY-CONTENT-77", "a read decrypts the sealed content");
});

test("File store persists an AES-GCM envelope prefix at rest when a cipher is injected", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const store = new FileSquadMemoryStore({ baseDir: dir, cipher: new AesGcmFieldCipher(randomBytes(32)) });
    await store.write("tenant-a", "alpha", "state", "SECRET-FILE-CONTENT-88");

    const file = join(dir, "tenant-a", "alpha", "state.json");
    const raw = readFileSync(file, "utf8");
    assert.ok(!raw.includes("SECRET-FILE-CONTENT-88"), "content is encrypted at rest on disk");
    const envelope = JSON.parse(raw) as { content?: string };
    assert.ok((envelope.content ?? "").startsWith("gcm1:"), "the on-disk content is an AES-GCM envelope");

    const read = await store.read("tenant-a", "alpha", "state");
    assert.equal(read?.content, "SECRET-FILE-CONTENT-88", "a read decrypts the sealed content");
  } finally {
    cleanup();
  }
});

test("traversal guards reject unsafe segments and paths (SEC-4)", () => {
  // isSafeMemorySegment forbids separators, any character outside [A-Za-z0-9._-],
  // AND the dot-segments `.`/`..` (a bare `..` would otherwise collapse under
  // path.join in the file backend and escape the tenant/project directory).
  assert.equal(isSafeMemorySegment("alpha"), true);
  assert.equal(isSafeMemorySegment("squad-alpha_1.0"), true);
  assert.equal(isSafeMemorySegment("a/b"), false, "a separator is never a single safe segment");
  assert.equal(isSafeMemorySegment(""), false);
  assert.equal(isSafeMemorySegment("a b"), false, "whitespace is outside the safe class");
  assert.equal(isSafeMemorySegment("."), false, "a dot-segment is never a safe segment (SEC-4)");
  assert.equal(isSafeMemorySegment(".."), false, "a `..` segment is never a safe segment (SEC-4)");

  // isSafeMemoryPath: one or more safe, slash-joined segments; rejects any empty,
  // `.`, or `..` segment (the dot-segment traversal guard).
  assert.equal(isSafeMemoryPath("state"), true);
  assert.equal(isSafeMemoryPath("history/lead"), true);
  assert.equal(isSafeMemoryPath("repo-memory/squad-planner"), true);
  assert.equal(isSafeMemoryPath(""), false);
  assert.equal(isSafeMemoryPath("."), false);
  assert.equal(isSafeMemoryPath(".."), false);
  assert.equal(isSafeMemoryPath("../escape"), false);
  assert.equal(isSafeMemoryPath("history/../../etc/passwd"), false);
  assert.equal(isSafeMemoryPath("/abs/path"), false);
  assert.equal(isSafeMemoryPath("a//b"), false);
});

/**
 * SEC-4 regression: the file store must never let a `..` project segment collapse
 * under `path.join` and escape the tenant directory. Previously
 * {@link isSafeMemorySegment} permitted `..` (it matched the character class),
 * so `path.join(baseDir, tenantId, "..")` collapsed to `baseDir` and the
 * containment check anchored to that collapsed dir let a caller in one tenant read
 * ANOTHER tenant's entry via `project = ".."` + a path walking into the sibling
 * tenant directory. Reachable over HTTP through `resources/read` (whose project
 * comes only through `isSafeMemorySegment`), and `file` is the DEFAULT HTTP memory
 * backend. The guard now rejects dot-segments; this asserts the escape is closed.
 */
test(
  "file store must not let project='..' escape the tenant directory (SEC-4)",
  async () => {
    const { dir, cleanup } = tempDir();
    try {
      const store = new FileSquadMemoryStore({ baseDir: dir });
      await store.write("tenant-b", "secret", "state", "TENANT-B-PRIVATE");
      // A caller in tenant-a must NOT be able to reach tenant-b's entry.
      const escaped = await store.read("tenant-a", "..", "tenant-b/secret/state");
      assert.equal(escaped, undefined, "a '..' project must not escape into a sibling tenant directory");
    } finally {
      cleanup();
    }
  },
);

test("a write with a traversal path never persists and is reported as a lost race (no leakage)", async () => {
  await forEachStore(async (store) => {
    const result = await store.write("tenant-a", "alpha", "../escape", "should never land");
    assert.equal(result.ok, false, "an unsafe path never writes");
    assert.equal(result.ok === false && result.conflict, true, "an unsafe path is reported as a conflict");
    assert.equal(result.ok === false ? result.current : undefined, undefined, "no entry is leaked");
    // The partition stays empty — the malformed key never reached storage.
    assert.deepEqual(await store.list("tenant-a", "alpha"), []);
  });
});
