import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AzureOpenAIBackend,
  modelPricingFromEnvironment,
  type AzureOpenAIApi,
} from "../src/engine/backends/azure-openai.js";
import {
  completeWithObserver,
  ModelBackendError,
  type BackendCompletionEvent,
  type BackendMessage,
  type BackendTool,
} from "../src/engine/model-backend.js";

const REQUEST = {
  system: "system",
  messages: [{ role: "user" as const, content: "hello" }],
};

test("Azure OpenAI reports safe transport codes without retrying or retaining provider text", async () => {
  for (const code of ["UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "ECONNRESET"]) {
    let calls = 0;
    const backend = new AzureOpenAIBackend({
      endpoint: "https://example.openai.azure.com",
      deployment: "model",
      apiVersion: "2024-10-21",
      getAccessToken: async () => "token",
      fetchImpl: async () => {
        calls += 1;
        throw new TypeError("secret request text", { cause: { code, message: "secret provider detail" } });
      },
    });
    await assert.rejects(backend.complete(REQUEST), (error: unknown) => {
      assert.ok(error instanceof ModelBackendError);
      assert.equal(error.kind, "upstream");
      assert.equal(error.providerCode, code);
      assert.doesNotMatch(String(error), /secret/);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("Azure OpenAI does not reclassify caller cancellation as a transport failure", async () => {
  const controller = new AbortController();
  const reason = new Error("caller deadline");
  const backend = new AzureOpenAIBackend({
    endpoint: "https://example.openai.azure.com",
    deployment: "model",
    apiVersion: "2024-10-21",
    getAccessToken: async () => "token",
    fetchImpl: async () => {
      controller.abort(reason);
      throw new TypeError("fetch failed", { cause: { code: "UND_ERR_HEADERS_TIMEOUT" } });
    },
  });
  await assert.rejects(backend.complete({ ...REQUEST, signal: controller.signal }), (error) => error === reason);
});

test("Azure OpenAI retries 429 using the service retry header", async () => {
  const delays: number[] = [];
  const events: BackendCompletionEvent[] = [];
  let calls = 0;
  const backend = new AzureOpenAIBackend({
    endpoint: "https://example.openai.azure.com",
    deployment: "model",
    apiVersion: "2024-10-21",
    getAccessToken: () => Promise.resolve("managed-identity-token"),
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(undefined, {
          status: 429,
          headers: { "x-ms-retry-after-ms": "25" },
        });
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "done" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
    sleep: (milliseconds) => {
      delays.push(milliseconds);
      return Promise.resolve();
    },
  });

  const result = await completeWithObserver(backend, REQUEST, (event) => { events.push(event); });
  assert.equal(result.text, "done");
  assert.equal(calls, 2);
  assert.deepEqual(delays, [25]);
  assert.deepEqual(events.map((event) => [event.attempt, event.outcome]), [
    [1, "failed"],
    [2, "completed"],
  ]);
  assert.equal(result.usage?.attemptCount, 2);
  assert.equal(result.usage?.completionCount, 1);
});

test("Azure OpenAI uses capped exponential fallback and stops at the retry bound", async () => {
  const delays: number[] = [];
  let calls = 0;
  const backend = new AzureOpenAIBackend({
    endpoint: "https://example.openai.azure.com",
    deployment: "model",
    apiVersion: "2024-10-21",
    getAccessToken: () => Promise.resolve("managed-identity-token"),
    fetchImpl: () => {
      calls += 1;
      return Promise.resolve(new Response(undefined, { status: 503 }));
    },
    maxRetries: 2,
    retryBaseMs: 10,
    retryMaxDelayMs: 15,
    sleep: (milliseconds) => {
      delays.push(milliseconds);
      return Promise.resolve();
    },
  });

  await assert.rejects(() => backend.complete(REQUEST), /status 503/);
  assert.equal(calls, 3);
  assert.deepEqual(delays, [10, 15]);
});

test("Azure OpenAI does not retry non-transient request errors", async () => {
  let calls = 0;
  const backend = new AzureOpenAIBackend({
    endpoint: "https://example.openai.azure.com",
    deployment: "model",
    apiVersion: "2024-10-21",
    getAccessToken: () => Promise.resolve("managed-identity-token"),
    fetchImpl: () => {
      calls += 1;
      return Promise.resolve(new Response(undefined, { status: 400 }));
    },
    sleep: () => {
      throw new Error("sleep must not be called");
    },
  });

  await assert.rejects(() => backend.complete(REQUEST), /status 400/);
  assert.equal(calls, 1);
});

test("Azure OpenAI classifies context-length failures without retaining provider messages", async () => {
  const sensitiveProviderMessage = "request contains secret-caller-context";
  const backend = new AzureOpenAIBackend({
    endpoint: "https://example.openai.azure.com",
    deployment: "model",
    apiVersion: "2024-10-21",
    getAccessToken: () => Promise.resolve("managed-identity-token"),
    fetchImpl: () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: {
              code: "context_length_exceeded",
              message: sensitiveProviderMessage,
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
      ),
  });

  await assert.rejects(
    () => backend.complete(REQUEST),
    (error: unknown) => {
      assert.ok(error instanceof ModelBackendError);
      assert.equal(error.kind, "input_too_large");
      assert.equal(error.status, 400);
      assert.equal(error.providerCode, "context_length_exceeded");
      assert.doesNotMatch(String(error), /secret-caller-context/);
      return true;
    },
  );
});

test("Azure OpenAI classifies content-policy failures by safe inner error code", async () => {
  const backend = new AzureOpenAIBackend({
    endpoint: "https://example.openai.azure.com",
    deployment: "model",
    apiVersion: "2024-10-21",
    getAccessToken: () => Promise.resolve("managed-identity-token"),
    fetchImpl: () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: {
              code: "content_filter",
              message: "provider-owned detail must not be surfaced",
              innererror: { code: "ResponsibleAIPolicyViolation" },
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
      ),
  });

  await assert.rejects(
    () => backend.complete(REQUEST),
    (error: unknown) => {
      assert.ok(error instanceof ModelBackendError);
      assert.equal(error.kind, "content_policy");
      assert.equal(error.providerCode, "ResponsibleAIPolicyViolation");
      assert.doesNotMatch(String(error), /provider-owned detail/);
      return true;
    },
  );
});

test("Azure OpenAI classifies ContentFiltered without retrying or exposing provider details", async () => {
  for (const api of ["chat-completions", "responses"] as const) {
    for (const codes of [
      { code: "ContentFiltered" },
      { code: "BadRequest", innererror: { code: "ContentFiltered" } },
      { code: "content_filter", innererror: { code: "ContentFiltered" } },
    ]) {
      let calls = 0;
      const backend = new AzureOpenAIBackend({
        endpoint: "https://example.openai.azure.com",
        deployment: "model",
        api,
        apiVersion: "2024-10-21",
        getAccessToken: async () => "token",
        fetchImpl: async () => {
          calls += 1;
          return new Response(JSON.stringify({
            error: { ...codes, message: "private provider prompt or filter details" },
          }), { status: 400, headers: { "content-type": "application/json" } });
        },
      });
      await assert.rejects(backend.complete(REQUEST), (error: unknown) => {
        assert.ok(error instanceof ModelBackendError);
        assert.equal(error.kind, "content_policy");
        assert.equal(error.status, 400);
        assert.equal(error.providerCode, "ContentFiltered");
        assert.doesNotMatch(String(error), /private provider/);
        return true;
      });
      assert.equal(calls, 1);
    }
  }
});

test("HTTP policy rejection exposes only allowlisted provider filter metadata", async () => {
  let calls = 0;
  const backend = new AzureOpenAIBackend({
    endpoint: "https://example.openai.azure.com", deployment: "model", apiVersion: "2024-10-21",
    getAccessToken: async () => "token",
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: {
        code: "content_filter", message: "private request text",
        innererror: { code: "ContentFiltered", content_filter_result: {
          violence: { filtered: true, severity: "medium", detail: "private details" },
          unknown: { filtered: true, severity: "high" },
        } },
      } }), { status: 400, headers: { "apim-request-id": "request_12345678" } });
    },
  });
  await assert.rejects(backend.complete(REQUEST), (error: unknown) => {
    assert.ok(error instanceof ModelBackendError);
    assert.equal(error.kind, "content_policy");
    assert.deepEqual(error.contentPolicy, {
      direction: "prompt",
      categories: [{ name: "violence", filtered: true, severity: "medium" }],
      providerRequestId: "request_12345678",
    });
    assert.doesNotMatch(JSON.stringify(error), /private|unknown/);
    return true;
  });
  assert.equal(calls, 1);
});

for (const [api, payload, direction] of [
  ["chat-completions", { choices: [{ finish_reason: "content_filter", message: {
    content: "private partial response", tool_calls: [{ arguments: "invalid partial tool" }],
  }, content_filter_results: { violence: { filtered: true, severity: "low" } } }] }, "completion"],
  ["responses", { status: "incomplete", incomplete_details: { reason: "content_filter" },
    output: [{ type: "message", content: [{ type: "output_text", text: "private partial response" }] }],
  }, "completion"],
  ["responses", { status: "failed", error: { code: "ContentFiltered", message: "private provider error" },
    output: [{ type: "function_call", arguments: "invalid partial tool" }],
  }, "unknown"],
] as const) {
  test(`${api} ${"status" in payload ? payload.status : "filtered completion"} rejects partial filtered output before tool parsing`, async () => {
    let calls = 0;
    const backend = new AzureOpenAIBackend({
      endpoint: "https://example.openai.azure.com", deployment: "model", apiVersion: "2024-10-21", api,
      getAccessToken: async () => "token",
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify(payload), { status: 200, headers: { "x-request-id": "request_87654321" } });
      },
    });
    await assert.rejects(backend.complete(REQUEST), (error: unknown) => {
      assert.ok(error instanceof ModelBackendError);
      assert.equal(error.kind, "content_policy");
      assert.equal(error.contentPolicy?.direction, direction);
      assert.equal(error.contentPolicy?.providerRequestId, "request_87654321");
      assert.doesNotMatch(JSON.stringify(error), /private|partial|invalid/);
      return true;
    });
    assert.equal(calls, 1);
  });
}

test("Azure OpenAI Responses mode uses GPT-5-compatible fields and parses output", async () => {
  let requestUrl = "";
  let requestBody: Record<string, unknown> | undefined;
  const backend = new AzureOpenAIBackend({
    endpoint: "https://example.openai.azure.com",
    deployment: "gpt-5.6-sol",
    api: "responses",
    apiVersion: "2024-10-21",
    defaultMaxOutputTokens: 32_768,
    reasoningEffort: "medium",
    verbosity: "medium",
    getAccessToken: () => Promise.resolve("managed-identity-token"),
    fetchImpl: async (input, init) => {
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          status: "completed",
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "done" }],
            },
          ],
          usage: {
            input_tokens: 20,
            output_tokens: 5,
            output_tokens_details: { reasoning_tokens: 3 },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });

  const result = await backend.complete(REQUEST);

  assert.equal(requestUrl, "https://example.openai.azure.com/openai/v1/responses");
  assert.equal(requestBody?.model, "gpt-5.6-sol");
  assert.equal(requestBody?.instructions, "system");
  assert.equal(requestBody?.max_output_tokens, 32_768);
  assert.deepEqual(requestBody?.reasoning, { effort: "medium" });
  assert.deepEqual(requestBody?.text, { verbosity: "medium" });
  assert.equal(Object.hasOwn(requestBody ?? {}, "temperature"), false);
  assert.equal(Object.hasOwn(requestBody ?? {}, "max_tokens"), false);
  assert.equal(Object.hasOwn(requestBody ?? {}, "tools"), false);
  assert.equal(Object.hasOwn(requestBody ?? {}, "store"), false);
  assert.equal(Object.hasOwn(requestBody ?? {}, "include"), false);
  assert.deepEqual(requestBody?.input, [{ role: "user", content: "hello" }]);
  assert.equal(result.text, "done");
  assert.equal(result.finishReason, "completed");
  assert.equal(result.usage?.inputTokens, 20);
  assert.equal(result.usage?.outputTokens, 5);
  assert.equal(result.usage?.reasoningTokens, 3);
  assert.equal(result.toolCalls, undefined);
  assert.equal(result.responseItems, undefined);
});

test("Azure OpenAI preserves cache/reasoning subsets and uses configured cache pricing", async () => {
  const backend = new AzureOpenAIBackend({
    endpoint: "https://example.openai.azure.com",
    deployment: "deployment-a",
    api: "responses",
    apiVersion: "2024-10-21",
    pricing: {
      inputPerMTokUsd: 2,
      cachedInputPerMTokUsd: 0.5,
      cacheWritePerMTokUsd: 3,
      outputPerMTokUsd: 4,
    },
    getAccessToken: async () => "token",
    fetchImpl: async () => new Response(JSON.stringify({
      id: "resp_123",
      model: "gpt-5.6-sol",
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }],
      usage: {
        input_tokens: 100,
        input_tokens_details: { cached_tokens: 40, cache_write_tokens: 10 },
        output_tokens: 20,
        output_tokens_details: { reasoning_tokens: 5 },
      },
    }), { status: 200 }),
  });

  const result = await backend.complete(REQUEST);
  assert.equal(result.model, "gpt-5.6-sol");
  assert.equal(result.deployment, "deployment-a");
  assert.equal(result.providerResponseId, "resp_123");
  assert.equal(result.usage?.cacheReadTokens, 40);
  assert.equal(result.usage?.cacheWriteTokens, 10);
  assert.equal(result.usage?.reasoningTokens, 5);
  assert.equal(result.usage?.costStatus, "complete");
  assert.ok(Math.abs(
    (result.usage?.estimatedCostUsd ?? 0) -
    (60 * 2 + 40 * 0.5 + 10 * 3 + 20 * 4) / 1_000_000,
  ) < 1e-12);
});

test("cache usage without a cache meter is explicitly incompletely priced", async () => {
  const backend = new AzureOpenAIBackend({
    endpoint: "https://example.openai.azure.com",
    deployment: "deployment-a",
    api: "responses",
    apiVersion: "2024-10-21",
    pricing: { inputPerMTokUsd: 2, outputPerMTokUsd: 4 },
    getAccessToken: async () => "token",
    fetchImpl: async () => new Response(JSON.stringify({
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }],
      usage: {
        input_tokens: 100,
        input_tokens_details: { cached_tokens: 40 },
        output_tokens: 20,
      },
    }), { status: 200 }),
  });

  const result = await backend.complete(REQUEST);
  assert.equal(result.usage?.costStatus, "incomplete");
  assert.equal(result.usage?.pricedCompletionCount, 0);
  assert.equal(result.usage?.incompletelyPricedCompletionCount, 1);
  assert.equal(result.usage?.estimatedCostUsd, (60 * 2 + 20 * 4) / 1_000_000);
});

test("pricing configuration distinguishes missing values from a zero rate", () => {
  assert.equal(modelPricingFromEnvironment({
    SQUAD_MCP_PRICE_INPUT_PER_MTOK: "",
    SQUAD_MCP_PRICE_OUTPUT_PER_MTOK: "",
  }), undefined);
  assert.throws(() => modelPricingFromEnvironment({
    SQUAD_MCP_PRICE_INPUT_PER_MTOK: "",
    SQUAD_MCP_PRICE_OUTPUT_PER_MTOK: "4",
  }), /Both SQUAD_MCP_PRICE_INPUT_PER_MTOK/);
  assert.throws(() => modelPricingFromEnvironment({
    SQUAD_MCP_PRICE_INPUT_PER_MTOK: "not-a-rate",
    SQUAD_MCP_PRICE_OUTPUT_PER_MTOK: "4",
  }), /SQUAD_MCP_PRICE_INPUT_PER_MTOK/);
  assert.deepEqual(modelPricingFromEnvironment({
    SQUAD_MCP_PRICE_INPUT_PER_MTOK: "0",
    SQUAD_MCP_PRICE_OUTPUT_PER_MTOK: "4",
    SQUAD_MCP_PRICE_CACHED_INPUT_PER_MTOK: "0.5",
  }), {
    inputPerMTokUsd: 0,
    outputPerMTokUsd: 4,
    cachedInputPerMTokUsd: 0.5,
  });
});

const TOOLS: BackendTool[] = [{
  name: "search",
  description: "Search approved sources",
  parameters: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
    additionalProperties: false,
  },
}];
const TOOL_CALLS = [
  { id: "call_1", name: "search", arguments: '{"query":"first"}' },
  { id: "call_2", name: "search", arguments: '{"query":"second"}' },
];
const RESPONSE_ITEMS = [
  { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "opaque-reasoning" },
  ...TOOL_CALLS.map((call, index) => ({
    type: "function_call",
    id: `fc_${index}`,
    call_id: call.id,
    name: call.name,
    arguments: call.arguments,
    status: "completed",
  })),
];
const CHAT_TOOL_CALLS = TOOL_CALLS.map((call) => ({
  id: call.id,
  type: "function",
  function: { name: call.name, arguments: call.arguments },
}));

function mockBackend(
  api: AzureOpenAIApi,
  outputs: Record<string, unknown>[],
  bodies: Record<string, unknown>[] = [],
): AzureOpenAIBackend {
  return new AzureOpenAIBackend({
    endpoint: "https://example.openai.azure.com",
    deployment: "model",
    api,
    apiVersion: "2024-10-21",
    pricing: { inputPerMTokUsd: 1, outputPerMTokUsd: 2 },
    getAccessToken: () => Promise.resolve("managed-identity-token"),
    fetchImpl: async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      assert.ok(outputs.length, "unexpected model call");
      return new Response(JSON.stringify(outputs.shift()), { status: 200 });
    },
  });
}

for (const api of ["chat-completions", "responses"] as const) {
  test(`Azure OpenAI ${api} rejects required choice without declared tools before inference`, async () => {
    const bodies: Record<string, unknown>[] = [];
    const events: BackendCompletionEvent[] = [];
    const backend = mockBackend(api, [], bodies);
    for (const tools of [undefined, []]) {
      await assert.rejects(
        completeWithObserver(
          backend,
          { ...REQUEST, tools, toolChoice: "required" },
          (event) => { events.push(event); },
        ),
        (error: unknown) => error instanceof ModelBackendError &&
          error.kind === "invalid_request" && error.providerCode === "required_tools_missing",
      );
    }
    assert.equal(bodies.length, 0);
    assert.equal(events.length, 0, "Local validation is not a provider attempt.");
  });

  test(`Azure OpenAI ${api} forwards required native tool choice`, async () => {
    const bodies: Record<string, unknown>[] = [];
    const payload = api === "responses"
      ? { status: "completed", output: RESPONSE_ITEMS }
      : { choices: [{ message: { content: null, tool_calls: CHAT_TOOL_CALLS }, finish_reason: "tool_calls" }] };
    const backend = mockBackend(api, [payload], bodies);
    const result = await backend.complete({ ...REQUEST, tools: TOOLS, toolChoice: "required" });
    assert.equal(bodies[0].tool_choice, "required");
    assert.deepEqual(result.toolCalls, TOOL_CALLS);
  });

  test(`Azure OpenAI ${api} supports a tool-only roundtrip without losing usage`, async () => {
    const bodies: Record<string, unknown>[] = [];
    const backend = mockBackend(api, api === "responses" ? [
      {
        status: "completed",
        output: RESPONSE_ITEMS,
        usage: {
          input_tokens: 20,
          output_tokens: 5,
          output_tokens_details: { reasoning_tokens: 3 },
        },
      },
      {
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }],
      },
    ] : [
      {
        choices: [{ message: { content: null, tool_calls: CHAT_TOOL_CALLS }, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 20, completion_tokens: 5 },
      },
      { choices: [{ message: { content: "done" }, finish_reason: "stop" }] },
    ], bodies);

    assert.equal(backend.supportsTools, true);
    const first = await backend.complete({ ...REQUEST, tools: TOOLS, maxOutputTokens: 99 });
    assert.equal(first.text, "");
    assert.deepEqual(first.toolCalls, TOOL_CALLS);
    assert.equal(first.finishReason, api === "responses" ? "completed" : "tool_calls");
    assert.equal(first.usage?.inputTokens, 20);
    assert.equal(first.usage?.outputTokens, 5);
    assert.equal(first.usage?.estimatedCostUsd, 20 / 1_000_000 + 5 / 1_000_000 * 2);
    const results: BackendMessage[] = TOOL_CALLS.map((call) => ({
      role: "tool",
      toolCallId: call.id,
      content: `result for ${call.id}`,
    }));
    const last = await backend.complete({
      ...REQUEST,
      tools: TOOLS,
      messages: [
        ...REQUEST.messages,
        { role: "assistant", content: first.text, toolCalls: first.toolCalls, responseItems: first.responseItems },
        ...results,
      ],
    });
    assert.equal(last.text, "done");
    assert.equal(last.toolCalls, undefined);
    assert.equal(bodies.length, 2);
    assert.ok(bodies.every((body) => !Object.hasOwn(body, "tool_choice")));
    if (api === "responses") {
      assert.deepEqual(first.responseItems, RESPONSE_ITEMS);
      assert.equal(first.usage?.reasoningTokens, 3);
      assert.deepEqual(bodies[0].tools, TOOLS.map((tool) => ({ type: "function", ...tool, strict: false })));
      assert.equal(bodies[0].max_output_tokens, 99);
      for (const body of bodies) {
        assert.equal(body.store, false);
        assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
        assert.equal(Object.hasOwn(body, "previous_response_id"), false);
      }
      assert.deepEqual(bodies[1].input, [
        ...REQUEST.messages,
        ...RESPONSE_ITEMS,
        ...results.map((message) => ({
          type: "function_call_output", call_id: message.toolCallId, output: message.content,
        })),
      ]);
    } else {
      assert.equal(first.responseItems, undefined);
      assert.equal(bodies[0].max_tokens, 99);
      assert.deepEqual(bodies[0].tools, TOOLS.map((tool) => ({ type: "function", function: { ...tool, strict: false } })));
      assert.deepEqual(bodies[1].messages, [
        { role: "system", content: REQUEST.system },
        ...REQUEST.messages,
        { role: "assistant", content: "", tool_calls: CHAT_TOOL_CALLS },
        ...results.map((message) => ({
          role: "tool", content: message.content, tool_call_id: message.toolCallId,
        })),
      ]);
      assert.equal(Object.hasOwn(bodies[0], "store"), false);
      assert.equal(Object.hasOwn(bodies[0], "include"), false);
    }
  });

  test(`Azure OpenAI ${api} preserves text-only payloads with omitted or empty tools`, async () => {
    const bodies: Record<string, unknown>[] = [];
    const payload = api === "responses"
      ? { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }] }
      : { choices: [{ message: { content: "done" }, finish_reason: "stop" }] };
    const backend = mockBackend(api, [payload, payload], bodies);
    const omitted = await backend.complete(REQUEST);
    const empty = await backend.complete({ ...REQUEST, tools: [] });
    assert.deepEqual(empty, omitted);
    assert.equal(omitted.toolCalls, undefined);
    assert.equal(omitted.responseItems, undefined);
    assert.deepEqual(bodies[0], bodies[1]);
    assert.deepEqual(bodies[0], api === "responses" ? {
      model: "model", instructions: "system", input: REQUEST.messages, max_output_tokens: 32_768,
    } : {
      messages: [{ role: "system", content: "system" }, ...REQUEST.messages],
      temperature: 0.2, max_tokens: 1_500,
    });
  });

  for (const [label, override] of [
    ["missing ID", { id: undefined }],
    ["blank ID", { id: " " }],
    ["missing name", { name: undefined }],
    ["blank name", { name: " " }],
    ["missing arguments", { arguments: undefined }],
    ["non-string arguments", { arguments: {} }],
    ["invalid JSON arguments", { arguments: '{"private_context":' }],
    ["non-object JSON arguments", { arguments: "null" }],
    ["array JSON arguments", { arguments: "[]" }],
  ] as const) {
    test(`Azure OpenAI ${api} rejects ${label} rather than succeeding with text`, async () => {
      const call = { ...TOOL_CALLS[0], ...override };
      const payload = api === "responses" ? {
        status: "completed",
        output: [
          { type: "message", content: [{ type: "output_text", text: "not a success" }] },
          { type: "function_call", call_id: call.id, name: call.name, arguments: call.arguments },
        ],
      } : {
        choices: [{
          message: {
            content: "not a success",
            tool_calls: [{ type: "function", id: call.id, function: { name: call.name, arguments: call.arguments } }],
          },
          finish_reason: "tool_calls",
        }],
      };
      const backend = mockBackend(api, [payload]);
      await assert.rejects(() => backend.complete({ ...REQUEST, tools: TOOLS }), (error: unknown) => {
        assert.ok(error instanceof ModelBackendError);
        assert.equal(error.kind, "upstream");
        assert.equal(error.providerCode, "malformed_tool_call");
        assert.doesNotMatch(String(error), /private_context|not a success/);
        return true;
      });
    });
  }

  test(`Azure OpenAI ${api} rejects duplicate call IDs`, async () => {
    const backend = mockBackend(api, [api === "responses" ? {
      status: "completed", output: [RESPONSE_ITEMS[1], RESPONSE_ITEMS[1]],
    } : {
      choices: [{ message: { tool_calls: [CHAT_TOOL_CALLS[0], CHAT_TOOL_CALLS[0]] }, finish_reason: "tool_calls" }],
    }]);
    await assert.rejects(() => backend.complete({ ...REQUEST, tools: TOOLS }), /malformed_tool_call/);
  });

  test(`Azure OpenAI ${api} requires a tool result call ID before sending`, async () => {
    const bodies: Record<string, unknown>[] = [];
    const backend = mockBackend(api, [], bodies);
    await assert.rejects(() => backend.complete({
      ...REQUEST, tools: TOOLS, messages: [{ role: "tool", content: "result" }],
    }), /missing_tool_call_id/);
    assert.equal(bodies.length, 0);
  });
}

test("Azure OpenAI Responses replays opaque output once, preserving mixed text and reasoning", async () => {
  const bodies: Record<string, unknown>[] = [];
  const items = [
    RESPONSE_ITEMS[0],
    { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "Searching", annotations: [] }] },
    RESPONSE_ITEMS[1],
  ];
  const backend = mockBackend("responses", [
    { status: "completed", output: items },
    { status: "completed", output: [] },
  ], bodies);
  const first = await backend.complete({ ...REQUEST, tools: TOOLS });
  assert.equal(first.text, "Searching");
  await backend.complete({
    ...REQUEST,
    messages: [
      ...REQUEST.messages,
      { role: "assistant", content: first.text, toolCalls: first.toolCalls, responseItems: first.responseItems },
      { role: "tool", toolCallId: "call_1", content: '{"matches":[]}' },
    ],
  });
  assert.deepEqual(bodies[1].input, [
    ...REQUEST.messages, ...items,
    { type: "function_call_output", call_id: "call_1", output: '{"matches":[]}' },
  ]);
  assert.equal(bodies[1].store, false);
  assert.deepEqual(bodies[1].include, ["reasoning.encrypted_content"]);
});

test("Azure OpenAI Responses maps portable assistant calls when opaque replay is absent", async () => {
  const bodies: Record<string, unknown>[] = [];
  const backend = mockBackend("responses", [{ status: "completed", output: [] }], bodies);
  await backend.complete({
    ...REQUEST, tools: TOOLS,
    messages: [
      { role: "assistant", content: "Searching", toolCalls: TOOL_CALLS },
      { role: "tool", toolCallId: "call_1", content: "first result" },
      { role: "tool", toolCallId: "call_2", content: "second result" },
    ],
  });
  assert.deepEqual(bodies[0].input, [
    { role: "assistant", content: "Searching" },
    ...TOOL_CALLS.map((call) => ({
      type: "function_call", call_id: call.id, name: call.name, arguments: call.arguments,
    })),
    { type: "function_call_output", call_id: "call_1", output: "first result" },
    { type: "function_call_output", call_id: "call_2", output: "second result" },
  ]);
});

for (const calls of [undefined, null, {}, [], [null], [{ type: "custom", id: "call_1" }]]) {
  test(`Azure OpenAI Chat rejects malformed tool-call envelopes: ${JSON.stringify(calls)}`, async () => {
    const backend = mockBackend("chat-completions", [{
      choices: [{ message: { content: "not a success", tool_calls: calls }, finish_reason: "tool_calls" }],
    }]);
    await assert.rejects(() => backend.complete({ ...REQUEST, tools: TOOLS }), /malformed_tool_call/);
  });
}

test("Azure OpenAI tool calls preserve existing output-limit handling for both APIs", async () => {
  const responses = mockBackend("responses", [{
    status: "incomplete", incomplete_details: { reason: "max_output_tokens" },
    output: [{ type: "function_call", call_id: "call_1", name: "search", arguments: "{" }],
  }]);
  await assert.rejects(() => responses.complete({ ...REQUEST, tools: TOOLS }), (error: unknown) => {
    assert.ok(error instanceof ModelBackendError);
    assert.equal(error.kind, "output_limit");
    return true;
  });
  const chat = mockBackend("chat-completions", [{
    choices: [{
      message: {
        content: "partial",
        tool_calls: [{ type: "function", id: "call_1", function: { name: "search", arguments: "{" } }],
      },
      finish_reason: "length",
    }],
  }]);
  const result = await chat.complete({ ...REQUEST, tools: TOOLS });
  assert.equal(result.finishReason, "length");
  assert.equal(result.text, "partial");
  assert.equal(result.toolCalls, undefined);
});

test("Azure OpenAI retries a native tool request without changing its body", async () => {
  const bodies: string[] = [];
  const backend = new AzureOpenAIBackend({
    endpoint: "https://example.openai.azure.com", deployment: "model", api: "responses",
    apiVersion: "2024-10-21",
    getAccessToken: () => Promise.resolve("managed-identity-token"),
    fetchImpl: async (_input, init) => {
      bodies.push(String(init?.body));
      return bodies.length === 1
        ? new Response(undefined, { status: 429 })
        : new Response(JSON.stringify({ status: "completed", output: RESPONSE_ITEMS }), { status: 200 });
    },
    sleep: async () => {},
  });
  const result = await backend.complete({ ...REQUEST, tools: TOOLS });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1]);
  assert.deepEqual(result.toolCalls, TOOL_CALLS);
});

for (const api of ["chat-completions", "responses"] as const) {
  test(`Azure OpenAI ${api} forwards cancellation to fetch without retrying`, { timeout: 1_000 }, async () => {
    const controller = new AbortController();
    let calls = 0;
    const backend = new AzureOpenAIBackend({
      endpoint: "https://example.openai.azure.com", deployment: "model", api,
      apiVersion: "2024-10-21",
      getAccessToken: async () => "managed-identity-token",
      fetchImpl: async (_input, init) => {
        calls += 1;
        assert.equal(init?.signal, controller.signal);
        return new Promise<Response>((_resolve, reject) => {
          controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
          setImmediate(() => controller.abort());
        });
      },
      sleep: async () => { assert.fail("aborted fetch must not retry"); },
    });
    await assert.rejects(
      () => backend.complete({ ...REQUEST, tools: TOOLS, signal: controller.signal }),
      (error: unknown) => error === controller.signal.reason,
    );
    assert.equal(calls, 1);
  });
}

test("Azure OpenAI rejects pre-aborted requests before authentication or fetch", async () => {
  const controller = new AbortController();
  controller.abort();
  const backend = new AzureOpenAIBackend({
    endpoint: "https://example.openai.azure.com", deployment: "model",
    apiVersion: "2024-10-21",
    getAccessToken: async () => { assert.fail("must not authenticate"); },
    fetchImpl: async () => { assert.fail("must not fetch"); },
  });
  await assert.rejects(
    () => backend.complete({ ...REQUEST, signal: controller.signal }),
    (error: unknown) => error === controller.signal.reason,
  );
});

test("Azure OpenAI cancellation interrupts authentication waiting", { timeout: 1_000 }, async () => {
  const controller = new AbortController();
  const backend = new AzureOpenAIBackend({
    endpoint: "https://example.openai.azure.com", deployment: "model",
    apiVersion: "2024-10-21",
    getAccessToken: () => {
      setImmediate(() => controller.abort());
      return new Promise<string>(() => {});
    },
    fetchImpl: async () => { assert.fail("must not fetch"); },
  });
  await assert.rejects(
    () => backend.complete({ ...REQUEST, signal: controller.signal }),
    (error: unknown) => error === controller.signal.reason,
  );
});

for (const injectedSleep of [false, true]) {
  test(`Azure OpenAI cancellation interrupts ${injectedSleep ? "injected" : "default"} retry sleep`, { timeout: 1_000 }, async () => {
    const controller = new AbortController();
    let calls = 0;
    const backend = new AzureOpenAIBackend({
      endpoint: "https://example.openai.azure.com", deployment: "model",
      apiVersion: "2024-10-21",
      getAccessToken: async () => "managed-identity-token",
      fetchImpl: async () => {
        calls += 1;
        setImmediate(() => controller.abort());
        return new Response(undefined, { status: 429 });
      },
      retryBaseMs: 60_000,
      ...(injectedSleep ? { sleep: () => new Promise<void>(() => {}) } : {}),
    });
    await assert.rejects(
      () => backend.complete({ ...REQUEST, signal: controller.signal }),
      (error: unknown) => error === controller.signal.reason,
    );
    assert.equal(calls, 1);
  });
}

test("Azure OpenAI Responses mode surfaces an exhausted output budget", async () => {
  const events: BackendCompletionEvent[] = [];
  const backend = new AzureOpenAIBackend({
    endpoint: "https://example.openai.azure.com",
    deployment: "gpt-5.6-sol",
    api: "responses",
    apiVersion: "2024-10-21",
    getAccessToken: () => Promise.resolve("managed-identity-token"),
    fetchImpl: () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" },
            output: [],
            usage: {
              input_tokens: 100,
              output_tokens: 32_768,
              output_tokens_details: { reasoning_tokens: 32_768 },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
  });

  await assert.rejects(
    () => completeWithObserver(backend, REQUEST, (event) => { events.push(event); }),
    (error: unknown) => {
      assert.ok(error instanceof ModelBackendError);
      assert.equal(error.kind, "output_limit");
      assert.equal(error.providerCode, "max_output_tokens");
      assert.equal(error.usage?.inputTokens, 100);
      assert.equal(error.usage?.outputTokens, 32_768);
      assert.equal(error.usage?.reasoningTokens, 32_768);
      return true;
    },
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].outcome, "incomplete");
  assert.equal(events[0].usage?.inputTokens, 100);
});
