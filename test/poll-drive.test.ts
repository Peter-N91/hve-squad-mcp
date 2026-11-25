/**
 * Poll-driven execution without a worker. A status poll that claims a run waits a
 * bounded time, then answers `run_already_in_flight` while the run continues in
 * the same process, so no request outlives the 240s ingress ceiling.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { loadCatalog, type CatalogTool } from "../src/catalog/catalog.js";
import { EmbeddedCoordinator } from "../src/engine/embedded.js";
import { EphemeralWorkspaceManager } from "../src/engine/workspace.js";
import { GateKeeper, RunStoreApprovalChannel, TenantQuotaTracker } from "../src/engine/gates.js";
import { EphemeralRunStateStore } from "../src/engine/run-state.js";
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
  const tool = loadCatalog().tools.find((candidate) => candidate.id === "squad_run");
  assert.ok(tool);
  return tool;
}

function makeStack(options: { pollDriveWaitMs?: number; leaseMs?: number } = {}) {
  const store = new EphemeralRunStateStore();
  const approvals = new RunStoreApprovalChannel(store);
  const backend = new FakeBackend();
  const engine = new EmbeddedCoordinator({
    backend,
    stageExecutorFactory: () => scriptedStageExecutor(backend),
    workspaceManager: new EphemeralWorkspaceManager(),
    quota: new TenantQuotaTracker({ concurrency: 4, monthlyCeilingUsd: 500 }),
    runStateStore: store,
    approvals,
    gates: new GateKeeper(),
    driveOnPoll: true,
    ...options,
  });
  return { store, approvals, backend, engine };
}

async function startApproved(stack: ReturnType<typeof makeStack>): Promise<string> {
  const started = await stack.engine.startHttpRun(squadRun(), { toolId: "squad_run", request: "research delivery" }, { auth: AUTH });
  assert.ok(started.runId);
  await stack.approvals.approve(started.runId, "operator");
  return started.runId;
}

test("a slow run answers in flight within the poll budget and completes in the background", async () => {
  const stack = makeStack({ pollDriveWaitMs: 20, leaseMs: 1 });
  const runId = await startApproved(stack);
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let entries = 0;
  const complete = stack.backend.complete.bind(stack.backend);
  stack.backend.complete = async (request) => {
    entries += 1;
    await released;
    return complete(request);
  };

  const first = await stack.engine.pollRun(runId, { auth: AUTH });
  assert.equal(first.outcome, "held");
  assert.equal(first.reason, "run_already_in_flight");

  // The 1ms lease has lapsed, but this process is still driving: no second drive.
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await stack.engine.pollRun(runId, { auth: AUTH });
  assert.equal(second.reason, "run_already_in_flight");
  assert.equal(entries, 1);

  release();
  let final = second;
  for (let attempt = 0; attempt < 200 && final.outcome !== "completed"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    final = await stack.engine.pollRun(runId, { auth: AUTH });
  }
  assert.equal(final.outcome, "completed");
  assert.equal((await stack.store.get(runId))?.status, "complete");
});

test("a run that finishes within the poll budget returns its result on the same poll", async () => {
  // Returns as soon as the run finishes; the budget only bounds a loaded test machine.
  const stack = makeStack({ pollDriveWaitMs: 120_000 });
  const runId = await startApproved(stack);
  const result = await stack.engine.pollRun(runId, { auth: AUTH });
  assert.equal(result.outcome, "completed");
  assert.ok(result.artifact);
});

test("without a poll budget the poll still drives the run synchronously", async () => {
  const stack = makeStack();
  const runId = await startApproved(stack);
  const result = await stack.engine.pollRun(runId, { auth: AUTH });
  assert.equal(result.outcome, "completed");
});
