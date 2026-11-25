/**
 * Background run worker (WI-1b4-WORKER). Proves the worker drives approved runs
 * off the poll path, that the CAS prevents double-execution, that an unapproved
 * held run is never picked up, and that a crashed (stale-lease) run is recovered.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { loadCatalog, type CatalogTool } from "../src/catalog/catalog.js";
import { EmbeddedCoordinator } from "../src/engine/embedded.js";
import { EphemeralWorkspaceManager } from "../src/engine/workspace.js";
import { GateKeeper, RunStoreApprovalChannel, TenantQuotaTracker } from "../src/engine/gates.js";
import { EphemeralRunStateStore } from "../src/engine/run-state.js";
import { RunWorker, WORKER_EXECUTION_OPTIONS } from "../src/engine/run-worker.js";
import type { AuthContext } from "../src/auth/entra.js";
import type { BackendRequest, BackendResult, ModelBackend } from "../src/engine/model-backend.js";
import { scriptedStageExecutor } from "./helpers/scripted-stage-executor.js";

class FakeBackend implements ModelBackend {
  readonly id = "fake-backend";
  calls = 0;
  async complete(_request: BackendRequest): Promise<BackendResult> {
    this.calls += 1;
    return { text: `STAGE-${this.calls}`, finishReason: "stop", backendId: this.id, usage: { estimatedCostUsd: 0.01 } };
  }
}

const AUTH: AuthContext = { tenantId: "tenant-a", subject: "caller", scopes: [], audience: "api://test" };

function squadRun(): CatalogTool {
  const t = loadCatalog().tools.find((c) => c.id === "squad_run");
  assert.ok(t);
  return t;
}

function makeStack(store = new EphemeralRunStateStore(), advisoryAutopilotEnabled = false) {
  const approvals = new RunStoreApprovalChannel(store);
  const backend = new FakeBackend();
  const quota = new TenantQuotaTracker({ concurrency: 4, monthlyCeilingUsd: 500 });
  const stageDeadlines: (number | undefined)[] = [];
  const engine = new EmbeddedCoordinator({
    ...WORKER_EXECUTION_OPTIONS,
    backend,
    stageExecutorFactory: (_workspace, _project, _runId, options) => {
      stageDeadlines.push(options?.deadlineMs);
      return scriptedStageExecutor(backend);
    },
    workspaceManager: new EphemeralWorkspaceManager(),
    quota,
    runStateStore: store,
    approvals,
    gates: new GateKeeper({ advisoryAutopilotEnabled }),
    driveOnPoll: false, // worker deployment: the poll is read-only.
  });
  return { store, approvals, backend, engine, quota, stageDeadlines };
}

test("worker budget reaches stages and lease prevents reclaim during long execution", async () => {
  const { store, approvals, backend, engine, stageDeadlines } = makeStack();
  const started = await engine.startHttpRun(squadRun(), { toolId: "squad_run", request: "research delivery" }, { auth: AUTH });
  assert.ok(started.runId);
  await approvals.approve(started.runId, "operator");
  let markEntered!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  const complete = backend.complete.bind(backend);
  backend.complete = async (request) => {
    markEntered();
    await released;
    return complete(request);
  };
  const tick = new RunWorker({ coordinator: engine, batchSize: 1 }).tickOnce();
  try {
    await entered;
    const run = await store.get(started.runId);
    assert.ok(run?.leaseExpiresAt);
    assert.ok(run.leaseExpiresAt > Date.now() + 35 * 60 * 1000);
    assert.equal((await engine.listClaimableRuns(Date.now() + 11 * 60 * 1000)).length, 0);
    assert.equal((await engine.pollRun(started.runId, { auth: AUTH })).reason, "run_already_in_flight");
    assert.ok(WORKER_EXECUTION_OPTIONS.leaseMs > WORKER_EXECUTION_OPTIONS.stageDeadlineMs);
  } finally {
    release();
    await tick;
  }
  assert.ok(stageDeadlines.length > 0);
  assert.ok(stageDeadlines.every((deadline) => deadline === 30 * 60 * 1000));
});

test("in worker mode the poll is read-only; the worker drives the approved run", async () => {
  const { store, approvals, backend, engine, quota } = makeStack();

  const started = await engine.startHttpRun(squadRun(), { toolId: "squad_run", request: "improve caching" }, { auth: AUTH });
  const runId = started.runId!;
  await approvals.approve(runId, "operator");

  // The poll does NOT execute (worker mode): it reports the run queued, no model call.
  const polled = await engine.pollRun(runId, { auth: AUTH });
  assert.equal(polled.outcome, "held");
  assert.equal(polled.reason, "queued_for_worker");
  assert.equal(backend.calls, 0, "the poll never drives execution in worker mode");

  // The worker drains the approved run to completion.
  const worker = new RunWorker({ coordinator: engine });
  const tick = await worker.tickOnce();
  assert.equal(tick.driven, 1);
  assert.ok(backend.calls >= 2, "the worker drove the multi-stage advisory pipeline");

  const done = await engine.pollRun(runId, { auth: AUTH });
  assert.equal(done.outcome, "completed");
  assert.match(done.artifact ?? "", /## Squad Reviewer/);
  assert.equal(done.usage?.completionCount, backend.calls);
  assert.equal(done.usage?.attemptCount, backend.calls);
  assert.ok(Math.abs((done.usage?.estimatedCostUsd ?? 0) - backend.calls * 0.01) < 1e-9);
  assert.ok(Math.abs(quota.spentUsd(AUTH.tenantId) - backend.calls * 0.01) < 1e-9,
    "Per-completion persistence must not charge the tenant twice.");
  const persisted = await store.get(runId);
  assert.equal(persisted?.completionUsage?.length, backend.calls);
  assert.ok(persisted?.completionUsage?.every((record) =>
    record.runId === runId && record.stage && record.actor && record.outcome === "completed"));
});

test("worker-mode polling distinguishes server-admitted advisory work from a human hold", async () => {
  const { store, approvals, backend, engine } = makeStack(undefined, true);
  const started = await engine.startHttpRun(squadRun(), { toolId: "squad_run", request: "research delivery" }, { auth: AUTH });
  assert.ok(started.runId);
  assert.equal(started.reason, "queued");
  const polled = await engine.pollRun(started.runId, { auth: AUTH });
  assert.equal(polled.reason, "queued_for_worker");
  assert.equal(polled.approvalRequest, undefined);
  assert.equal(backend.calls, 0);
  assert.equal((await new RunWorker({ coordinator: engine }).tickOnce()).driven, 1);
  assert.equal((await store.get(started.runId))?.status, "complete");
  assert.equal(await approvals.approvalRecord(started.runId), undefined);
});

test("the worker ignores an unapproved held run (gate still non-bypassable)", async () => {
  const { backend, engine } = makeStack();
  const started = await engine.startHttpRun(squadRun(), { toolId: "squad_run", request: "x" }, { auth: AUTH });
  const runId = started.runId!;

  const worker = new RunWorker({ coordinator: engine });
  const tick = await worker.tickOnce();
  assert.equal(tick.driven, 0, "an unapproved held run is not claimable");
  assert.equal(backend.calls, 0);
  const stillHeld = await engine.pollRun(runId, { auth: AUTH });
  assert.equal(stillHeld.outcome, "held");
});

test("two workers on the same store drive an approved run exactly once (CAS)", async () => {
  // Dynamic single-run pre-measure: drive the SAME request through ONE worker over
  // an ISOLATED store+backend to capture the advisory pipeline's per-run cost, so
  // the concurrent assertion below is anchored to one real run rather than a
  // hard-coded stage count (the count changed when squad_run moved from the fixed
  // two-stage spike loop to the multi-stage advisory pipeline).
  const pre = makeStack();
  const preStarted = await pre.engine.startHttpRun(squadRun(), { toolId: "squad_run", request: "x" }, { auth: AUTH });
  const preRunId = preStarted.runId!;
  await pre.approvals.approve(preRunId, "operator");
  const preTick = await new RunWorker({ coordinator: pre.engine }).tickOnce();
  assert.equal(preTick.driven, 1, "the isolated pre-measure drove the run exactly once");
  const preDone = await pre.engine.pollRun(preRunId, { auth: AUTH });
  assert.equal(preDone.outcome, "completed", "the isolated pre-measure ran to completion");
  const singleRunCalls = pre.backend.calls;
  assert.ok(singleRunCalls >= 2, "the advisory pipeline dispatches at least two stages per run");

  const { store, approvals, backend, engine } = makeStack();
  const started = await engine.startHttpRun(squadRun(), { toolId: "squad_run", request: "x" }, { auth: AUTH });
  const runId = started.runId!;
  await approvals.approve(runId, "operator");

  // A second worker over a second coordinator sharing the SAME store + approvals.
  const engine2 = new EmbeddedCoordinator({
    backend, // share the counter to observe total dispatches across both workers
    workspaceManager: new EphemeralWorkspaceManager(),
    quota: new TenantQuotaTracker({ concurrency: 4, monthlyCeilingUsd: 500 }),
    runStateStore: store,
    approvals,
    driveOnPoll: false,
  });
  const w1 = new RunWorker({ coordinator: engine });
  const w2 = new RunWorker({ coordinator: engine2 });

  const [t1, t2] = await Promise.all([w1.tickOnce(), w2.tickOnce()]);
  assert.equal(t1.driven + t2.driven, 1, "exactly one worker drove the run");
  // The shared backend saw EXACTLY one run's worth of stages — the CAS prevented a
  // second concurrent drive. Anchored to the pre-measured single-run cost and
  // guarded to stay strictly below two runs' cost so a future double-exec regression
  // (2x) still fails here rather than silently passing.
  assert.equal(backend.calls, singleRunCalls, "the advisory pipeline ran exactly once (not twice)");
  assert.ok(backend.calls < 2 * singleRunCalls, "no double-execution: strictly below two runs' cost");
});

test("the worker recovers a crashed run (running with an expired lease)", async () => {
  const { store, backend, engine } = makeStack();
  // Simulate a run that a crashed worker left `running` with an expired lease, and
  // whose request was persisted (a non-gated queued run, or a mid-flight recovery).
  const run = await store.create({ tenantId: "tenant-a", toolId: "squad_run" });
  await store.update(run.runId, { status: "running", request: "recover me", leaseExpiresAt: Date.now() - 1 });

  const worker = new RunWorker({ coordinator: engine });
  const tick = await worker.tickOnce();
  assert.equal(tick.driven, 1, "the stale-lease run was reclaimed and driven");
  assert.ok(backend.calls >= 2);
  const done = await engine.pollRun(run.runId, { auth: AUTH });
  assert.equal(done.outcome, "completed");
});

test("a tick sweeps expired runs", async () => {
  const { store, engine } = makeStack();
  const expired = await store.create({ tenantId: "tenant-a", toolId: "squad_run", ttlMs: -1 });
  const worker = new RunWorker({ coordinator: engine });
  const tick = await worker.tickOnce();
  assert.ok(tick.swept >= 1, "the expired run was swept");
  assert.equal(await store.get(expired.runId), undefined);
});
