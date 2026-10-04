import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

import { EphemeralRunStateStore } from "../../src/engine/run-state.js";
import { FileSquadMemoryStore } from "../../src/engine/backends/file-squad-memory.js";
import { ProjectContextBridge } from "../../src/engine/project-context-bridge.js";
import type { SquadMemoryStore } from "../../src/engine/squad-memory-state.js";
import { buildHarness, callTool, initializeSession } from "./support/harness.js";
import { bearer } from "./support/fake-auth.js";
import type { HttpResponseLike } from "../../src/transports/http-core.js";

const TENANT = "aaaaaaaa-1111-4111-8111-111111111111";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const QUESTION_ID = "33333333-3333-4333-8333-333333333333";
const CONTEXT = { schemaVersion: 1 as const, projectId: PROJECT_ID, revision: 2, sequence: 2 };

function result(response: HttpResponseLike) {
  return CallToolResultSchema.parse((response.body as { result?: unknown }).result);
}

async function fixture(pipelineExposed = true, memoryStore?: SquadMemoryStore) {
  const store = new EphemeralRunStateStore();
  const h = buildHarness({ runStateStore: store, pipelineExposed, memoryStore });
  for (const [token, tenantId, scopes] of [
    ["caller", TENANT, ["Squad.Run"]],
    ["operator", TENANT, ["Squad.Operate"]],
    ["foreign", "bbbbbbbb-2222-4222-8222-222222222222", ["Squad.Run"]],
  ] as const) {
    h.verifier.register({ token, tenantId, subject: `${token}-subject`, scopes: [...scopes] });
  }
  const sessions = {
    caller: await initializeSession(h.handler, "caller"),
    operator: await initializeSession(h.handler, "operator"),
    foreign: await initializeSession(h.handler, "foreign"),
  };
  const run = await store.create({
    tenantId: TENANT, toolId: "squad_run",
  });
  await store.update(run.runId, {
    status: "held",
    holdReason: "awaiting human input", request: "Continue this existing run.",
    params: JSON.stringify({ project: "northstar", projectContext: CONTEXT }),
  });
  const respond = (args: unknown, token: keyof typeof sessions = "caller") => callTool(h.handler, {
    token, sessionId: sessions[token], name: "squad_respond", args: args as Record<string, unknown>,
  });
  return { ...h, store, sessions, runId: run.runId, respond };
}

test("squad_respond is pipeline-only, Run-authorized, mutating and separate from operator approval", async () => {
  for (const enabled of [true, false]) {
    const h = await fixture(enabled);
    for (const token of ["caller", "operator"] as const) {
      const listed = await h.handler.handle({
        method: "POST", path: "/mcp",
        headers: { authorization: bearer(token), "mcp-session-id": h.sessions[token], "content-type": "application/json" },
        body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      });
      const tools = (listed.body as { result: { tools: { name: string; annotations: { readOnlyHint?: boolean; destructiveHint?: boolean }; inputSchema: { required: string[] } }[] } }).result.tools;
      const tool = tools.find((entry) => entry.name === "squad_respond");
      assert.equal(Boolean(tool), enabled && token === "caller");
      if (tool) {
        assert.notEqual(tool.annotations.readOnlyHint, true);
        assert.equal(tool.annotations.destructiveHint, true);
        assert.deepEqual(tool.inputSchema.required, ["runId", "questionId", "answer"]);
      }
    }
    const denied = await h.respond({ runId: h.runId, questionId: QUESTION_ID, answer: "Weekly" }, "operator");
    if (enabled) assert.equal(denied.status, 403, "Operate alone cannot answer a question");
    else assert.equal((denied.body as { error: { code: number } }).error.code, -32601);
    const approval = await callTool(h.handler, {
      token: "caller", sessionId: h.sessions.caller, name: "squad_approve",
      args: { runId: h.runId, decision: "approve", projectId: PROJECT_ID },
    });
    assert.equal(enabled ? approval.status : (approval.body as { error: { code: number } }).error.code, enabled ? 403 : -32601);
    assert.equal(h.backend.callCount, 0);
  }
});

test("human response rejects invalid inputs before coordinator mutation", async (t) => {
  const h = await fixture();
  const mutation = t.mock.method(h.embedded, "respondToHumanInput", async () => { throw new Error("must not mutate"); });
  const base = { runId: h.runId, questionId: QUESTION_ID, answer: "Weekly" };
  for (const args of [
    null, [], {}, { ...base, runId: "not-uuid" }, { ...base, questionId: "not-uuid" },
    { ...base, answer: "" }, { ...base, answer: " \n\t" }, { ...base, answer: 1 },
    { ...base, answer: "a".repeat(16001) }, { ...base, respondedBy: "forged" },
    { ...base, project: "other" }, { ...base, decision: "approve" },
  ]) {
    const response = await h.respond(args);
    assert.equal((response.body as { error: { code: number } }).error.code, -32602);
  }
  const malformedContext = result(await h.respond({ ...base, projectContext: { projectId: PROJECT_ID } }));
  assert.equal(malformedContext.isError, true);
  assert.equal(mutation.mock.callCount(), 0);
  assert.equal(h.backend.callCount, 0);
});

test("accepted HTTP answers have persisted receipts and replay only for the same answer and principal", async () => {
  const h = await fixture();
  await h.store.update(h.runId, {
    humanInput: { questionId: QUESTION_ID, question: "Weekly or live?", purpose: "clarification" },
    advisoryCheckpoint: "private-checkpoint-not-read-by-response-handler",
  });
  const args = { runId: h.runId, questionId: QUESTION_ID, answer: "Weekly" };
  const first = result(await h.respond(args));
  assert.equal(first.structuredContent?.accepted, true);
  const saved = await h.store.get(h.runId);
  assert.equal(saved?.humanInput?.response?.answer, "Weekly");
  assert.equal(saved?.humanInput?.response?.respondedBy, "caller-subject");
  assert.equal(saved?.humanInput?.response?.respondedAt, first.structuredContent?.respondedAt);
  assert.equal(saved?.status, "running");
  assert.equal(saved?.approvedBy, undefined);
  const repeated = result(await h.respond(args));
  assert.deepEqual(repeated.structuredContent, first.structuredContent);
  const changed = result(await h.respond({ ...args, answer: "Live" }));
  assert.equal(changed.structuredContent?.accepted, false);
  const mismatch = result(await h.respond({ ...args, questionId: OTHER_ID }));
  assert.equal(mismatch.structuredContent?.reason, "human_question_not_current");
  h.verifier.register({ token: "second-human", tenantId: TENANT, subject: "second-subject", scopes: ["Squad.Run"] });
  const secondSession = await initializeSession(h.handler, "second-human");
  const otherPrincipal = result(await callTool(h.handler, {
    token: "second-human", sessionId: secondSession, name: "squad_respond", args,
  }));
  assert.equal(otherPrincipal.structuredContent?.accepted, false);
  assert.doesNotMatch(JSON.stringify(first), /private-checkpoint|Weekly/);
  assert.equal(h.backend.callCount, 0);
});

test("unbound runs accept the maximum answer length but cannot acquire a caller-supplied project", async () => {
  const h = await fixture();
  await h.store.update(h.runId, {
    params: "{}",
    humanInput: { questionId: QUESTION_ID, question: "Confirm?", purpose: "confirmation" },
    advisoryCheckpoint: "private-checkpoint",
  });
  const args = { runId: h.runId, questionId: QUESTION_ID, answer: "a".repeat(16000) };
  const wrongBinding = result(await h.respond({ ...args, projectContext: CONTEXT }));
  assert.equal(wrongBinding.isError, true);
  assert.equal((await h.store.get(h.runId))?.humanInput?.response, undefined);
  const accepted = result(await h.respond(args));
  assert.equal(accepted.structuredContent?.accepted, true);
  assert.equal(accepted.structuredContent?.contextBridge, undefined);
  assert.equal((await h.store.get(h.runId))?.humanInput?.response?.answer.length, 16000);
  assert.equal(h.backend.callCount, 0);
});

test("run tenant and project binding are reconciled before response mutation", async (t) => {
  const h = await fixture();
  const mutation = t.mock.method(h.embedded, "respondToHumanInput", async () => { throw new Error("must not mutate"); });
  const base = { runId: h.runId, questionId: QUESTION_ID, answer: "Weekly" };
  for (const runId of [h.runId, randomUUID()]) {
    const denied = result(await h.respond({ ...base, runId }, "foreign"));
    assert.equal(denied.structuredContent?.reason, "run_not_found_or_cross_tenant");
  }
  const mismatch = result(await h.respond({ ...base, projectContext: { ...CONTEXT, projectId: OTHER_ID } }));
  assert.equal((mismatch.structuredContent?.contextBridge as { reason: string }).reason, "project_identity_conflict");
  assert.equal(mutation.mock.callCount(), 0);
  assert.equal(h.backend.callCount, 0);
});

test("response forwards only server-owned actor and bound project, returning the verified receipt and bridge", async (t) => {
  const h = await fixture();
  const answer = "private answer: weekly refresh";
  const receipt = { accepted: true, runId: h.runId, questionId: QUESTION_ID, respondedBy: "caller-subject", respondedAt: 1789745000000 };
  const mutation = t.mock.method(h.embedded, "respondToHumanInput", async (...[runId, questionId, suppliedAnswer, ctx, binding]: Parameters<typeof h.embedded.respondToHumanInput>) => {
    assert.equal(runId, h.runId);
    assert.equal(questionId, QUESTION_ID);
    assert.equal(suppliedAnswer, answer);
    assert.equal(ctx.auth.subject, "caller-subject");
    assert.equal(ctx.auth.tenantId, TENANT);
    assert.deepEqual(binding, { projectId: PROJECT_ID });
    return receipt;
  });
  const args = { runId: h.runId, questionId: QUESTION_ID, answer };
  const first = result(await h.respond(args));
  const repeated = result(await h.respond(args));
  assert.equal(first.structuredContent?.accepted, true);
  assert.equal(first.structuredContent?.respondedAt, receipt.respondedAt);
  assert.deepEqual(repeated.structuredContent, first.structuredContent);
  assert.equal((first.structuredContent?.contextBridge as { projectId: string }).projectId, PROJECT_ID);
  assert.equal(mutation.mock.callCount(), 2);
  assert.equal(h.backend.callCount, 0);
  assert.doesNotMatch(JSON.stringify(first) + h.lines.join("\n"), /private answer/);
});

test("project bridge rejects stale context before a human answer is persisted", async (t) => {
  const root = await mkdtemp(join(process.cwd(), ".test-human-response-"));
  try {
    const memory = new FileSquadMemoryStore({ baseDir: root });
    await new ProjectContextBridge(memory).negotiate(TENANT, "northstar", CONTEXT);
    const h = await fixture(true, memory);
    const mutation = t.mock.method(h.embedded, "respondToHumanInput", async () => { throw new Error("must not mutate"); });
    const rejected = result(await h.respond({
      runId: h.runId, questionId: QUESTION_ID, answer: "Weekly",
      projectContext: { ...CONTEXT, revision: 1, sequence: 1 },
    }));
    assert.equal(rejected.isError, true);
    assert.equal((rejected.structuredContent?.contextBridge as { status: string }).status, "rejected");
    assert.equal(mutation.mock.callCount(), 0);
    assert.equal(h.backend.callCount, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing handoffs and mismatched questions remain rejected, never implicit approval", async (t) => {
  const h = await fixture();
  const missing = result(await h.respond({ runId: h.runId, questionId: QUESTION_ID, answer: "approve" }));
  assert.equal(missing.structuredContent?.accepted, false);
  assert.equal(missing.structuredContent?.reason, "human_question_not_current");
  t.mock.method(h.embedded, "respondToHumanInput", async (runId: string, questionId: string) => ({
    accepted: false, runId, questionId, reason: "human_question_not_current",
  }));
  const mismatch = result(await h.respond({ runId: h.runId, questionId: OTHER_ID, answer: "Weekly" }));
  assert.equal(mismatch.isError, true);
  assert.equal(mismatch.structuredContent?.reason, "human_question_not_current");
  assert.equal((await h.store.get(h.runId))?.approvedBy, undefined);
  assert.equal(h.backend.callCount, 0);
});

test("HTTP never reports acceptance when persisted receipt read-back fails", async (t) => {
  const h = await fixture();
  await h.store.update(h.runId, {
    humanInput: { questionId: QUESTION_ID, question: "Weekly or live?", purpose: "clarification" },
    advisoryCheckpoint: "private-checkpoint",
  });
  const get = h.store.get.bind(h.store);
  t.mock.method(h.store, "get", async (runId: string) => {
    const run = await get(runId);
    return run?.humanInput?.response ? undefined : run;
  });
  const failed = result(await h.respond({ runId: h.runId, questionId: QUESTION_ID, answer: "Weekly" }));
  assert.equal(failed.isError, true);
  assert.notEqual(failed.structuredContent?.accepted, true);
  assert.equal(h.backend.callCount, 0);
});

test("unconfirmed receipts and answer-bearing exceptions fail closed without leaking answers", async (t) => {
  const h = await fixture();
  const answer = "private-answer-do-not-log";
  const mutation = t.mock.method(h.embedded, "respondToHumanInput", async () => ({
    accepted: true, runId: h.runId, questionId: QUESTION_ID,
  }));
  const args = { runId: h.runId, questionId: QUESTION_ID, answer };
  assert.equal(result(await h.respond(args)).isError, true);
  mutation.mock.mockImplementation(async () => { throw new Error(answer); });
  const failed = result(await h.respond(args));
  assert.equal(failed.isError, true);
  assert.doesNotMatch(JSON.stringify(failed) + h.lines.join("\n"), /private-answer-do-not-log/);
  assert.equal(h.backend.callCount, 0);
});

test("status preserves public human question and never serializes a private continuation checkpoint", async (t) => {
  const h = await fixture();
  const humanInput = { questionId: QUESTION_ID, question: "Weekly or live?", purpose: "clarification" as const, choices: ["Weekly", "Live"], notice: "Draft advice only." };
  t.mock.method(h.embedded, "pollRun", async () => ({
    kind: "embedded" as const, outcome: "held" as const, reason: "awaiting human input",
    runId: h.runId, matchedRouting: { roles: [], councils: [], skills: [] }, humanInput,
    checkpoint: "private-continuation-sentinel",
  }));
  const polled = result(await callTool(h.handler, {
    token: "caller", sessionId: h.sessions.caller, name: "squad_status", args: { runId: h.runId },
  }));
  assert.deepEqual(polled.structuredContent?.humanInput, humanInput);
  assert.equal(polled.structuredContent?.outcome, "held");
  assert.equal(polled.structuredContent?.reason, "awaiting human input");
  assert.doesNotMatch(JSON.stringify(polled), /private-continuation-sentinel|checkpoint/);
  assert.equal(h.backend.callCount, 0);
});
