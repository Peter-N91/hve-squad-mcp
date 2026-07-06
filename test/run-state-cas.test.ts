/**
 * Run-state CAS / TTL / lease semantics (WI-06). Runs against BOTH stores so the
 * cross-replica primitive has identical semantics in dev (file) and the ephemeral
 * default; the Azure Table store implements the same contract via ETag If-Match.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { EphemeralRunStateStore, type RunStateStore } from "../src/engine/run-state.js";
import { DurableRunStateStore } from "../src/engine/durable-run-state.js";
import { AesGcmFieldCipher } from "../src/engine/field-cipher.js";
import { randomBytes } from "node:crypto";

function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "squad-cas-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Run a body against a fresh ephemeral store and a fresh file store. */
async function forEachStore(body: (store: RunStateStore) => Promise<void>): Promise<void> {
  await body(new EphemeralRunStateStore());
  const { dir, cleanup } = tempDir();
  try {
    await body(new DurableRunStateStore({ baseDir: dir }));
  } finally {
    cleanup();
  }
}

test("claim is a compare-and-swap: exactly one of two racing claims wins", async () => {
  await forEachStore(async (store) => {
    const run = await store.create({ tenantId: "t", toolId: "squad_run" });
    await store.update(run.runId, { status: "held", approvedBy: "op", approvedAt: Date.now() });
    const now = Date.now();
    const first = await store.claim(run.runId, ["held", "running"], "running", { now, leaseMs: 60_000 });
    const second = await store.claim(run.runId, ["held", "running"], "running", { now, leaseMs: 60_000 });
    assert.ok(first, "the first claim wins");
    assert.equal(second, undefined, "the second claim loses (a live lease blocks it)");
  });
});

test("a running run is reclaimable once its lease lapses (crash recovery)", async () => {
  await forEachStore(async (store) => {
    const run = await store.create({ tenantId: "t", toolId: "squad_run" });
    await store.update(run.runId, { status: "held", approvedBy: "op", approvedAt: Date.now() });
    const t0 = 1_000_000;
    const claimed = await store.claim(run.runId, ["held", "running"], "running", { now: t0, leaseMs: 1000 });
    assert.ok(claimed);
    // Before the lease lapses: not reclaimable.
    assert.equal(await store.claim(run.runId, ["running"], "running", { now: t0 + 500, leaseMs: 1000 }), undefined);
    // After the lease lapses: reclaimable.
    const reclaimed = await store.claim(run.runId, ["running"], "running", { now: t0 + 2000, leaseMs: 1000 });
    assert.ok(reclaimed, "an expired lease allows a re-claim");
  });
});

test("claim fails when the current status is not in the expected set", async () => {
  await forEachStore(async (store) => {
    const run = await store.create({ tenantId: "t", toolId: "squad_run" });
    await store.update(run.runId, { status: "complete" });
    assert.equal(await store.claim(run.runId, ["held"], "running", {}), undefined);
  });
});

test("listClaimable returns approved-held and lease-expired-running runs only", async () => {
  await forEachStore(async (store) => {
    const now = 5_000_000;
    // Approved held -> claimable.
    const approved = await store.create({ tenantId: "t", toolId: "squad_run" });
    await store.update(approved.runId, { status: "held", approvedBy: "op", approvedAt: now });
    // Held but NOT approved -> not claimable.
    const unapproved = await store.create({ tenantId: "t", toolId: "squad_run" });
    await store.update(unapproved.runId, { status: "held" });
    // Running with a live lease -> not claimable.
    const leased = await store.create({ tenantId: "t", toolId: "squad_run" });
    await store.update(leased.runId, { status: "running", leaseExpiresAt: now + 10_000 });
    // Running with an expired lease -> claimable.
    const stale = await store.create({ tenantId: "t", toolId: "squad_run" });
    await store.update(stale.runId, { status: "running", leaseExpiresAt: now - 1 });
    // Complete -> never claimable.
    const done = await store.create({ tenantId: "t", toolId: "squad_run" });
    await store.update(done.runId, { status: "complete" });

    const ids = (await store.listClaimable(now)).map((r) => r.runId).sort();
    assert.deepEqual(ids, [approved.runId, stale.runId].sort());
  });
});

test("TTL: an expired run reads as gone and is swept", async () => {
  await forEachStore(async (store) => {
    const run = await store.create({ tenantId: "t", toolId: "squad_run", ttlMs: -1 });
    // ttlMs -1 => already expired.
    assert.equal(await store.get(run.runId), undefined, "an expired run reads as gone");
    const fresh = await store.create({ tenantId: "t", toolId: "squad_run", ttlMs: 60_000 });
    const removed = await store.sweepExpired(Date.now());
    assert.ok(removed >= 0);
    assert.ok(await store.get(fresh.runId), "a non-expired run survives the sweep");
  });
});

test("cross-replica: a second store instance on the same dir sees a claim (durable)", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const a = new DurableRunStateStore({ baseDir: dir });
    const run = await a.create({ tenantId: "t", toolId: "squad_run" });
    await a.update(run.runId, { status: "held", approvedBy: "op", approvedAt: Date.now() });
    const now = Date.now();
    assert.ok(await a.claim(run.runId, ["held"], "running", { now, leaseMs: 60_000 }));
    // A fresh instance (a different replica) observes the claim: status running, lease live.
    const b = new DurableRunStateStore({ baseDir: dir });
    assert.equal(await b.claim(run.runId, ["held", "running"], "running", { now, leaseMs: 60_000 }), undefined);
  } finally {
    cleanup();
  }
});

test("encryption at rest: request/context are opaque on disk but decrypt on read", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const store = new DurableRunStateStore({ baseDir: dir, cipher: new AesGcmFieldCipher(randomBytes(32)) });
    const run = await store.create({ tenantId: "t", toolId: "squad_run" });
    await store.update(run.runId, { request: "SECRET-REQUEST-9", context: "SECRET-CONTEXT-9" });
    // Raw file bytes must NOT contain the plaintext.
    const file = readdirSync(dir).find((f) => f.startsWith(run.runId));
    const raw = readFileSync(join(dir, file as string), "utf8");
    assert.ok(!raw.includes("SECRET-REQUEST-9"), "request is encrypted at rest");
    assert.ok(!raw.includes("SECRET-CONTEXT-9"), "context is encrypted at rest");
    // But a read decrypts.
    const read = await store.get(run.runId);
    assert.equal(read?.request, "SECRET-REQUEST-9");
    assert.equal(read?.context, "SECRET-CONTEXT-9");
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Phase 4 — advisory composites (stages + council verdict + history) persist
// through the durable stores, encrypted at rest, backward-compatible, and
// visible cross-replica.
// ---------------------------------------------------------------------------

const SAMPLE_STAGES = [
  { role: "Task Researcher", artifact: "## Task Researcher\n\nresearch findings" },
  { role: "Task Planner", agentName: "lead", artifact: "## Task Planner\n\nthe plan" },
  { role: "Council Verdict", artifact: "## Council Verdict\n\n* Verdict: Go-With-Conditions" },
];
const SAMPLE_VERDICT = {
  class: "Go-With-Conditions" as const,
  conditions: ["(security) encrypt the export"],
  rendered: "## Council Verdict\n\n* Verdict: Go-With-Conditions",
};
const SAMPLE_HISTORY = [
  { stage: "Task Researcher", at: "2026-07-06T00:00:00.000Z" },
  { stage: "Task Planner", at: "2026-07-06T00:00:01.000Z" },
  { stage: "Council Verdict", at: "2026-07-06T00:00:02.000Z" },
];

test("advisory stages + verdict + history round-trip on both stores", async () => {
  await forEachStore(async (store) => {
    const run = await store.create({ tenantId: "t", toolId: "squad_run" });
    await store.update(run.runId, {
      stages: SAMPLE_STAGES,
      councilVerdict: SAMPLE_VERDICT,
      history: SAMPLE_HISTORY,
    });
    const read = await store.get(run.runId);
    assert.deepEqual(read?.stages, SAMPLE_STAGES);
    assert.deepEqual(read?.councilVerdict, SAMPLE_VERDICT);
    assert.deepEqual(read?.history, SAMPLE_HISTORY);
  });
});

test("a run without advisory fields still loads (backward-compatible optionals)", async () => {
  await forEachStore(async (store) => {
    const run = await store.create({ tenantId: "t", toolId: "squad_run" });
    await store.update(run.runId, { status: "complete", artifact: "legacy artifact" });
    const read = await store.get(run.runId);
    assert.equal(read?.artifact, "legacy artifact");
    assert.equal(read?.stages, undefined);
    assert.equal(read?.councilVerdict, undefined);
    assert.equal(read?.history, undefined);
  });
});

test("advisory stage artifacts + verdict text are encrypted at rest on the file store", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const store = new DurableRunStateStore({ baseDir: dir, cipher: new AesGcmFieldCipher(randomBytes(32)) });
    const run = await store.create({ tenantId: "t", toolId: "squad_run" });
    await store.update(run.runId, {
      stages: [{ role: "Task Researcher", artifact: "SECRET-STAGE-ARTIFACT-7" }],
      councilVerdict: {
        class: "Go-With-Conditions",
        conditions: ["SECRET-CONDITION-7"],
        rendered: "SECRET-RENDERED-7",
      },
      // History is metadata (role + timestamp), left in the clear for audit.
      history: [{ stage: "Task Researcher", at: "2026-07-06T00:00:00.000Z" }],
    });
    const file = readdirSync(dir).find((f) => f.startsWith(run.runId));
    const raw = readFileSync(join(dir, file as string), "utf8");
    assert.ok(!raw.includes("SECRET-STAGE-ARTIFACT-7"), "stage artifact is encrypted at rest");
    assert.ok(!raw.includes("SECRET-RENDERED-7"), "verdict rendered block is encrypted at rest");
    assert.ok(!raw.includes("SECRET-CONDITION-7"), "verdict conditions are encrypted at rest");
    // But a read decrypts everything back.
    const read = await store.get(run.runId);
    assert.equal(read?.stages?.[0].artifact, "SECRET-STAGE-ARTIFACT-7");
    assert.equal(read?.councilVerdict?.rendered, "SECRET-RENDERED-7");
    assert.deepEqual(read?.councilVerdict?.conditions, ["SECRET-CONDITION-7"]);
    assert.equal(read?.history?.[0].stage, "Task Researcher");
  } finally {
    cleanup();
  }
});

test("cross-replica: a verdict + stages written by one file-store instance are visible to a second", async () => {
  const { dir, cleanup } = tempDir();
  try {
    // Two replicas share the same dir AND the same data key.
    const key = Buffer.alloc(32, 7);
    const a = new DurableRunStateStore({ baseDir: dir, cipher: new AesGcmFieldCipher(key) });
    const run = await a.create({ tenantId: "t", toolId: "squad_run" });
    await a.update(run.runId, { stages: SAMPLE_STAGES, councilVerdict: SAMPLE_VERDICT });
    // A fresh instance (a different replica) observes the write.
    const b = new DurableRunStateStore({ baseDir: dir, cipher: new AesGcmFieldCipher(key) });
    const read = await b.get(run.runId);
    assert.deepEqual(read?.stages, SAMPLE_STAGES);
    assert.equal(read?.councilVerdict?.class, "Go-With-Conditions");
  } finally {
    cleanup();
  }
});
