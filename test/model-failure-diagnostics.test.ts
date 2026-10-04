import assert from "node:assert/strict";
import { test } from "node:test";
import { ModelBackendError, modelFailureDiagnostics, readModelFailure } from "../src/engine/model-backend.js";
import { AzureOpenAIBackend } from "../src/engine/backends/azure-openai.js";
import { renderEmbeddedResult } from "../src/engine/render-embedded.js";
import { AdvisoryStageFailure } from "../src/engine/advisory-pipeline.js";
import { RedactingLogger } from "../src/observability/logger.js";

const request = { system: "harmless fixture", messages: [{ role: "user" as const, content: "offline test" }] };
const routing = { routingIntent: "fixture", role: "Squad Researcher", tier: "auto" as const, council: [], parallelEligible: true, catchAll: false, gates: false };
const backend = (fetchImpl: typeof fetch, api: "chat-completions" | "responses" = "chat-completions") => new AzureOpenAIBackend({
  endpoint: "https://example.openai.azure.com", deployment: "fixture", apiVersion: "2024-10-21",
  getAccessToken: async () => "offline-token", maxRetries: 0, fetchImpl, api,
});

for (const [status, code] of [[400, "BadRequest"], [429, "RateLimitExceeded"], [500, "InternalServerError"]] as const) {
  test(`HTTP ${status} retains safe diagnostics through wrapper and terminal text/JSON`, async () => {
    let calls = 0;
    const instance = backend(async () => {
      calls++;
      return new Response(JSON.stringify({ error: { code, message: "SECRET provider prompt", private: "SECRET" } }), {
        status, headers: { "apim-request-id": "request_12345678" },
      });
    });
    await assert.rejects(instance.complete(request), (error: unknown) => {
      assert.ok(error instanceof ModelBackendError);
      const wrapped = new AdvisoryStageFailure("Squad Researcher", [], error);
      const diagnostic = modelFailureDiagnostics(wrapped.cause as ModelBackendError, wrapped.failedStage, "run-fixture");
      assert.equal(diagnostic?.providerStatus, status);
      assert.equal(diagnostic?.providerCode, code.toLowerCase());
      assert.equal(diagnostic?.providerRequestId, "request_12345678");
      const result = renderEmbeddedResult({
        kind: "embedded", outcome: "denied", reason: wrapped.reason, matchedRouting: routing,
        runId: "run-fixture", modelFailure: diagnostic, artifact: "# Preserved draft\n" + "x".repeat(80_000),
      });
      assert.equal(result.isError, true);
      assert.deepEqual(result.structuredContent?.modelFailure, diagnostic);
      assert.equal(result.structuredContent?.responsibleAi, undefined);
      const header = result.content[0].text.slice(0, 2500);
      assert.match(header, /Squad Researcher/);
      assert.match(header, /request_12345678/);
      assert.ok(header.includes(code.toLowerCase()));
      assert.match(header, /sameRunResumable/);
      assert.doesNotMatch(JSON.stringify(result) + String(error), /SECRET/);
      return true;
    });
    assert.equal(calls, 1);
  });
}

for (const code of ["UND_ERR_HEADERS_TIMEOUT", "UND_ERR_CONNECT_TIMEOUT", "ECONNRESET", "ECONNREFUSED"]) {
  test(`transport ${code} stays terminal with unknown HTTP status and no retry`, async () => {
    let calls = 0;
    const instance = backend(async () => {
      calls++;
      throw new TypeError("SECRET body", { cause: { code, message: "SECRET detail" } });
    });
    await assert.rejects(instance.complete(request), (error: unknown) => {
      assert.ok(error instanceof ModelBackendError);
      const details = modelFailureDiagnostics(error);
      assert.equal(details?.providerCode, code.toLowerCase());
      assert.equal(details?.providerStatus, undefined);
      assert.equal(details?.providerRequestId, undefined);
      assert.equal(details?.kind, "upstream");
      assert.doesNotMatch(JSON.stringify(details) + String(error), /SECRET/);
      return true;
    });
    assert.equal(calls, 1);
  });
}

test("absent and unsafe metadata stay unknown, not provider prose or a policy blocker", () => {
  const error = new ModelBackendError("upstream", {
    status: Infinity, providerCode: "SECRET_alphanumeric_payload",
    providerRequestId: "Bearer SECRET\nhttps://bad.invalid",
  });

  assert.doesNotMatch(String(error), /SECRET|Infinity/);
  const details = modelFailureDiagnostics(error, "unsafe\nSECRET", "run\nSECRET");
  assert.equal(details?.stage, "unknown");
  assert.equal(details?.runId, undefined);
  assert.equal(details?.providerStatus, undefined);
  assert.equal(details?.providerCode, undefined);
  assert.equal(details?.providerRequestId, undefined);
  assert.equal(modelFailureDiagnostics(new ModelBackendError("content_policy")), undefined);
  assert.equal(readModelFailure({ ...details, schemaVersion: 99 }), undefined);
  assert.equal(readModelFailure({ ...details, kind: "SECRET" }), undefined);
  assert.equal(readModelFailure({ ...details, kind: { toString: "upstream" } }), undefined);
  assert.deepEqual(readModelFailure({ ...details, message: "SECRET", providerCode: "SECRET" }), details);
});

for (const api of ["chat-completions", "responses"] as const) {
  test(`${api} response body failure retains its actual HTTP status and header correlation`, async () => {
    const response = new Response("", { status: 200, headers: { "x-request-id": "request_12345678" } });
    Object.defineProperty(response, "json", {
      value: async () => { throw new TypeError("SECRET body", { cause: { code: "UND_ERR_BODY_TIMEOUT" } }); },
    });
    let calls = 0;
    const instance = backend(async () => { calls++; return response; }, api);
    await assert.rejects(instance.complete(request), (error: unknown) => {
      assert.ok(error instanceof ModelBackendError);
      const details = modelFailureDiagnostics(error);
      assert.equal(details?.providerStatus, 200);
      assert.equal(details?.providerCode, "und_err_body_timeout");
      assert.equal(details?.providerRequestId, "request_12345678");
      return true;
    });
    assert.equal(calls, 1);
  });
}

test("unsafe HTTP provider identifiers are stripped rather than persisted as error messages", async () => {
  const instance = backend(async () => new Response(JSON.stringify({
    error: { code: "secret_alphanumeric_payload", message: "SECRET prompt or provider body" },
  }), { status: 500, headers: { "apim-request-id": "https://secret.invalid/token" } }));
  await assert.rejects(instance.complete(request), (error: unknown) => {
    assert.ok(error instanceof ModelBackendError);
    const details = modelFailureDiagnostics(error);
    assert.equal(details?.providerStatus, 500);
    assert.equal(details?.providerCode, undefined);
    assert.equal(details?.providerRequestId, undefined);
    assert.doesNotMatch(JSON.stringify(details) + String(error), /secret/i);
    return true;
  });
});

test("unknown incomplete-response reasons cannot escape through error receipts or logger metadata", async () => {
  const logs: string[] = [];
  const instance = new AzureOpenAIBackend({
    endpoint: "https://example.openai.azure.com", deployment: "fixture", apiVersion: "2024-10-21",
    getAccessToken: async () => "offline-token", api: "responses", maxRetries: 0,
    logger: new RedactingLogger({ sink: (line) => logs.push(line) }),
    fetchImpl: async () => new Response(JSON.stringify({
      status: "incomplete", incomplete_details: { reason: "SECRET_alphanumeric_payload" }, output: [],
    }), { status: 200, headers: { "apim-request-id": "request_12345678" } }),
  });
  await assert.rejects(instance.complete(request), (error: unknown) => {
    assert.ok(error instanceof ModelBackendError);
    assert.equal(error.kind, "upstream");
    assert.equal(error.providerCode, undefined);
    assert.equal(error.providerRequestId, "request_12345678");
    assert.doesNotMatch(JSON.stringify(modelFailureDiagnostics(error)), /SECRET/);
    return true;
  });
  assert.ok(logs.length > 0);
  assert.doesNotMatch(logs.join("\n"), /SECRET/);
});
