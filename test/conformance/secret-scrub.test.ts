/**
 * Conformance corpus 5 — secret-scrub / log-scan (SEC-10).
 *
 * Runs with a fake bearer token and a model key in context, captures the logger
 * output, and asserts tokens/keys/claims are NEVER logged or surfaced in returned
 * artifacts. It exercises `observability/redact.ts` (the redaction chokepoint) at
 * three layers:
 *
 *   1. unit — `redactString`/`redactValue` scrub registered secrets and the
 *      structural patterns (JWT, `Bearer`, `Authorization` header, api-key);
 *   2. logger — the real `RedactingLogger` scrubs message + fields against the
 *      registered-secret set and the structural patterns; and
 *   3. e2e — a full HTTP request through the real handler: even when the embedded
 *      backend fails with an error string that embeds the token + model key, no log
 *      line and no tool response ever contains the raw secret.
 *
 * The bearer token is registered by the REAL `EntraAuthenticator` at the trust
 * boundary; the model key is registered by the backend credential path. Runs with
 * a STUBBED verifier and a MOCK backend — no live Azure.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { REDACTED, redactString, redactValue } from "../../src/observability/redact.js";
import { RedactingLogger } from "../../src/observability/logger.js";
import { createCapturingLogger } from "./support/log-capture.js";
import { buildHarness, callTool, initializeSession, resultText } from "./support/harness.js";
import { FakeJwtVerifier } from "./support/fake-auth.js";
import { MockModelBackend } from "./support/mock-backend.js";
import { ModelBackendError } from "../../src/engine/model-backend.js";

test("SEC-10: redactString scrubs registered secrets and structural patterns", () => {
  const secrets = new Set<string>(["super-secret-token-value"]);
  assert.equal(redactString("here is super-secret-token-value now", secrets), `here is ${REDACTED} now`);
  // A JWT (three base64url segments starting eyJ).
  assert.match(redactString("token eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.sig-part-secret end", new Set()), /\[redacted\]/);
  // A bare Bearer token.
  assert.equal(redactString("Bearer abc.def-123ghi", new Set()), REDACTED);
  // An Authorization header.
  assert.match(redactString("authorization: Bearer xyztoken1234567", new Set()), /\[redacted\]/);
  // An api-key assignment.
  assert.match(redactString("api_key=ABCDEFGHIJKLMNOP123456", new Set()), /\[redacted\]/);
  // GitHub tokens of every documented prefix, unregistered.
  for (const token of [`gho_${"a".repeat(36)}`, `ghp_${"b".repeat(36)}`, `ghu_${"c".repeat(36)}`, `ghs_${"d".repeat(36)}`, `ghr_${"e".repeat(36)}`, `github_pat_${"f".repeat(60)}`]) {
    assert.equal(redactString(`identity ${token} failed`, new Set()), `identity ${REDACTED} failed`, token.slice(0, 4));
  }
  // Ordinary identifiers that merely start alike are untouched.
  assert.equal(redactString("ghost_town github_page", new Set()), "ghost_town github_page");
  // Short registered values (< 8 chars) are NOT over-redacted.
  assert.equal(redactString("the cat sat", new Set(["cat"])), "the cat sat");
});

test("SEC-10: redactValue deep-scrubs nested structured fields", () => {
  const secrets = new Set<string>(["registered-secret-xyz"]);
  const out = redactValue(
    { a: "registered-secret-xyz", b: { c: ["Bearer tok.tok-value", 1] } },
    secrets,
  ) as { a: string; b: { c: unknown[] } };
  assert.equal(out.a, REDACTED);
  assert.equal(out.b.c[0], REDACTED);
  assert.equal(out.b.c[1], 1);
});

test("SEC-10: the logger redacts a registered token in message and fields", () => {
  const cap = createCapturingLogger();
  const token = "eyJhbGciOiJI.payloadpartsegment.signaturesecretvalue";
  cap.logger.registerSecret(token);
  cap.logger.info(`auth ok for ${token}`, { authorization: `Bearer ${token}`, ok: true });
  const text = cap.text();
  assert.ok(!text.includes(token), "raw token never logged");
  assert.match(text, /\[redacted\]/);
});

test("SEC-10: exact-secret redaction memory is bounded", () => {
  const logger = new RedactingLogger({ sink: () => undefined, maxSecrets: 2 });
  logger.registerSecret("secret-value-one");
  logger.registerSecret("secret-value-two");
  logger.registerSecret("secret-value-three");
  assert.equal(logger.secretSet.size, 2);
  assert.equal(logger.secretSet.has("secret-value-one"), false);
  assert.equal(logger.secretSet.has("secret-value-three"), true);
});

test("SEC-10: the logger redacts secret-shaped material even when unregistered", () => {
  const cap = createCapturingLogger();
  cap.logger.warn("incoming header authorization: Bearer unregistered-jwtLikeTOKEN1234567");
  assert.match(cap.text(), /\[redacted\]/);
  assert.ok(!cap.text().includes("unregistered-jwtLikeTOKEN1234567"));
});

test("SEC-10: a bearer token and model key never reach logs or the tool response (e2e error path)", async () => {
  const JWT_TOKEN =
    "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0aWQiOiJzZWMxMCJ9.signature-secret-value-abc123";
  const MODEL_KEY = "sk-secretmodelkey0123456789abcdef";
  const cap = createCapturingLogger();
  const verifier = new FakeJwtVerifier();
  verifier.register({
    token: JWT_TOKEN,
    tenantId: "sec10-tenant",
    subject: "sec10-subject",
    scopes: ["Squad.Research"],
  });
  // The backend registers its credential (mirroring the real AzureOpenAIBackend)
  // and then fails with an error string that embeds both secrets.
  const backend = new MockModelBackend({
    onComplete: () => cap.logger.registerSecret(MODEL_KEY),
    failWith: new Error(`upstream model call failed token=${JWT_TOKEN} key=${MODEL_KEY}`),
  });
  const h = buildHarness({ logger: cap.logger, lines: cap.lines, verifier, backend });

  const sessionId = await initializeSession(h.handler, JWT_TOKEN);
  const res = await callTool(h.handler, {
    token: JWT_TOKEN,
    sessionId,
    name: "squad_research",
    args: { request: "Research safely." },
  });

  // The response is the generic internal-error message — never the token/key/prompt.
  const text = resultText(res);
  assert.match(text, /internal error/i);
  assert.ok(!text.includes(JWT_TOKEN), "token never surfaced in the response");
  assert.ok(!text.includes(MODEL_KEY), "model key never surfaced in the response");

  // The error path logged something, but no captured line leaks the token or key.
  const logs = cap.text();
  assert.ok(logs.length > 0, "the error path logged something");
  assert.ok(!logs.includes(JWT_TOKEN), "bearer token never logged");
  assert.ok(!logs.includes(MODEL_KEY), "model key never logged");
  assert.match(logs, /\[redacted\]/);
});

test("a classified model context failure returns actionable text without provider details", async () => {
  const verifier = new FakeJwtVerifier();
  verifier.register({
    token: "classified-model-error",
    tenantId: "model-error-tenant",
    subject: "model-error-subject",
    scopes: ["Squad.Architect"],
  });
  const backend = new MockModelBackend({
    failWith: new ModelBackendError("input_too_large", {
      status: 400,
      providerCode: "context_length_exceeded",
    }),
  });
  const harness = buildHarness({ verifier, backend });
  const sessionId = await initializeSession(
    harness.handler,
    "classified-model-error",
  );

  const response = await callTool(harness.handler, {
    token: "classified-model-error",
    sessionId,
    name: "squad_architect",
    args: { request: "Review the architecture.", context: "bounded context" },
  });

  assert.match(resultText(response), /context is too large/i);
  assert.match(resultText(response), /context_length_exceeded/);
});

test("a stage-wrapped model failure preserves actionable HTTP text without leaking its cause", async () => {
  const verifier = new FakeJwtVerifier();
  verifier.register({
    token: "stage-wrapped-error",
    tenantId: "model-error-tenant",
    subject: "model-error-subject",
    scopes: ["Squad.Architect"],
  });
  const backend = new MockModelBackend({
    failWith: new ModelBackendError("content_policy", {
      providerCode: "sensitive-provider-payload",
    }),
  });
  const harness = buildHarness({ verifier, backend });
  const sessionId = await initializeSession(harness.handler, "stage-wrapped-error");
  const response = await callTool(harness.handler, {
    token: "stage-wrapped-error", sessionId, name: "squad_architect",
    args: { request: "Review the architecture." },
  });
  assert.match(resultText(response), /content policy/i);
  assert.doesNotMatch(resultText(response), /sensitive-provider-payload/);
  const receipt = (response.body as { result: { structuredContent: Record<string, unknown> } }).result.structuredContent;
  assert.equal(receipt.reason, "model_backend_content_policy");
  const blocker = receipt.responsibleAi as Record<string, unknown>;
  assert.equal(blocker.terminal, true);
  assert.equal(blocker.sameRunResumable, false);
  assert.equal(blocker.acknowledgmentCanOverride, false);
  assert.equal(blocker.direction, "unknown");
  assert.deepEqual(blocker.categories, []);
  assert.doesNotMatch(JSON.stringify(receipt), /sensitive-provider-payload/);
});

test("an exhausted reasoning budget is surfaced as an actionable tool error", async () => {
  const verifier = new FakeJwtVerifier();
  verifier.register({
    token: "output-limit-error",
    tenantId: "output-limit-tenant",
    subject: "output-limit-subject",
    scopes: ["Squad.Architect"],
  });
  const backend = new MockModelBackend({
    failWith: new ModelBackendError("output_limit", {
      status: 200,
      providerCode: "max_output_tokens",
    }),
  });
  const harness = buildHarness({ verifier, backend });
  const sessionId = await initializeSession(
    harness.handler,
    "output-limit-error",
  );

  const response = await callTool(harness.handler, {
    token: "output-limit-error",
    sessionId,
    name: "squad_architect",
    args: { request: "Review the architecture." },
  });

  assert.match(resultText(response), /exhausted its reasoning and output budget/i);
  assert.match(resultText(response), /max_output_tokens/);
});

test("ordinary upstream HTTP errors expose safe structured diagnostics, not policy or a human gate", async () => {
  const verifier = new FakeJwtVerifier();
  verifier.register({
    token: "upstream-diagnostics", tenantId: "upstream-tenant",
    subject: "upstream-subject", scopes: ["Squad.Architect"],
  });
  const backend = new MockModelBackend({ failWith: new ModelBackendError("upstream", {
    status: 503, providerCode: "ServiceUnavailable", providerRequestId: "request_12345678",
  }) });
  const harness = buildHarness({ verifier, backend });
  const sessionId = await initializeSession(harness.handler, "upstream-diagnostics");
  const response = await callTool(harness.handler, {
    token: "upstream-diagnostics", sessionId, name: "squad_architect",
    args: { request: "Review the bounded fixture." },
  });
  const receipt = (response.body as { result: { structuredContent: Record<string, unknown> } }).result.structuredContent;
  const details = receipt.modelFailure as Record<string, unknown>;
  assert.equal(receipt.reason, "model_backend_upstream");
  assert.equal(receipt.responsibleAi, undefined);
  assert.equal(receipt.humanInput, undefined);
  assert.equal(details.providerStatus, 503);
  assert.equal(details.providerCode, "serviceunavailable");
  assert.equal(details.providerRequestId, "request_12345678");
  assert.equal(details.sameRunResumable, false);
  assert.match(resultText(response), /machine-readable/);
  assert.match(resultText(response), /request_12345678/);
});

test("SEC-10: a successful call never echoes the bearer token into the artifact (e2e)", async () => {
  const JWT_TOKEN = "eyJhbGciOiJSUzI1NiJ9.eyJ0aWQiOiJvayJ9.success-signature-secret-xyz";
  const cap = createCapturingLogger();
  const verifier = new FakeJwtVerifier();
  verifier.register({
    token: JWT_TOKEN,
    tenantId: "sec10-ok",
    subject: "sec10-ok-subject",
    scopes: ["Squad.Research"],
  });
  const h = buildHarness({ logger: cap.logger, lines: cap.lines, verifier });

  const sessionId = await initializeSession(h.handler, JWT_TOKEN);
  const res = await callTool(h.handler, {
    token: JWT_TOKEN,
    sessionId,
    name: "squad_research",
    args: { request: "Research caching options." },
  });

  const text = resultText(res);
  assert.match(text, /squad-guided/);
  assert.ok(!text.includes(JWT_TOKEN), "token never echoed into the artifact");
  assert.ok(!cap.text().includes(JWT_TOKEN), "token never logged on the success path");
});
