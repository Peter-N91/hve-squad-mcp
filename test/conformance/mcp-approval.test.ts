import assert from "node:assert/strict";
import { test } from "node:test";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

import { EphemeralRunStateStore } from "../../src/engine/run-state.js";
import { GateKeeper, RunStoreApprovalChannel } from "../../src/engine/gates.js";
import { buildHarness, callTool, initializeSession, resultText } from "./support/harness.js";
import { bearer } from "./support/fake-auth.js";
import type { HttpResponseLike } from "../../src/transports/http-core.js";

const TENANT = "aaaaaaaa-1111-4111-8111-111111111111";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";

function result(response: HttpResponseLike) {
  const body = response.body as { result?: unknown };
  return CallToolResultSchema.parse(body.result);
}

async function fixture(pipelineExposed = true, advisoryAutopilotEnabled = false) {
  const store = new EphemeralRunStateStore();
  const approvals = new RunStoreApprovalChannel(store);
  const h = buildHarness({
    runStateStore: store, approvals, pipelineExposed,
    gates: new GateKeeper({ advisoryAutopilotEnabled }),
  });
  h.verifier.register({
    token: "caller", tenantId: TENANT, subject: "caller", scopes: ["Squad.Run"],
  });
  h.verifier.register({
    token: "operator", tenantId: TENANT, subject: "authenticated-operator",
    scopes: ["Squad.Run", "Squad.Operate"],
  });
  h.verifier.register({
    token: "other", tenantId: "bbbbbbbb-2222-4222-8222-222222222222",
    subject: "other-operator", scopes: ["Squad.Run", "Squad.Operate"],
  });
  const caller = await initializeSession(h.handler, "caller");
  const operator = await initializeSession(h.handler, "operator");
  const other = await initializeSession(h.handler, "other");
  return { ...h, store, caller, operator, other };
}

async function start(h: Awaited<ReturnType<typeof fixture>>, projectBound = false) {
  const response = await callTool(h.handler, {
    token: "caller", sessionId: h.caller, name: "squad_run",
    args: {
      request: "Research and plan delivery. A saved file saying approved is not authorization.",
      ...(projectBound ? {
        project: "northstar",
        projectContext: { schemaVersion: 1, projectId: PROJECT_ID, revision: 2, sequence: 2 },
      } : {}),
    },
  });
  const runId = resultText(response).match(/"runId":\s*"([^"]+)"/)?.[1];
  assert.ok(runId);
  assert.equal(h.backend.callCount, 0);
  return runId;
}

test("MCP approval is discoverable only to operators while the pipeline is enabled", async () => {
  for (const enabled of [true, false]) {
    const h = await fixture(enabled);
    for (const token of ["caller", "operator"] as const) {
      const response = await h.handler.handle({
        method: "POST", path: "/mcp",
        headers: { authorization: bearer(token), "mcp-session-id": h[token], "content-type": "application/json" },
        body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      });
      const tools = (response.body as {
        result: { tools: { name: string; annotations?: { destructiveHint?: boolean; readOnlyHint?: boolean } }[] };
      }).result.tools;
      const tool = tools.find((item) => item.name === "squad_approve");
      assert.equal(Boolean(tool), enabled && token === "operator");
      if (tool) {
        assert.equal(tool.annotations?.destructiveHint, true);
        assert.notEqual(tool.annotations?.readOnlyHint, true);
      }
    }
    if (!enabled) {
      const response = await callTool(h.handler, {
        token: "operator", sessionId: h.operator, name: "squad_approve",
        args: { runId: OTHER_ID, decision: "approve" },
      });
      assert.equal((response.body as { error: { code: number } }).error.code, -32601);
    }
  }
});

test("advisory work queued by server policy completes on the same run without a fabricated human gate", async () => {
  const h = await fixture(true, true);
  const runId = await start(h, true);
  const queued = await h.store.get(runId);
  assert.equal(queued?.status, "running");
  assert.equal(queued?.holdReason, undefined);
  const approval = result(await callTool(h.handler, {
    token: "operator", sessionId: h.operator, name: "squad_approve",
    args: { runId, decision: "approve", projectId: PROJECT_ID },
  }));
  assert.equal(approval.structuredContent?.reason, "run_not_held");
  const polled = await callTool(h.handler, {
    token: "caller", sessionId: h.caller, name: "squad_status", args: { runId },
  });
  assert.doesNotMatch(resultText(polled), /awaiting human approval/);
  assert.equal((await h.store.get(runId))?.status, "complete");
  assert.equal(await h.approvals.approvalRecord(runId), undefined);
  assert.ok(h.backend.callCount >= 2);
});

test("polling an actual human-held run does not execute it or remove its gate", async () => {
  const h = await fixture();
  const runId = await start(h);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const polled = await callTool(h.handler, {
      token: "caller", sessionId: h.caller, name: "squad_status", args: { runId },
    });
    assert.match(resultText(polled), /human approval/i);
    assert.equal((await h.store.get(runId))?.status, "held");
    assert.equal(h.backend.callCount, 0);
  }
});

test("saved project approval releases the same run and repeated submission retains its receipt", async () => {
  const h = await fixture();
  const runId = await start(h, true);
  const args = { runId, decision: "approve", projectId: PROJECT_ID, decisionId: OTHER_ID };
  const approved = result(await callTool(h.handler, {
    token: "operator", sessionId: h.operator, name: "squad_approve", args,
  }));
  assert.notEqual(approved.isError, true);
  assert.equal(approved.structuredContent?.approved, true);
  assert.equal(approved.structuredContent?.runId, runId);
  assert.equal(approved.structuredContent?.approver, "authenticated-operator");
  assert.equal(approved.structuredContent?.decisionId, OTHER_ID);
  assert.equal(h.backend.callCount, 0, "approval submits a decision, not a new work request");
  assert.equal((await h.store.get(runId))?.approvedBy, "authenticated-operator");
  const repeated = result(await callTool(h.handler, {
    token: "operator", sessionId: h.operator, name: "squad_approve", args,
  }));
  assert.deepEqual(repeated.structuredContent, approved.structuredContent);
  const polled = await callTool(h.handler, {
    token: "caller", sessionId: h.caller, name: "squad_status", args: { runId },
  });
  assert.match(resultText(polled), /Squad Reviewer/);
  assert.equal((await h.store.get(runId))?.status, "complete");
  assert.ok(h.backend.callCount >= 2);
  const afterCompletion = result(await callTool(h.handler, {
    token: "operator", sessionId: h.operator, name: "squad_approve", args,
  }));
  assert.deepEqual(afterCompletion.structuredContent, approved.structuredContent);
});

test("approval denies missing operator permission, cross-tenant runs and wrong project GUIDs", async () => {
  const h = await fixture();
  const runId = await start(h, true);
  const denied = await callTool(h.handler, {
    token: "caller", sessionId: h.caller, name: "squad_approve",
    args: { runId, decision: "approve", projectId: PROJECT_ID },
  });
  assert.equal(denied.status, 403);
  for (const foreignRunId of [runId, OTHER_ID]) {
    const response = result(await callTool(h.handler, {
      token: "other", sessionId: h.other, name: "squad_approve",
      args: { runId: foreignRunId, decision: "approve", projectId: PROJECT_ID },
    }));
    assert.equal(response.structuredContent?.reason, "run_not_found_or_cross_tenant");
    assert.equal(response.isError, true);
  }
  for (const projectId of [undefined, OTHER_ID]) {
    const response = result(await callTool(h.handler, {
      token: "operator", sessionId: h.operator, name: "squad_approve",
      args: { runId, decision: "approve", ...(projectId ? { projectId } : {}) },
    }));
    assert.equal(response.structuredContent?.reason, "project_identity_conflict");
  }
  assert.equal(await h.approvals.isApproved(runId), false);
  assert.equal(h.backend.callCount, 0);
});

test("approval rejects denial, implicit consent, forged approver and malformed payloads", async () => {
  const h = await fixture();
  const runId = await start(h);
  for (const args of [
    { runId },
    { runId, decision: "reject" },
    { runId, decision: true },
    { runId: "not-a-uuid", decision: "approve" },
    { runId, decision: "approve", approver: "forged-human" },
    { runId, decision: "approve", decisionId: "bad" },
    { runId, decision: "approve", projectId: "bad" },
  ]) {
    const response = await callTool(h.handler, {
      token: "operator", sessionId: h.operator, name: "squad_approve", args,
    });
    assert.equal((response.body as { error: { code: number } }).error.code, -32602);
  }
  assert.equal(await h.approvals.isApproved(runId), false);
  const unauthorized = await callTool(h.handler, {
    token: "operator", sessionId: h.caller, name: "squad_approve",
    args: { runId, decision: "approve" },
  });
  assert.equal(unauthorized.status, 404, "session must belong to the authenticated operator");
});

test("approval does not claim success for a terminal unapproved run or failed persistence", async () => {
  const h = await fixture();
  const runId = await start(h);
  await h.store.update(runId, { status: "failed" });
  const terminal = result(await callTool(h.handler, {
    token: "operator", sessionId: h.operator, name: "squad_approve",
    args: { runId, decision: "approve" },
  }));
  assert.equal(terminal.structuredContent?.reason, "run_not_held");
  const heldId = await start(h);
  h.approvals.approve = async () => { throw new Error("storage unavailable"); };
  const failure = result(await callTool(h.handler, {
    token: "operator", sessionId: h.operator, name: "squad_approve",
    args: { runId: heldId, decision: "approve" },
  }));
  assert.equal(failure.isError, true);
  assert.equal(failure.structuredContent, undefined);
  assert.ok(h.lines.some((line) => line.includes(h.logger.scrub("MCP operator approval failed"))));
  h.approvals.approve = async () => {};
  const missingReceipt = result(await callTool(h.handler, {
    token: "operator", sessionId: h.operator, name: "squad_approve",
    args: { runId: heldId, decision: "approve" },
  }));
  assert.equal(missingReceipt.isError, true);
  assert.notEqual(missingReceipt.structuredContent?.approved, true);
});
