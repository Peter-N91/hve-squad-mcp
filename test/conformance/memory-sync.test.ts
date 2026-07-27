/**
 * Conformance — the `squad_memory_sync` batch write-back tool (WI-02, Phase 4).
 *
 * The assisted delegated write-back tool flushes a batch of the caller's own
 * `.copilot-tracking/squad/` memory entries in ONE call, applying each item under
 * its OWN compare-and-swap. This corpus proves the load-bearing guarantees:
 *   * SEC-2 default-deny — a token missing `Squad.MemoryWrite` is denied BEFORE
 *     any store access (a `Squad.Memory` read grant does NOT suffice).
 *   * Per-item CAS — a stale `expectedEtag` on ONE item is reported as a conflict
 *     WITHOUT aborting the rest of the batch (the others still commit).
 *   * SEC-3 tenant isolation — the store key derives from `auth.tenantId` (the
 *     validated token), never caller input: a write under one tenant is invisible
 *     to another.
 *
 * Runs a REAL {@link FileSquadMemoryStore} through the real HTTP handler stack
 * with the suite's fakes — NO live Azure. Mirrors test/conformance/memory-scope-denial.ts.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildHarness, callTool, initializeSession } from "./support/harness.js";
import { FakeJwtVerifier } from "./support/fake-auth.js";
import { FileSquadMemoryStore } from "../../src/engine/backends/file-squad-memory.js";
import type {
  SquadMemoryEntry,
  SquadMemoryStore,
  SquadMemoryWriteResult,
} from "../../src/engine/squad-memory-state.js";
import type { HttpResponseLike } from "../../src/transports/http-core.js";

const TENANT_A = "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

interface SyncResultItem {
  readonly path: string;
  readonly ok: boolean;
  readonly etag?: string;
  readonly conflict?: boolean;
}

function syncResultsOf(res: HttpResponseLike): SyncResultItem[] {
  return (
    (res.body as { result?: { results?: SyncResultItem[] } } | undefined)?.result?.results ?? []
  );
}
function reasonOf(res: HttpResponseLike): string | undefined {
  return (res.body as { error?: string } | undefined)?.error;
}

function tempStore(): { store: FileSquadMemoryStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "squad-sync-"));
  return {
    store: new FileSquadMemoryStore({ baseDir: dir }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * A store that counts every access and never persists — proves the scope gate
 * short-circuits before ANY store operation (the memory analogue of the
 * `backend.callCount === 0` assertion the other corpora make).
 */
class RecordingMemoryStore implements SquadMemoryStore {
  calls = 0;
  list(): Promise<SquadMemoryEntry[]> {
    this.calls += 1;
    return Promise.resolve([]);
  }
  read(): Promise<SquadMemoryEntry | undefined> {
    this.calls += 1;
    return Promise.resolve(undefined);
  }
  write(): Promise<SquadMemoryWriteResult> {
    this.calls += 1;
    return Promise.resolve({ ok: false, conflict: true, current: undefined });
  }
  listProjects(): Promise<string[]> {
    this.calls += 1;
    return Promise.resolve([]);
  }
}

// ---------------------------------------------------------------------------
// SEC-2 — default-deny on Squad.MemoryWrite, checked BEFORE any store access.
// ---------------------------------------------------------------------------

test("SEC-2: squad_memory_sync requires Squad.MemoryWrite (denied before store)", async () => {
  const store = new RecordingMemoryStore();
  const verifier = new FakeJwtVerifier();
  // Carries the READ scope only — so it proves a batch WRITE needs the distinct
  // Squad.MemoryWrite scope, not merely "some memory scope".
  verifier.register({ token: "read-only", tenantId: TENANT_A, subject: "user-a", scopes: ["Squad.Memory"] });
  const { handler } = buildHarness({ verifier, memoryStore: store });
  const sessionId = await initializeSession(handler, "read-only");

  const res = await callTool(handler, {
    token: "read-only",
    sessionId,
    name: "squad_memory_sync",
    args: { project: "p", items: [{ path: "state", content: "nope" }] },
  });
  assert.equal(res.status, 403, "squad_memory_sync requires Squad.MemoryWrite");
  assert.equal(reasonOf(res), "missing_scope");
  assert.equal(store.calls, 0, "the scope gate denied the batch before any store access");
});

// ---------------------------------------------------------------------------
// Per-item CAS — a stale expectedEtag on one item does NOT abort the batch.
// ---------------------------------------------------------------------------

test("WI-02: a stale expectedEtag on one item is a conflict without aborting the others", async () => {
  const { store, cleanup } = tempStore();
  try {
    const verifier = new FakeJwtVerifier();
    verifier.register({ token: "w", tenantId: TENANT_A, subject: "user-a", scopes: ["Squad.MemoryWrite"] });
    const { handler } = buildHarness({ verifier, memoryStore: store });
    const sessionId = await initializeSession(handler, "w");

    // Seed `state` so we can hand the batch a STALE etag for it.
    const seeded = await store.write(TENANT_A, "proj", "state", "v1");
    assert.equal(seeded.ok, true);

    const res = await callTool(handler, {
      token: "w",
      sessionId,
      name: "squad_memory_sync",
      args: {
        project: "proj",
        items: [
          // Stale etag → this item MUST lose the CAS race (conflict).
          { path: "state", content: "v2", expectedEtag: "stale-etag" },
          // No etag → a first write of a new entry, MUST commit.
          { path: "decisions", content: "a decision" },
        ],
      },
    });
    assert.equal(res.status, 200);
    const results = syncResultsOf(res);
    const byPath = new Map(results.map((item) => [item.path, item]));

    assert.equal(byPath.get("state")?.ok, false, "the stale item lost the CAS race");
    assert.equal(byPath.get("state")?.conflict, true, "the stale item is reported as a conflict");
    assert.equal(byPath.get("decisions")?.ok, true, "the fresh item still committed");
    assert.ok(byPath.get("decisions")?.etag, "the committed item returns its new etag");

    // The conflicting item did NOT clobber the seeded value; the other DID persist.
    assert.equal((await store.read(TENANT_A, "proj", "state"))?.content, "v1", "no silent clobber");
    assert.equal((await store.read(TENANT_A, "proj", "decisions"))?.content, "a decision");
  } finally {
    cleanup();
  }
});

test("WI-02: every item commits when each carries a matching (or absent) etag", async () => {
  const { store, cleanup } = tempStore();
  try {
    const verifier = new FakeJwtVerifier();
    verifier.register({ token: "w", tenantId: TENANT_A, subject: "user-a", scopes: ["Squad.MemoryWrite"] });
    const { handler } = buildHarness({ verifier, memoryStore: store });
    const sessionId = await initializeSession(handler, "w");

    const res = await callTool(handler, {
      token: "w",
      sessionId,
      name: "squad_memory_sync",
      args: {
        project: "proj",
        items: [
          { path: "state", content: "the state" },
          { path: "history/architect", content: "did the thing" },
        ],
      },
    });
    assert.equal(res.status, 200);
    const results = syncResultsOf(res);
    assert.equal(results.length, 2);
    assert.ok(results.every((item) => item.ok), "both first-writes commit");
    assert.equal((await store.read(TENANT_A, "proj", "state"))?.content, "the state");
    assert.equal((await store.read(TENANT_A, "proj", "history/architect"))?.content, "did the thing");
  } finally {
    cleanup();
  }
});

test("WI-02: a structurally invalid item fails only itself (no traversal, no abort)", async () => {
  const { store, cleanup } = tempStore();
  try {
    const verifier = new FakeJwtVerifier();
    verifier.register({ token: "w", tenantId: TENANT_A, subject: "user-a", scopes: ["Squad.MemoryWrite"] });
    const { handler } = buildHarness({ verifier, memoryStore: store });
    const sessionId = await initializeSession(handler, "w");

    const res = await callTool(handler, {
      token: "w",
      sessionId,
      name: "squad_memory_sync",
      args: {
        project: "proj",
        items: [
          { path: "../escape", content: "traversal" }, // SEC-4 unsafe path
          { path: "state", content: "the good one" },
        ],
      },
    });
    assert.equal(res.status, 200);
    const byPath = new Map(syncResultsOf(res).map((item) => [item.path, item]));
    assert.equal(byPath.get("../escape")?.ok, false, "the unsafe item failed");
    assert.equal(byPath.get("../escape")?.conflict, undefined, "an unsafe item is a failure, not a conflict");
    assert.equal(byPath.get("state")?.ok, true, "the safe item still committed");
    assert.equal((await store.read(TENANT_A, "proj", "state"))?.content, "the good one");
  } finally {
    cleanup();
  }
});

test("WI-02: an 'items' that is not an array rejects the whole call", async () => {
  const { store, cleanup } = tempStore();
  try {
    const verifier = new FakeJwtVerifier();
    verifier.register({ token: "w", tenantId: TENANT_A, subject: "user-a", scopes: ["Squad.MemoryWrite"] });
    const { handler } = buildHarness({ verifier, memoryStore: store });
    const sessionId = await initializeSession(handler, "w");

    const res = await callTool(handler, {
      token: "w",
      sessionId,
      name: "squad_memory_sync",
      args: { project: "proj", items: "not-an-array" },
    });
    assert.equal(res.status, 200);
    const code = (res.body as { error?: { code: number } } | undefined)?.error?.code;
    assert.equal(code, -32602, "a non-array items rejects the batch with an invalid-params error");
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// SEC-3 — the store key derives from auth.tenantId, never caller input.
// ---------------------------------------------------------------------------

test("SEC-3: a sync under one tenant is invisible to another (key = auth.tenantId)", async () => {
  const { store, cleanup } = tempStore();
  try {
    const verifier = new FakeJwtVerifier();
    verifier.register({ token: "a", tenantId: TENANT_A, subject: "user-a", scopes: ["Squad.MemoryWrite", "Squad.Memory"] });
    verifier.register({ token: "b", tenantId: TENANT_B, subject: "user-b", scopes: ["Squad.MemoryWrite", "Squad.Memory"] });
    const { handler } = buildHarness({ verifier, memoryStore: store });

    const sessionA = await initializeSession(handler, "a");
    const flushed = await callTool(handler, {
      token: "a",
      sessionId: sessionA,
      name: "squad_memory_sync",
      args: { project: "shared", items: [{ path: "state", content: "tenant-a-secret" }] },
    });
    assert.equal(syncResultsOf(flushed)[0]?.ok, true, "tenant A's write commits");

    // Tenant B reads the SAME project/path and must NOT see tenant A's content.
    const sessionB = await initializeSession(handler, "b");
    const readB = await callTool(handler, {
      token: "b",
      sessionId: sessionB,
      name: "squad_memory_read",
      args: { project: "shared", path: "state" },
    });
    const code = (readB.body as { error?: { code: number } } | undefined)?.error?.code;
    assert.equal(code, -32602, "tenant B sees no entry (partition isolated by auth.tenantId)");

    // And the store itself confirms the entry lives ONLY under tenant A.
    assert.equal((await store.read(TENANT_A, "shared", "state"))?.content, "tenant-a-secret");
    assert.equal(await store.read(TENANT_B, "shared", "state"), undefined);
  } finally {
    cleanup();
  }
});
