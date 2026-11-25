/**
 * Run-state CAS / TTL / lease semantics (WI-06). Runs against BOTH stores so the
 * cross-replica primitive has identical semantics in dev (file) and the ephemeral
 * default; the Azure Table store implements the same contract via ETag If-Match.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  EphemeralRunStateStore,
  isRunClaimable,
  type HumanInputState,
  type RunStateStore,
} from "../src/engine/run-state.js";
import { DurableRunStateStore } from "../src/engine/durable-run-state.js";
import { AesGcmFieldCipher } from "../src/engine/field-cipher.js";
import { randomBytes } from "node:crypto";

function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(process.cwd(), ".test-squad-cas-"));
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
  { role: "Squad Researcher", artifact: "## Squad Researcher\n\nresearch findings" },
  { role: "Squad Lead", agentName: "lead", artifact: "## Squad Lead\n\nthe plan" },
  { role: "Council Verdict", artifact: "## Council Verdict\n\n* Verdict: Go-With-Conditions" },
];
const SAMPLE_VERDICT = {
  class: "Go-With-Conditions" as const,
  conditions: ["(security) encrypt the export"],
  rendered: "## Council Verdict\n\n* Verdict: Go-With-Conditions",
};
const SAMPLE_HISTORY = [
  { stage: "Squad Researcher", at: "2026-07-06T00:00:00.000Z" },
  { stage: "Squad Lead", at: "2026-07-06T00:00:01.000Z" },
  { stage: "Council Verdict", at: "2026-07-06T00:00:02.000Z" },
];

const QUESTION: HumanInputState = {
  questionId: "question-secret-1",
  question: "Which sensitive scope is intended?",
  purpose: "clarification",
  choices: ["private-option-a", "private-option-b"],
  notice: "private human handoff notice",
};
const ANSWER = { answer: "private-option-a", respondedBy: "private-user-1", respondedAt: 12345 };

async function awaitingInput(store: RunStateStore): Promise<string> {
  const run = await store.create({ tenantId: "t", toolId: "squad_run" });
  await store.update(run.runId, {
    status: "held",
    holdReason: "awaiting-human-input",
    leaseExpiresAt: Date.now() + 60_000,
    humanInput: QUESTION,
    advisoryCheckpoint: "opaque-sensitive-checkpoint",
    stages: SAMPLE_STAGES,
    councilVerdict: SAMPLE_VERDICT,
    history: SAMPLE_HISTORY,
  });
  return run.runId;
}

test("human answer atomically queues the same run and preserves completed stages", async () => {
  await forEachStore(async (store) => {
    const runId = await awaitingInput(store);
    const before = await store.get(runId);
    const answered = await store.answerInput(runId, QUESTION.questionId, ANSWER);
    assert.ok(answered);
    assert.equal(answered.runId, runId);
    assert.equal(answered.createdAt, before?.createdAt);
    assert.equal(answered.status, "running");
    assert.equal(answered.holdReason, undefined);
    assert.equal(answered.leaseExpiresAt, undefined);
    assert.equal(answered.approvedBy, undefined, "human input does not fabricate operator approval");
    assert.deepEqual(answered.humanInput, { ...QUESTION, response: ANSWER });
    assert.equal(answered.advisoryCheckpoint, "opaque-sensitive-checkpoint");
    assert.deepEqual(answered.stages, SAMPLE_STAGES);
    assert.deepEqual(answered.councilVerdict, SAMPLE_VERDICT);
    assert.deepEqual(answered.history, SAMPLE_HISTORY);
    assert.deepEqual((await store.listClaimable()).map((run) => run.runId), [runId]);
    assert.ok(await store.claim(runId, ["running"], "running"));
    assert.equal(await store.claim(runId, ["running"], "running"), undefined);
  });
});

test("unanswered input blocks list and claim despite earlier operator approval", async () => {
  await forEachStore(async (store) => {
    const runId = await awaitingInput(store);
    for (const status of ["held", "running"] as const) {
      const run = await store.update(runId, {
        status, approvedBy: "earlier-operator", approvedAt: 99, leaseExpiresAt: 0,
      });
      assert.ok(run);
      assert.equal(isRunClaimable(run, Date.now()), false);
      assert.deepEqual(await store.listClaimable(), []);
      assert.equal(await store.claim(runId, ["held", "running"], "running"), undefined);
      assert.equal((await store.get(runId))?.humanInput?.response, undefined);
    }
    await store.update(runId, { status: "held" });
    const answered = await store.answerInput(runId, QUESTION.questionId, ANSWER);
    assert.equal(answered?.approvedBy, "earlier-operator");
    assert.ok(answered && isRunClaimable(answered, Date.now()));
  });
});

test("a deferred question stays held until a later collaborator answers within the original TTL", async (t) => {
  const startedAt = Date.now();
  const expiresAt = startedAt + 60_000;
  let now = startedAt;
  t.mock.method(Date, "now", () => now);
  await forEachStore(async (store) => {
    now = startedAt;
    const runId = await awaitingInput(store);
    await store.update(runId, {
      params: JSON.stringify({ initiatedBy: "original-initiator" }),
      approvedBy: "original-initiator",
      approvedAt: startedAt,
      expiresAt,
    });
    now += 30_000;
    const waiting = await store.get(runId);
    assert.equal(waiting?.status, "held");
    assert.equal(waiting?.humanInput?.response, undefined);
    assert.equal(waiting?.expiresAt, expiresAt);
    assert.deepEqual(await store.listClaimable(), []);
    assert.equal(await store.claim(runId, ["held", "running"], "running"), undefined);

    const collaborator = { answer: "private-option-b", respondedBy: "different-collaborator", respondedAt: now };
    const answered = await store.answerInput(runId, QUESTION.questionId, collaborator);
    assert.equal(answered?.status, "running");
    assert.deepEqual(answered?.humanInput?.response, collaborator);
    assert.equal(answered?.expiresAt, expiresAt, "deferral and answering do not silently extend retention");
    assert.equal(answered?.params, JSON.stringify({ initiatedBy: "original-initiator" }));
    assert.equal(answered?.approvedBy, "original-initiator");
    assert.equal(await store.answerInput(runId, QUESTION.questionId, {
      ...collaborator, respondedBy: "original-initiator",
    }), undefined, "only the accepted collaborator can make an idempotent retry");
    assert.deepEqual(
      (await store.answerInput(runId, QUESTION.questionId, { ...collaborator, respondedAt: now + 1 }))?.humanInput?.response,
      collaborator,
    );
    now = expiresAt;
    assert.equal(await store.answerInput(runId, QUESTION.questionId, collaborator), undefined);
    assert.equal(await store.get(runId), undefined, "the original finite TTL still expires the answered run");
  });
});

test("human answer rejects absent runs, wrong questions and missing checkpoints without transitions", async () => {
  await forEachStore(async (store) => {
    assert.equal(await store.answerInput("missing", QUESTION.questionId, ANSWER), undefined);
    const runId = await awaitingInput(store);
    assert.equal(await store.answerInput(runId, "wrong-question", ANSWER), undefined);
    for (const checkpoint of [undefined, "", " \n "]) {
      await store.update(runId, { advisoryCheckpoint: checkpoint });
      assert.equal(await store.answerInput(runId, QUESTION.questionId, ANSWER), undefined);
      assert.equal((await store.get(runId))?.status, "held");
      assert.equal((await store.get(runId))?.humanInput?.response, undefined);
    }
    await store.update(runId, { advisoryCheckpoint: "checkpoint", humanInput: undefined });
    assert.equal(await store.answerInput(runId, QUESTION.questionId, ANSWER), undefined);
  });
});

test("first human answer requires held status; complete, failed and running cannot be resumed", async () => {
  await forEachStore(async (store) => {
    const runId = await awaitingInput(store);
    for (const status of ["running", "complete", "failed"] as const) {
      await store.update(runId, { status });
      assert.equal(await store.answerInput(runId, QUESTION.questionId, ANSWER), undefined);
      assert.equal((await store.get(runId))?.status, status);
    }
  });
});

test("competing different human answers accept exactly one answer", async () => {
  await forEachStore(async (store) => {
    const runId = await awaitingInput(store);
    const results = await Promise.all([
      store.answerInput(runId, QUESTION.questionId, ANSWER),
      store.answerInput(runId, QUESTION.questionId, { ...ANSWER, answer: "different" }),
    ]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.deepEqual((await store.get(runId))?.humanInput?.response, results.find(Boolean)?.humanInput?.response);
  });
});

test("human answer replay retains original timestamp during running and after completion", async () => {
  await forEachStore(async (store) => {
    const runId = await awaitingInput(store);
    const responses = await Promise.all([
      store.answerInput(runId, QUESTION.questionId, ANSWER),
      store.answerInput(runId, QUESTION.questionId, { ...ANSWER, respondedAt: 99999 }),
    ]);
    assert.ok(responses.every(Boolean));
    assert.deepEqual(JSON.parse(JSON.stringify(responses[0])), JSON.parse(JSON.stringify(responses[1])));
    assert.equal(responses[0]?.updatedAt, responses[1]?.updatedAt);
    assert.deepEqual(responses[1]?.humanInput?.response, ANSWER);
    const complete = await store.update(runId, {
      status: "complete", artifact: "finished", advisoryCheckpoint: undefined,
    });
    assert.deepEqual(
      await store.answerInput(runId, QUESTION.questionId, { ...ANSWER, respondedAt: 54321 }), complete,
    );
    assert.equal(await store.answerInput(runId, QUESTION.questionId, { ...ANSWER, answer: "other" }), undefined);
    assert.equal(await store.answerInput(runId, QUESTION.questionId, { ...ANSWER, respondedBy: "other-user" }), undefined);
    assert.equal(await store.answerInput(runId, "other-question", ANSWER), undefined);
    assert.deepEqual(await store.get(runId), complete);
  });
});

test("an expired human handoff cannot be answered, claimed or replayed", async () => {
  await forEachStore(async (store) => {
    const runId = await awaitingInput(store);
    await store.update(runId, { expiresAt: Date.now() - 1 });
    assert.equal(await store.answerInput(runId, QUESTION.questionId, ANSWER), undefined);
    assert.equal(await store.claim(runId, ["held"], "running"), undefined);
    assert.deepEqual(await store.listClaimable(), []);
    const accepted = await awaitingInput(store);
    await store.answerInput(accepted, QUESTION.questionId, ANSWER);
    await store.update(accepted, { expiresAt: Date.now() - 1 });
    assert.equal(await store.answerInput(accepted, QUESTION.questionId, ANSWER), undefined);
  });
});

test("file human state and checkpoint stay encrypted across restart, answer and claim", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const key = randomBytes(32);
    const first = new DurableRunStateStore({ baseDir: dir, cipher: new AesGcmFieldCipher(key) });
    const runId = await awaitingInput(first);
    const assertSealed = () => {
      const raw = readFileSync(join(dir, `${runId}.json`), "utf8");
      for (const secret of [
        QUESTION.questionId, QUESTION.question, ...QUESTION.choices!, QUESTION.notice!,
        ANSWER.respondedBy, "opaque-sensitive-checkpoint",
      ]) {
        assert.ok(!raw.includes(secret), `at-rest bytes must not include ${secret}`);
      }
      assert.equal(typeof (JSON.parse(raw) as { humanInput: unknown }).humanInput, "string");
    };
    assertSealed();
    const second = new DurableRunStateStore({ baseDir: dir, cipher: new AesGcmFieldCipher(key) });
    assert.deepEqual((await second.get(runId))?.humanInput, QUESTION);
    assert.equal(await second.claim(runId, ["held"], "running"), undefined);
    assert.ok(await second.answerInput(runId, QUESTION.questionId, ANSWER));
    assertSealed();
    const sealedAnswer = readFileSync(join(dir, `${runId}.json`), "utf8");
    await first.answerInput(runId, QUESTION.questionId, { ...ANSWER, respondedAt: 99999 });
    assert.equal(readFileSync(join(dir, `${runId}.json`), "utf8"), sealedAnswer, "idempotent replay does not rewrite ciphertext");
    const restarted = new DurableRunStateStore({ baseDir: dir, cipher: new AesGcmFieldCipher(key) });
    assert.deepEqual((await restarted.get(runId))?.humanInput, { ...QUESTION, response: ANSWER });
    const claimed = await restarted.claim(runId, ["running"], "running");
    assert.ok(claimed);
    const replayed = await first.answerInput(runId, QUESTION.questionId, { ...ANSWER, respondedAt: 99999 });
    assert.equal(replayed?.leaseExpiresAt, claimed.leaseExpiresAt, "replay cannot clear an active worker lease");
    assert.deepEqual(replayed?.humanInput?.response, ANSWER);
    assert.deepEqual((await restarted.get(runId))?.stages, SAMPLE_STAGES);
    assertSealed();
  } finally {
    cleanup();
  }
});

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
      stages: [{ role: "Squad Researcher", artifact: "SECRET-STAGE-ARTIFACT-7" }],
      councilVerdict: {
        class: "Go-With-Conditions",
        conditions: ["SECRET-CONDITION-7"],
        rendered: "SECRET-RENDERED-7",
      },
      // History is metadata (role + timestamp), left in the clear for audit.
      history: [{ stage: "Squad Researcher", at: "2026-07-06T00:00:00.000Z" }],
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
    assert.equal(read?.history?.[0].stage, "Squad Researcher");
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
