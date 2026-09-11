import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  JwtClaims,
  JwtVerificationContext,
  JwtVerifier,
} from "../src/auth/entra.js";
import { normalizeMiseValidationEndpoint } from "../src/auth/mise-endpoint.js";
import { createMiseVerifier } from "../src/auth/mise-verifier.js";
import { createOAuthAwareVerifier } from "../src/auth/oauth-key-ring.js";

const CONTEXT: JwtVerificationContext = {
  originalUri: "https://squad.example/mcp?trace=1",
  originalMethod: "POST",
  forwardedFor: "203.0.113.10",
};

function token(algorithm: string, claims: JwtClaims): string {
  return [
    Buffer.from(JSON.stringify({ alg: algorithm, typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify(claims)).toString("base64url"),
    "signature",
  ].join(".");
}

test("MISE verifier sends the documented validation request and decodes claims only after HTTP 200", async () => {
  const jwt = token("RS256", {
    iss: "https://login.microsoftonline.com/tenant/v2.0",
    aud: "api://squad",
    tid: "tenant",
    oid: "caller",
    scp: "Squad.Research",
  });
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const fetchImpl: typeof fetch = (input, init) => {
    capturedUrl = String(input);
    capturedInit = init;
    return Promise.resolve(new Response("not-consumed", { status: 200 }));
  };
  const verifier = createMiseVerifier({
    endpoint: "http://127.0.0.1:5000/ValidateRequest",
    timeoutMs: 2_000,
    fetchImpl,
  });

  const claims = await verifier.verify(jwt, CONTEXT);

  assert.equal(capturedUrl, "http://127.0.0.1:5000/ValidateRequest");
  assert.equal(capturedInit?.method, "POST");
  assert.equal(capturedInit?.redirect, "error");
  const headers = new Headers(capturedInit?.headers);
  assert.equal(headers.get("Authorization"), `Bearer ${jwt}`);
  assert.equal(headers.get("Original-Uri"), CONTEXT.originalUri);
  assert.equal(headers.get("Original-Method"), CONTEXT.originalMethod);
  assert.equal(headers.get("X-Forwarded-For"), CONTEXT.forwardedFor);
  assert.equal(claims.oid, "caller");
  assert.equal(claims.scp, "Squad.Research");
});

test("MISE verifier fails closed on missing metadata, non-200 responses, and invalid JWT payloads", async () => {
  let calls = 0;
  const verifier = createMiseVerifier({
    endpoint: "http://127.0.0.1:5000/ValidateRequest",
    fetchImpl: () => {
      calls += 1;
      return Promise.resolve(new Response(null, { status: 401 }));
    },
  });

  await assert.rejects(() => verifier.verify("not-a-jwt"), /original request metadata/);
  assert.equal(calls, 0, "missing request metadata must fail before the token is forwarded");

  await assert.rejects(
    () => verifier.verify("not-a-jwt", CONTEXT),
    /failed with status 401/,
  );
  assert.equal(calls, 1);

  const success = createMiseVerifier({
    endpoint: "http://127.0.0.1:5000/ValidateRequest",
    fetchImpl: () => Promise.resolve(new Response(null, { status: 200 })),
  });
  await assert.rejects(() => success.verify("not-a-jwt", CONTEXT));
});

test("MISE endpoint accepts only the fixed loopback validation route", () => {
  assert.equal(
    normalizeMiseValidationEndpoint("http://127.0.0.1:5000/ValidateRequest"),
    "http://127.0.0.1:5000/ValidateRequest",
  );
  assert.equal(
    normalizeMiseValidationEndpoint("http://[::1]:5000/ValidateRequest"),
    "http://[::1]:5000/ValidateRequest",
  );
  for (const endpoint of [
    "https://127.0.0.1:5000/ValidateRequest",
    "http://mise.example:5000/ValidateRequest",
    "http://127.0.0.1:5001/ValidateRequest",
    "http://127.0.0.1:5000/healthz",
    "http://user:password@127.0.0.1:5000/ValidateRequest",
  ]) {
    assert.throws(() => normalizeMiseValidationEndpoint(endpoint), /loopback MISE sidecar/);
  }
});

test("OAuth-aware verifier routes local HS256 tokens locally and forwards request metadata only to Entra", async () => {
  const seen: JwtVerificationContext[] = [];
  let localCalls = 0;
  const entraVerifier: JwtVerifier = {
    verify(_jwt, context) {
      if (context) seen.push(context);
      return Promise.resolve({ tid: "entra" });
    },
  };
  const localVerifier: JwtVerifier = {
    verify() {
      localCalls += 1;
      return Promise.resolve({ tid: "local" });
    },
  };
  const verifier = createOAuthAwareVerifier(entraVerifier, localVerifier);

  assert.equal((await verifier.verify(token("HS256", {}), CONTEXT)).tid, "local");
  assert.equal(localCalls, 1);
  assert.equal(seen.length, 0);

  assert.equal((await verifier.verify(token("RS256", {}), CONTEXT)).tid, "entra");
  assert.deepEqual(seen, [CONTEXT]);
});
