import assert from "node:assert/strict";
import test from "node:test";
import {
  AzureOpenAIBackend,
  type AzureOpenAIBackendOptions,
  type AzureOpenAIChatProfile,
} from "../src/engine/backends/azure-openai.js";
import { ModelBackendError, type BackendRequest } from "../src/engine/model-backend.js";

const request: BackendRequest = {
  system: "system",
  messages: [{ role: "user", content: "hello" }],
  maxOutputTokens: 123,
  temperature: 0.7,
};
const tools = [{
  name: "read_file",
  description: "Read a file",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      mode: { enum: ["metadata", "content"] },
      options: { type: "object", additionalProperties: { type: "string" } },
      tags: { type: "array", items: { type: "string" } },
    },
    required: ["path"],
    additionalProperties: true,
  },
}];

function fixture(options: Partial<AzureOpenAIBackendOptions> = {}) {
  const bodies: Record<string, unknown>[] = [];
  let tokenCalls = 0;
  const backend = new AzureOpenAIBackend({
    endpoint: "https://example.openai.azure.com",
    deployment: "arbitrary-production-alias",
    apiVersion: "2024-10-21",
    defaultMaxOutputTokens: 456,
    maxRetries: 0,
    getAccessToken: async () => { tokenCalls++; return "token"; },
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify(options.api === "responses"
        ? { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }] }
        : { choices: [{ message: { content: "done" }, finish_reason: "stop" }] }));
    },
    ...options,
  });
  return { backend, bodies, tokenCalls: () => tokenCalls };
}

test("ordinary Chat preserves legacy budget and temperature regardless of deployment alias", async () => {
  for (const deployment of ["arbitrary-production-alias", "gpt-5.6-sol"]) {
    const f = fixture({ deployment });
    await f.backend.complete(request);
    assert.equal(f.bodies[0].max_tokens, 123);
    assert.equal(f.bodies[0].temperature, 0.7);
    assert.equal(Object.hasOwn(f.bodies[0], "max_completion_tokens"), false);
    assert.equal(Object.hasOwn(f.bodies[0], "reasoning_effort"), false);
  }
});

for (const chatProfile of ["reasoning", "reasoning-no-effort", "gpt-5.6"] as AzureOpenAIChatProfile[]) {
  test(`${chatProfile} Chat uses the reasoning token parameter and omits temperature`, async () => {
    const reasoningEffort = chatProfile === "reasoning-no-effort" ? undefined : "medium";
    const f = fixture({ chatProfile, reasoningEffort });
    await f.backend.complete(request);
    assert.equal(f.bodies[0].max_completion_tokens, 123);
    assert.equal(f.bodies[0].reasoning_effort, reasoningEffort);
    assert.equal(Object.hasOwn(f.bodies[0], "max_tokens"), false);
    assert.equal(Object.hasOwn(f.bodies[0], "temperature"), false);
  });
}

for (const reasoningEffort of [undefined, "medium", "high"] as const) {
  test(`GPT-5.6 Chat rejects reasoning/tools before token acquisition (${reasoningEffort ?? "default"})`, async () => {
    const f = fixture({ chatProfile: "gpt-5.6", reasoningEffort });
    await assert.rejects(f.backend.complete({ ...request, tools }), error => {
      assert.ok(error instanceof ModelBackendError);
      assert.equal(error.providerCode, "chat_reasoning_tools_requires_responses");
      assert.equal(error.providerAttempted, false);
      assert.match(error.message, /SQUAD_MCP_MODEL_API=responses/);
      return true;
    });
    assert.equal(f.tokenCalls(), 0);
    assert.equal(f.bodies.length, 0);
  });
}

test("GPT-5.6 Chat rejects a tools history too; explicitly configured none remains allowed", async () => {
  const blocked = fixture({ chatProfile: "gpt-5.6" });
  await assert.rejects(blocked.backend.complete({
    ...request, messages: [{ role: "tool", content: "result", toolCallId: "call-1" }],
  }), /requires SQUAD_MCP_MODEL_API=responses/);
  assert.equal(blocked.tokenCalls(), 0);
  const allowed = fixture({ chatProfile: "gpt-5.6", reasoningEffort: "none" });
  await allowed.backend.complete({ ...request, tools });
  assert.equal(allowed.bodies[0].reasoning_effort, "none");
  assert.equal(allowed.bodies[0].max_completion_tokens, 123);
  assert.equal(allowed.bodies.length, 1);
});

test("unsupported Chat effort configurations fail locally without silently dropping configured effort", async () => {
  for (const options of [
    { chatProfile: "standard", reasoningEffort: "medium" },
    { chatProfile: "reasoning-no-effort", reasoningEffort: "none" },
    { chatProfile: "gpt-5.6", reasoningEffort: "max" },
    { chatProfile: "gpt-5.6", reasoningEffort: "minimal" },
  ] as const) {
    const f = fixture(options);
    await assert.rejects(f.backend.complete(request), error => {
      assert.ok(error instanceof ModelBackendError);
      assert.equal(error.providerAttempted, false);
      assert.match(error.message, /SQUAD_MCP_MODEL_CHAT_PROFILE/);
      return true;
    });
    assert.equal(f.bodies.length, 0);
    assert.equal(f.tokenCalls(), 0);
  }
});

test("Responses reasoning and stateless tool settings are unchanged by Chat capabilities", async () => {
  const f = fixture({ api: "responses", chatProfile: "gpt-5.6", reasoningEffort: "max", verbosity: "medium" });
  await f.backend.complete({ ...request, tools });
  assert.equal(f.bodies[0].max_output_tokens, 123);
  assert.deepEqual(f.bodies[0].reasoning, { effort: "max" });
  assert.deepEqual(f.bodies[0].text, { verbosity: "medium" });
  assert.equal(f.bodies[0].store, false);
  assert.deepEqual(f.bodies[0].include, ["reasoning.encrypted_content"]);
  assert.equal(Object.hasOwn(f.bodies[0], "max_completion_tokens"), false);
  assert.equal(Object.hasOwn(f.bodies[0], "reasoning_effort"), false);
  assert.equal(f.bodies.length, 1);
});

for (const api of ["chat-completions", "responses"] as const) {
  test(`${api} explicitly uses non-strict function schemas without lossy conversion or mutation`, async () => {
    const original = JSON.stringify(tools);
    const f = fixture({ api });
    await f.backend.complete({ ...request, tools, toolChoice: "required" });
    const sent = (f.bodies[0].tools as Record<string, unknown>[])[0];
    const definition = api === "responses" ? sent : sent.function as Record<string, unknown>;
    assert.equal(definition.strict, false);
    assert.deepEqual(definition.parameters, tools[0].parameters);
    assert.equal(f.bodies[0].tool_choice, "required");
    assert.equal(JSON.stringify(tools), original);
  });
}
