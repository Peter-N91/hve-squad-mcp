/**
 * Security hardening (Phase 1b.4 re-gate conditions), engine level.
 *
 *   * MEDIUM-1 — concurrent squad_status polls of an approved run must not
 *     double-execute the pipeline (in-flight guard).
 *   * MEDIUM-2 — held runs are capped per tenant so they cannot accumulate
 *     unboundedly (resource-exhaustion guard).
 *   * HIGH-1 (audit) — an approval records an auditable approver + timestamp.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { loadCatalog, type CatalogTool } from "../src/catalog/catalog.js";
import { EmbeddedCoordinator } from "../src/engine/embedded.js";
import { EphemeralWorkspaceManager } from "../src/engine/workspace.js";
import {
  InMemoryApprovalChannel,
  TenantQuotaTracker,
  type ApprovalAuditLogger,
} from "../src/engine/gates.js";
import type { AuthContext } from "../src/auth/entra.js";
import type { BackendRequest, BackendResult, ModelBackend } from "../src/engine/model-backend.js";

class FakeBackend implements ModelBackend {
  readonly id = "fake-backend";
  calls = 0;
  async complete(_request: BackendRequest): Promise<BackendResult> {
    this.calls += 1;
    return { text: `STAGE-${this.calls}`, finishReason: "stop", backendId: this.id, usage: { estimatedCostUsd: 0.01 } };
  }
}

const AUTH: AuthContext = { tenantId: "tenant-a", subject: "a", scopes: [], audience: "api://test" };

function squadRun(): CatalogTool {
  const t = loadCatalog().tools.find((c) => c.id === "squad_run");
  assert.ok(t);
  return t;
}

/**
 * Drive ONE approved squad_run to completion on an isolated engine+backend via a
 * single poll and return the number of backend dispatches — the advisory
 * pipeline's deterministic per-run cost for {@link request}. Used to anchor the
 * concurrent-poll assertion to a real single run rather than a hard-coded count.
 */
async function measureSinglePollRunCalls(request: string): Promise<number> {
  const backend = new FakeBackend();
  const approvals = new InMemoryApprovalChannel();
  const engine = new EmbeddedCoordinator({
    backend,
    workspaceManager: new EphemeralWorkspaceManager(),
    quota: new TenantQuotaTracker({ concurrency: 4, monthlyCeilingUsd: 500 }),
    approvals,
  });
  const started = await engine.startHttpRun(squadRun(), { toolId: "squad_run", request }, { auth: AUTH });
  const runId = started.runId!;
  await approvals.approve(runId, "operator");
  const res = await engine.pollRun(runId, { auth: AUTH });
  assert.equal(res.outcome, "completed", "the isolated pre-measure poll drove the run to completion");
  return backend.calls;
}

test("MEDIUM-1: concurrent polls of an approved run execute the pipeline only once", async () => {
  // Dynamic single-run pre-measure over an ISOLATED engine+backend: one poll drives
  // the SAME request to completion, capturing the advisory pipeline's per-run cost.
  // This anchors the concurrent assertion to one real run instead of a hard-coded
  // stage count (squad_run now runs the multi-stage advisory pipeline, not the fixed
  // two-stage spike loop).
  const singleRunCalls = await measureSinglePollRunCalls("x");
  assert.ok(singleRunCalls >= 2, "the advisory pipeline dispatches at least two stages per run");

  const backend = new FakeBackend();
  const approvals = new InMemoryApprovalChannel();
  const engine = new EmbeddedCoordinator({
    backend,
    workspaceManager: new EphemeralWorkspaceManager(),
    quota: new TenantQuotaTracker({ concurrency: 4, monthlyCeilingUsd: 500 }),
    approvals,
  });

  const started = await engine.startHttpRun(squadRun(), { toolId: "squad_run", request: "x" }, { auth: AUTH });
  const runId = started.runId!;
  await approvals.approve(runId, "operator");

  const [a, b] = await Promise.all([
    engine.pollRun(runId, { auth: AUTH }),
    engine.pollRun(runId, { auth: AUTH }),
  ]);

  const outcomes = [a.outcome, b.outcome].sort();
  assert.deepEqual(outcomes, ["completed", "held"], "exactly one poll drives the run; the other is deferred");
  // Exactly one run's worth of stages ran — the in-flight guard prevented a second
  // concurrent drive. Anchored to the pre-measured single-run cost and guarded to
  // stay strictly below two runs' cost so a future double-exec regression (2x) fails.
  assert.equal(backend.calls, singleRunCalls, "the advisory pipeline ran once (not twice)");
  assert.ok(backend.calls < 2 * singleRunCalls, "no double-execution: strictly below two runs' cost");
});

test("MEDIUM-2: held runs are capped per tenant", async () => {
  const backend = new FakeBackend();
  const engine = new EmbeddedCoordinator({
    backend,
    workspaceManager: new EphemeralWorkspaceManager(),
    quota: new TenantQuotaTracker({ concurrency: 4, monthlyCeilingUsd: 500 }),
    maxHeldRunsPerTenant: 2,
  });

  const first = await engine.startHttpRun(squadRun(), { toolId: "squad_run", request: "1" }, { auth: AUTH });
  const second = await engine.startHttpRun(squadRun(), { toolId: "squad_run", request: "2" }, { auth: AUTH });
  const third = await engine.startHttpRun(squadRun(), { toolId: "squad_run", request: "3" }, { auth: AUTH });

  assert.equal(first.outcome, "held");
  assert.equal(second.outcome, "held");
  assert.equal(third.outcome, "denied");
  assert.equal(third.reason, "held_run_cap");
  assert.equal(backend.calls, 0, "held runs make no model call");
});

test("MEDIUM-2: completing a held run frees a slot under the cap", async () => {
  const backend = new FakeBackend();
  const approvals = new InMemoryApprovalChannel();
  const engine = new EmbeddedCoordinator({
    backend,
    workspaceManager: new EphemeralWorkspaceManager(),
    quota: new TenantQuotaTracker({ concurrency: 4, monthlyCeilingUsd: 500 }),
    approvals,
    maxHeldRunsPerTenant: 1,
  });

  const first = await engine.startHttpRun(squadRun(), { toolId: "squad_run", request: "1" }, { auth: AUTH });
  // At the cap: a second held run is denied.
  assert.equal((await engine.startHttpRun(squadRun(), { toolId: "squad_run", request: "2" }, { auth: AUTH })).outcome, "denied");
  // Complete the first, then a new held run is admitted again.
  await approvals.approve(first.runId!, "operator");
  await engine.pollRun(first.runId!, { auth: AUTH });
  assert.equal((await engine.startHttpRun(squadRun(), { toolId: "squad_run", request: "3" }, { auth: AUTH })).outcome, "held");
});

test("HIGH-1 (audit): an approval records an auditable approver + timestamp", async () => {
  const lines: { message: string; fields?: Record<string, unknown> }[] = [];
  const audit: ApprovalAuditLogger = { info: (message, fields) => lines.push({ message, fields }) };
  const approvals = new InMemoryApprovalChannel(audit);

  await approvals.approve("run-123", "operator@example.com");

  const record = await approvals.approvalRecord("run-123");
  assert.ok(record);
  assert.equal(record.approver, "operator@example.com");
  assert.equal(typeof record.at, "number");
  assert.equal(lines.length, 1, "an audit line was emitted");
  assert.equal(lines[0].fields?.runId, "run-123");
  assert.equal(lines[0].fields?.approver, "operator@example.com");
});
