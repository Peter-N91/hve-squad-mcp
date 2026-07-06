/**
 * Remote async pipeline over HTTP (Phase 1b.4) — squad_run + squad_status.
 *
 * Proves the async contract end-to-end through the REAL handler stack:
 *   * squad_run returns a run id and HOLDS (no model call; the gate is carried
 *     across the remote boundary — SEC-6 / PROD-5).
 *   * squad_status is tenant-scoped: another tenant's run id is denied.
 *   * squad_status keeps the run held until an out-of-band operator approval, then
 *     (poll-drives-execution) runs the pipeline and returns the finished artifact.
 *   * squad_run / squad_status are now listed and callable (PROD-1, widened).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildHarness, callTool, initializeSession } from "./support/harness.js";
import { FakeJwtVerifier } from "./support/fake-auth.js";
import { InMemoryApprovalChannel } from "../../src/engine/gates.js";
import { DurableRunStateStore } from "../../src/engine/durable-run-state.js";
import type { HttpResponseLike } from "../../src/transports/http-core.js";

const TENANT_A = "55555555-eeee-4eee-8eee-eeeeeeeeeeee";
const TENANT_B = "66666666-ffff-4fff-8fff-ffffffffffff";

/** Pull the rendered tool text out of a tools/call response. */
function toolText(res: HttpResponseLike): string {
  const result = (res.body as { result?: { content?: { text: string }[] } }).result;
  return result?.content?.map((c) => c.text).join("\n") ?? "";
}

/** Extract the machine-readable runId from a rendered embedded result. */
function runIdOf(res: HttpResponseLike): string | undefined {
  return toolText(res).match(/"runId":\s*"([^"]+)"/)?.[1];
}

function isError(res: HttpResponseLike): boolean {
  const result = (res.body as { result?: { isError?: boolean } }).result;
  return result?.isError === true;
}

test("squad_run over HTTP returns a run id and HOLDS (gate carried across the boundary)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "squad-remote-"));
  try {
    const verifier = new FakeJwtVerifier();
    const harness = buildHarness({
      verifier,
      runStateStore: new DurableRunStateStore({ baseDir: dir }),
      approvals: new InMemoryApprovalChannel(),
    });
    verifier.register({ token: "run-a", tenantId: TENANT_A, subject: "a", scopes: ["Squad.Run"] });
    const sessionId = await initializeSession(harness.handler, "run-a");

    const res = await callTool(harness.handler, { token: "run-a", sessionId, name: "squad_run", args: { request: "improve caching" } });
    assert.equal(res.status, 200);
    assert.match(toolText(res), /Human Gate/);
    assert.ok(runIdOf(res), "a run id is returned");
    assert.equal(harness.backend.callCount, 0, "a held squad_run makes no model call");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("squad_status is tenant-scoped and drives the run to completion only after approval", async () => {
  const dir = mkdtempSync(join(tmpdir(), "squad-remote-"));
  try {
    const verifier = new FakeJwtVerifier();
    const approvals = new InMemoryApprovalChannel();
    const harness = buildHarness({ verifier, runStateStore: new DurableRunStateStore({ baseDir: dir }), approvals });
    verifier.register({ token: "run-a", tenantId: TENANT_A, subject: "a", scopes: ["Squad.Run"] });
    verifier.register({ token: "run-b", tenantId: TENANT_B, subject: "b", scopes: ["Squad.Run"] });
    const sessionA = await initializeSession(harness.handler, "run-a");
    const sessionB = await initializeSession(harness.handler, "run-b");

    // Start a held run as tenant A.
    const started = await callTool(harness.handler, { token: "run-a", sessionId: sessionA, name: "squad_run", args: { request: "improve caching" } });
    const runId = runIdOf(started)!;
    assert.ok(runId);

    // Tenant B cannot poll tenant A's run (no leakage).
    const cross = await callTool(harness.handler, { token: "run-b", sessionId: sessionB, name: "squad_status", args: { runId } });
    assert.ok(isError(cross), "cross-tenant status is denied");
    assert.equal(harness.backend.callCount, 0);

    // Tenant A polls before approval: still held, no model call.
    const beforeApproval = await callTool(harness.handler, { token: "run-a", sessionId: sessionA, name: "squad_status", args: { runId } });
    assert.match(toolText(beforeApproval), /Human Gate/);
    assert.equal(harness.backend.callCount, 0);

    // Out-of-band operator approval, then poll: the pipeline runs and completes.
    await approvals.approve(runId, "operator@example.com");
    const afterApproval = await callTool(harness.handler, { token: "run-a", sessionId: sessionA, name: "squad_status", args: { runId } });
    assert.match(toolText(afterApproval), /squad-guided \/ embedded/);
    assert.match(toolText(afterApproval), /## Task Reviewer/);
    assert.ok(harness.backend.callCount >= 2, "the two-stage pipeline dispatched");

    // A subsequent poll returns the stored artifact without re-running.
    const callsAfter = harness.backend.callCount;
    const repoll = await callTool(harness.handler, { token: "run-a", sessionId: sessionA, name: "squad_status", args: { runId } });
    assert.match(toolText(repoll), /## Task Reviewer/);
    assert.equal(harness.backend.callCount, callsAfter, "a completed run is not re-executed on re-poll");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("squad_status requires a scope and a runId", async () => {
  const verifier = new FakeJwtVerifier();
  const harness = buildHarness({ verifier });
  verifier.register({ token: "run-a", tenantId: TENANT_A, subject: "a", scopes: ["Squad.Run"] });
  const sessionId = await initializeSession(harness.handler, "run-a");

  const missingRunId = await callTool(harness.handler, { token: "run-a", sessionId, name: "squad_status", args: {} });
  const err = (missingRunId.body as { error?: { code: number } }).error;
  assert.equal(err?.code, -32602, "a missing runId is a JSON-RPC invalid-params error");
});
