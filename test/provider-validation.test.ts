import assert from "node:assert/strict";
import test from "node:test";
import { AzureOpenAIBackend } from "../src/engine/backends/azure-openai.js";
import { providerErrorEnvelopes, safeProviderValidation } from "../src/engine/backends/provider-validation.js";
import { ModelBackendError } from "../src/engine/model-backend.js";
import { RedactingLogger } from "../src/observability/logger.js";

const tools = [{ name: "read_file", description: "Read a file", parameters: { type: "object" } }];

for (const wrapper of ["root", "error", "innererror", "inner_error", "mixed"] as const) {
  const detail = {
    code: "invalid_request_error", type: "invalid_request_error", param: "tools.0.function.parameters",
    message: "Invalid schema for function 'read_file': array schema missing items. PRIVATE_PROMPT PRIVATE_TOKEN ENCRYPTED_REASONING",
  };
  const payload = wrapper === "root" ? detail
    : wrapper === "error" ? { error: detail }
      : wrapper === "mixed" ? { error: { code: "BadRequest", inner_error: { innererror: detail } } }
        : { error: { code: "BadRequest", [wrapper]: detail } };
  test(`safe validation projects ${wrapper} envelopes without retaining arbitrary content`, () => {
    const safe = safeProviderValidation(payload, tools);
    assert.equal(safe.providerCode, detail.code);
    assert.equal(safe.providerType, detail.type);
    assert.equal(safe.providerParam, detail.param);
    assert.equal(safe.explanation?.rule, "array_schema_missing_items");
    assert.doesNotMatch(JSON.stringify(safe), /PRIVATE_PROMPT|PRIVATE_TOKEN|ENCRYPTED_REASONING/);
  });
  for (const api of ["responses", "chat-completions"] as const) {
    test(`${api} actual HTTP400 adapter preserves ${wrapper} envelope diagnostics and classification`, async () => {
      const lines: string[] = [];
      let calls = 0;
      const backend = new AzureOpenAIBackend({
        endpoint: "https://example.openai.azure.com", deployment: "alias", api, apiVersion: "2024-10-21",
        getAccessToken: async () => "PRIVATE_TOKEN", maxRetries: 0,
        logger: new RedactingLogger({ sink: line => lines.push(line) }),
        fetchImpl: async () => {
          calls++;
          return new Response(JSON.stringify(payload), {
            status: 400, headers: { "x-request-id": "validation-envelope-test-1234" },
          });
        },
      });
      await assert.rejects(backend.complete({
        system: "PRIVATE_PROMPT", messages: [{ role: "user", content: "PRIVATE_PROMPT" }], tools,
      }), error => {
        assert.ok(error instanceof ModelBackendError);
        assert.equal(error.kind, "invalid_request");
        assert.equal(error.providerCode, detail.code);
        assert.equal(error.providerRequestId, "validation-envelope-test-1234");
        return true;
      });
      assert.equal(calls, 1);
      assert.match(lines.join("\n"), /array_schema_missing_items/);
      assert.doesNotMatch(lines.join("\n"), /PRIVATE_PROMPT|PRIVATE_TOKEN|ENCRYPTED_REASONING/);
    });
  }
}

test("nested unknown metadata is explicitly omitted while outer safe diagnostics remain separately available", () => {
  const safe = safeProviderValidation({
    error: {
      code: "BadRequest", type: "invalid_request_error",
      inner_error: { code: "PRIVATE_PROMPT", type: "PRIVATE_PROMPT", param: "input.PRIVATE_PROMPT", message: "PRIVATE_PROMPT" },
    },
  });
  assert.equal(safe.providerCode, null);
  assert.equal(safe.fieldStates.code, "omitted_unsafe_or_unknown");
  assert.equal(safe.explanationState, "omitted_unsafe_or_unrecognized");
  assert.ok(safe.envelopes.some(error => error.providerCode === "BadRequest"));
  assert.doesNotMatch(JSON.stringify(safe), /PRIVATE_PROMPT/);
});

test("error traversal bounds depth and cycles and ignores malformed envelopes", () => {
  const payload: Record<string, unknown> = { code: "invalid_request_error" };
  payload.inner_error = payload;
  assert.equal(providerErrorEnvelopes(payload).length, 1);
  let deep: unknown = { code: "PRIVATE_PROMPT", message: "PRIVATE_PROMPT" };
  for (let i = 0; i < 100; i++) deep = { innererror: deep };
  assert.equal(providerErrorEnvelopes(deep).length, 5);
  assert.doesNotMatch(JSON.stringify(safeProviderValidation(deep)), /PRIVATE_PROMPT/);
  for (const error of [null, [], "PRIVATE_PROMPT"]) {
    assert.equal(safeProviderValidation({ error }).fieldStates.code, "absent");
  }
});

test("Responses failed status HTTP200 logs nested safe validation rather than a success-shaped fallback", async () => {
  const lines: string[] = [];
  const backend = new AzureOpenAIBackend({
    endpoint: "https://example.openai.azure.com", deployment: "alias", api: "responses", apiVersion: "2024-10-21",
    getAccessToken: async () => "PRIVATE_TOKEN", maxRetries: 0,
    logger: new RedactingLogger({ sink: line => lines.push(line) }),
    fetchImpl: async () => new Response(JSON.stringify({
      status: "failed", error: { inner_error: {
        code: "invalid_request_error", type: "invalid_request_error", param: "temperature",
        message: "Unsupported parameter: 'temperature'. PRIVATE_PROMPT",
      } },
    }), { headers: { "apim-request-id": "failed-response-test-1234" } }),
  });
  await assert.rejects(backend.complete({
    system: "PRIVATE_PROMPT", messages: [{ role: "user", content: "PRIVATE_PROMPT" }],
  }), error => error instanceof ModelBackendError && error.providerRequestId === "failed-response-test-1234");
  assert.match(lines.join("\n"), /unsupported_parameter/);
  assert.doesNotMatch(lines.join("\n"), /response completed|PRIVATE_PROMPT|PRIVATE_TOKEN/);
});

for (const key of ["innererror", "inner_error"]) {
  test(`content-policy classification and filters survive ${key} envelope spelling`, async () => {
    const backend = new AzureOpenAIBackend({
      endpoint: "https://example.openai.azure.com", deployment: "alias", api: "responses", apiVersion: "2024-10-21",
      getAccessToken: async () => "token", maxRetries: 0,
      fetchImpl: async () => new Response(JSON.stringify({ error: { code: "BadRequest", [key]: {
        code: "ResponsibleAIPolicyViolation", content_filter_result: { violence: { filtered: true, severity: "high" } },
      } } }), { status: 400 }),
    });
    await assert.rejects(backend.complete({
      system: "system", messages: [{ role: "user", content: "hello" }],
    }), error => error instanceof ModelBackendError && error.kind === "content_policy" &&
      error.providerCode === "ResponsibleAIPolicyViolation" && JSON.stringify(error.contentPolicy).includes("violence"));
  });
}

test("validation projection preserves validated identifiers and no arbitrary provider prose", () => {
  const result = safeProviderValidation({ error: {
    code: "invalid_function_parameters", type: "invalid_request_error", param: "tools[0].parameters",
    message: "Invalid schema for function 'read_file': array schema missing items. PRIVATE_PROMPT",
  } }, tools);
  assert.equal(result.providerCode, "invalid_function_parameters");
  assert.equal(result.providerType, "invalid_request_error");
  assert.equal(result.providerParam, "tools[0].parameters");
  assert.equal(result.explanation?.rule, "array_schema_missing_items");
  assert.equal(result.explanation?.tool, "read_file");
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PROMPT/);
});

test("unknown, unsafe and absent metadata are explicit, not success-shaped", () => {
  for (const message of ["PRIVATE_PROMPT", "PRIVATE_PROMPT".repeat(1000), { secret: "PRIVATE_PROMPT" }]) {
    const result = safeProviderValidation({ error: {
      code: "PRIVATE_PROMPT", type: "PRIVATE_PROMPT", param: "input.PRIVATE_PROMPT", message,
    } });
    assert.equal(result.providerCode, null);
    assert.equal(result.providerType, null);
    assert.equal(result.providerParam, null);
    assert.equal(result.explanation, null);
    assert.equal(result.explanationState, "omitted_unsafe_or_unrecognized");
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PROMPT/);
  }
  assert.equal(safeProviderValidation(undefined).fieldStates.code, "absent");
});

test("recognized schema and parameter rules retain only server-owned names and constant explanations", () => {
  for (const [message, rule] of [
    ["Missing required parameter: 'input[0].content'. PRIVATE_PROMPT", "missing_required_parameter"],
    ["Unsupported parameter: 'temperature'. PRIVATE_PROMPT", "unsupported_parameter"],
    ["Invalid schema for function 'read_file': 'additionalProperties' is required to be false. PRIVATE_PROMPT", "additional_properties_must_be_false"],
    ["Invalid schema for function 'read_file': 'required' is required to be supplied. PRIVATE_PROMPT", "required_keys_constraint"],
    ["Invalid schema for function 'read_file': must have a 'type' key. PRIVATE_PROMPT", "schema_type_required"],
  ]) {
    const result = safeProviderValidation({ error: { message } }, tools);
    assert.equal(result.explanation?.rule, rule);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PROMPT/);
  }
  const unknownTool = safeProviderValidation({ error: { message: "Invalid schema for function 'PRIVATE_PROMPT': invalid" } }, tools);
  assert.equal(unknownTool.explanation?.tool, undefined);
  assert.equal(unknownTool.explanationState, "redacted_projection");
  assert.doesNotMatch(JSON.stringify(unknownTool), /PRIVATE_PROMPT/);
});

for (const api of ["responses", "chat-completions"] as const) {
  for (const status of [400, 429, 500]) {
    test(`${api} HTTP${status}: actual adapter logs safe validation and supplied correlation without changing failure`, async () => {
      const lines: string[] = [];
      let calls = 0;
      const backend = new AzureOpenAIBackend({
        endpoint: "https://example.openai.azure.com", deployment: "model", api, apiVersion: "2024-10-21",
        getAccessToken: async () => "PRIVATE_TOKEN", maxRetries: 0,
        logger: new RedactingLogger({ sink: line => lines.push(line) }),
        fetchImpl: async () => {
          calls++;
          return new Response(JSON.stringify({ error: {
            code: "unsupported_parameter", type: "invalid_request_error", param: "temperature",
            message: "Unsupported parameter: 'temperature'. PRIVATE_PROMPT PRIVATE_TOKEN ENCRYPTED_REASONING",
          } }), { status, headers: { "apim-request-id": "diagnostic-test-request-1234" } });
        },
      });
      await assert.rejects(backend.complete({
        system: "PRIVATE_PROMPT", messages: [{ role: "user", content: "PRIVATE_PROMPT" }], tools,
      }), error => error instanceof ModelBackendError && error.status === status);
      assert.equal(calls, 1);
      const output = lines.join("\n");
      assert.match(output, /providerValidation/);
      assert.match(output, /unsupported_parameter/);
      assert.match(output, /invalid_request_error/);
      assert.match(output, /diagnostic-test-request-1234/);
      assert.doesNotMatch(output, /PRIVATE_PROMPT|PRIVATE_TOKEN|ENCRYPTED_REASONING/);
    });
  }
}
