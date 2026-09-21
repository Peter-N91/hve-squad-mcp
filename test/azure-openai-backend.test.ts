import assert from "node:assert/strict";
import { test } from "node:test";

import { AzureOpenAIBackend } from "../src/engine/backends/azure-openai.js";
import { ModelBackendError } from "../src/engine/model-backend.js";

const REQUEST = {
  system: "system",
  messages: [{ role: "user" as const, content: "hello" }],
};

test("Azure OpenAI retries 429 using the service retry header", async () => {
  const delays: number[] = [];
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

  const result = await backend.complete(REQUEST);
  assert.equal(result.text, "done");
  assert.equal(calls, 2);
  assert.deepEqual(delays, [25]);
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
  assert.deepEqual(requestBody?.input, [{ role: "user", content: "hello" }]);
  assert.equal(result.text, "done");
  assert.equal(result.finishReason, "completed");
  assert.equal(result.usage?.inputTokens, 20);
  assert.equal(result.usage?.outputTokens, 5);
  assert.equal(result.usage?.reasoningTokens, 3);
});

test("Azure OpenAI Responses mode surfaces an exhausted output budget", async () => {
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
    () => backend.complete(REQUEST),
    (error: unknown) => {
      assert.ok(error instanceof ModelBackendError);
      assert.equal(error.kind, "output_limit");
      assert.equal(error.providerCode, "max_output_tokens");
      return true;
    },
  );
});
