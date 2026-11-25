import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { MemoryBackedArtifactStore } from "../src/engine/artifact-store.js";
import { FileSquadMemoryStore } from "../src/engine/backends/file-squad-memory.js";
import { loadProfileTables, resolveProfile } from "../src/engine/profiles.js";
import {
  HISTORY_READ_MAX_CHARS,
  SquadHistory,
} from "../src/engine/squad-history.js";
import { SquadLedger } from "../src/engine/squad-ledger.js";

const TENANT = "11111111-1111-1111-1111-111111111111";
const PROJECT = "default";
const TABLES = loadProfileTables();

function makeHistory(): {
  memory: FileSquadMemoryStore;
  store: MemoryBackedArtifactStore;
  ledger: SquadLedger;
  history: SquadHistory;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "squad-history-"));
  const memory = new FileSquadMemoryStore({ baseDir: dir });
  const store = new MemoryBackedArtifactStore(memory);
  return {
    memory,
    store,
    ledger: new SquadLedger(store),
    history: new SquadHistory(store),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

async function seedRun(fixture: ReturnType<typeof makeHistory>): Promise<void> {
  const { ledger } = fixture;
  await ledger.seed(TENANT, PROJECT, resolveProfile("product", TABLES), TABLES, {
    date: "2026-08-07",
  });
  await ledger.writeDeliverable(TENANT, PROJECT, "lead", "onboarding", "# Plan", TABLES, {
    date: "2026-08-07",
  });
  await ledger.writeDeliverable(TENANT, PROJECT, "researcher", "market", "# Research", TABLES, {
    date: "2026-08-07",
  });
  await ledger.writeDeliverable(TENANT, PROJECT, "analyst", "prd", "# PRD", TABLES, {
    date: "2026-08-07",
  });
  await ledger.appendAgentHistory(TENANT, PROJECT, "Squad Researcher", "### Turn 1");
  await ledger.appendDecision(TENANT, PROJECT, "## Council Verdict — Go");
}

test("an empty project yields no index block rather than an empty one", async () => {
  const fixture = makeHistory();
  try {
    assert.equal(await fixture.history.contextBlock(TENANT, PROJECT), undefined);
    const index = await fixture.history.index(TENANT, PROJECT);
    assert.equal(index.total, 0);
    assert.deepEqual(index.deliverables, []);
  } finally {
    fixture.cleanup();
  }
});

test("bridge registration and flat memory records are not advertised as artifacts", async () => {
  const fixture = makeHistory();
  try {
    for (const path of ["context/bridge", "state", "decisions", "history/squad_run-test",
      "docs-private/record", ".copilot-tracking-private/record"]) {
      await fixture.memory.write(TENANT, PROJECT, path, "Internal memory record");
    }
    assert.deepEqual(await fixture.store.list(TENANT, PROJECT), []);
    assert.deepEqual(await fixture.history.list(TENANT, PROJECT), []);
    assert.deepEqual(await fixture.history.list(TENANT, PROJECT, "context"), []);
    assert.equal((await fixture.history.index(TENANT, PROJECT)).total, 0);
    assert.equal(await fixture.history.contextBlock(TENANT, PROJECT), undefined);
    await assert.rejects(fixture.history.read(TENANT, PROJECT, "context/bridge"), /must sit under/);
    await seedRun(fixture);
    for (const path of ["docs/brd.md", "outputs/brd.md"]) {
      await fixture.store.put(TENANT, PROJECT, path, "# Business requirements");
    }
    const listed = await fixture.history.list(TENANT, PROJECT);
    assert.ok(listed.length > 2);
    for (const entry of listed) {
      assert.ok(await fixture.history.read(TENANT, PROJECT, entry.path), `${entry.path} must be readable`);
    }
    assert.doesNotMatch(await fixture.history.contextBlock(TENANT, PROJECT) ?? "", /context\/bridge|Internal memory/);
    assert.equal((await fixture.memory.read(TENANT, PROJECT, "context/bridge"))?.content,
      "Internal memory record", "Filtering must preserve internal registration data.");
  } finally {
    fixture.cleanup();
  }
});

test("the index reports the profile, the deliverable directories, and the agents", async () => {
  const fixture = makeHistory();
  try {
    await seedRun(fixture);
    const index = await fixture.history.index(TENANT, PROJECT);

    assert.equal(index.profile, "product");
    assert.equal(index.turn, 0);
    assert.deepEqual(
      index.deliverables.map((d) => d.directory),
      [".copilot-tracking/plans", ".copilot-tracking/research/2026-08-07"],
    );
    // analyst and lead share the plans root, so that directory holds both.
    assert.equal(
      index.deliverables.find((d) => d.directory === ".copilot-tracking/plans")?.count,
      2,
    );
    assert.deepEqual(index.agents, ["squad-researcher"]);
  } finally {
    fixture.cleanup();
  }
});

test("squad state is not reported as a deliverable", async () => {
  const fixture = makeHistory();
  try {
    await seedRun(fixture);
    const index = await fixture.history.index(TENANT, PROJECT);
    for (const entry of index.deliverables) {
      assert.ok(
        !entry.directory.startsWith(".copilot-tracking/squad"),
        `${entry.directory} is squad state, not a deliverable`,
      );
    }
  } finally {
    fixture.cleanup();
  }
});

test("the context block names the paths a follow-up run can open", async () => {
  const fixture = makeHistory();
  try {
    await seedRun(fixture);
    const block = await fixture.history.contextBlock(TENANT, PROJECT);
    assert.match(block ?? "", /Squad profile: product/);
    assert.match(block ?? "", /\.copilot-tracking\/plans\//);
    assert.match(block ?? "", /squad_history read/);
    assert.match(block ?? "", /Squad Researcher|squad-researcher/);
  } finally {
    fixture.cleanup();
  }
});

test("list browses a subtree and read opens one artifact", async () => {
  const fixture = makeHistory();
  try {
    await seedRun(fixture);
    const plans = await fixture.history.list(TENANT, PROJECT, ".copilot-tracking/plans");
    assert.deepEqual(
      plans.map((e) => e.path),
      [".copilot-tracking/plans/onboarding.md", ".copilot-tracking/plans/prd.md"],
    );

    const opened = await fixture.history.read(
      TENANT,
      PROJECT,
      ".copilot-tracking/plans/onboarding.md",
    );
    assert.equal(opened?.content, "# Plan");
    assert.equal(
      await fixture.history.read(TENANT, PROJECT, ".copilot-tracking/plans/absent.md"),
      undefined,
    );
  } finally {
    fixture.cleanup();
  }
});

test("a read is bounded so one artifact cannot blow the context window", async () => {
  const fixture = makeHistory();
  try {
    const huge = "y".repeat(HISTORY_READ_MAX_CHARS + 1_000);
    await fixture.store.put(TENANT, PROJECT, ".copilot-tracking/plans/big.md", huge);
    const opened = await fixture.history.read(
      TENANT,
      PROJECT,
      ".copilot-tracking/plans/big.md",
    );
    assert.ok((opened?.content.length ?? 0) <= HISTORY_READ_MAX_CHARS + 32);
    assert.match(opened?.content ?? "", /truncated/);
  } finally {
    fixture.cleanup();
  }
});

test("paged history reassembles exact UTF-8 content without splitting surrogate pairs", async () => {
  const fixture = makeHistory();
  try {
    const path = ".copilot-tracking/research/large.md";
    const content = "\uFEFF" + "x".repeat(HISTORY_READ_MAX_CHARS - 2) +
      "\u{1F680}\r\n" + "y".repeat(HISTORY_READ_MAX_CHARS) + "\n";
    await fixture.store.put(TENANT, PROJECT, path, content);
    const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
    let offset = 0;
    let assembled = "";
    let etag: string | undefined;
    for (;;) {
      const page = await fixture.history.readPage(TENANT, PROJECT, path, offset);
      assert.ok(page);
      assert.equal(page.offset, offset);
      assert.equal(page.endOffset, offset + page.content.length);
      assert.ok(page.content.length <= HISTORY_READ_MAX_CHARS);
      assert.equal(page.totalChars, content.length);
      assert.equal(page.totalBytes, Buffer.byteLength(content, "utf8"));
      assert.equal(page.sha256, hash(content));
      assert.equal(page.pageSha256, hash(page.content));
      if (etag !== undefined) assert.equal(page.etag, etag);
      etag = page.etag;
      assembled += page.content;
      if (page.nextOffset === null) break;
      assert.ok(page.nextOffset > offset);
      if (offset === 0) assert.equal(page.nextOffset, HISTORY_READ_MAX_CHARS - 1);
      offset = page.nextOffset;
    }
    assert.equal(assembled, content);
    assert.equal(hash(assembled), hash(content));
    const oldPage = await fixture.history.readPage(TENANT, PROJECT, path, 0);
    await fixture.store.put(TENANT, PROJECT, path, content + "changed");
    const newPage = await fixture.history.readPage(TENANT, PROJECT, path, 0);
    assert.notEqual(newPage?.etag, oldPage?.etag);
    assert.notEqual(newPage?.sha256, oldPage?.sha256);
    assert.equal(await fixture.history.readPage(
      "22222222-2222-2222-2222-222222222222", PROJECT, path, 0,
    ), undefined);
  } finally {
    fixture.cleanup();
  }
});

test("near-tail receipt identifies the whole source without claiming full content retrieval", async () => {
  const fixture = makeHistory();
  try {
    const path = ".copilot-tracking/plans/tail-receipt.md";
    const content = "α".repeat(HISTORY_READ_MAX_CHARS + 1) + "\u{1F680}\n";
    await fixture.store.put(TENANT, PROJECT, path, content);
    await assert.rejects(fixture.history.readPage(TENANT, PROJECT, path, content.length - 2), /offset/i);
    const tail = await fixture.history.readPage(TENANT, PROJECT, path, content.length - 1);
    assert.ok(tail);
    assert.equal(tail.content, "\n");
    assert.equal(tail.path, path);
    assert.equal(tail.totalChars, content.length);
    assert.equal(tail.totalBytes, Buffer.byteLength(content, "utf8"));
    assert.equal(tail.etag, (await fixture.store.get(TENANT, PROJECT, path))?.etag);
    assert.equal(tail.sha256, createHash("sha256").update(content, "utf8").digest("hex"));
    assert.equal(tail.pageSha256, createHash("sha256").update("\n", "utf8").digest("hex"));
    assert.notEqual(tail.sha256, tail.pageSha256);
    assert.equal(tail.nextOffset, null);
    assert.equal(tail.truncated, true);
    assert.equal(tail.endOffset, tail.totalChars);
    assert.notEqual(tail.content.length, tail.totalChars);
  } finally {
    fixture.cleanup();
  }
});

test("paged history rejects invalid offsets and preserves empty and small artifacts", async () => {
  const fixture = makeHistory();
  try {
    const path = ".copilot-tracking/plans/page.md";
    await fixture.store.put(TENANT, PROJECT, path, "a\u{1F680}b\r\n");
    for (const offset of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2, 6, 99]) {
      await assert.rejects(fixture.history.readPage(TENANT, PROJECT, path, offset), /offset/i);
    }
    const page = await fixture.history.readPage(TENANT, PROJECT, path, 0);
    assert.equal(page?.content, "a\u{1F680}b\r\n");
    assert.equal(page?.nextOffset, null);
    assert.equal(page?.truncated, false);
    await fixture.store.put(TENANT, PROJECT, path, "");
    const empty = await fixture.history.readPage(TENANT, PROJECT, path, 0);
    assert.equal(empty?.content, "");
    assert.equal(empty?.totalBytes, 0);
    assert.equal(empty?.nextOffset, null);
    await assert.rejects(fixture.history.readPage(TENANT, PROJECT, "context/bridge", 0), /must sit under/);
  } finally {
    fixture.cleanup();
  }
});

test("history never crosses a tenant boundary", async () => {
  const fixture = makeHistory();
  try {
    await seedRun(fixture);
    const other = "22222222-2222-2222-2222-222222222222";
    assert.deepEqual(await fixture.history.list(other, PROJECT), []);
    assert.equal(await fixture.history.contextBlock(other, PROJECT), undefined);
    assert.equal(
      await fixture.history.read(other, PROJECT, ".copilot-tracking/plans/onboarding.md"),
      undefined,
    );
  } finally {
    fixture.cleanup();
  }
});

test("a traversal path is rejected rather than served", async () => {
  const fixture = makeHistory();
  try {
    await assert.rejects(
      () => fixture.history.read(TENANT, PROJECT, "../../etc/passwd"),
      /Unsafe artifact path|must sit under/,
    );
  } finally {
    fixture.cleanup();
  }
});
