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
import { createCapturingLogger } from "./support/log-capture.js";
import { buildHarness, callTool, initializeSession, resultText } from "./support/harness.js";
import { FakeJwtVerifier } from "./support/fake-auth.js";
import { MockModelBackend } from "./support/mock-backend.js";

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
