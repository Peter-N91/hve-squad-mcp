import assert from "node:assert/strict";
import { test } from "node:test";

import { AuthError, principalKeyOf, userPrincipalOf } from "../src/auth/entra.js";
import { buildHarness } from "./conformance/support/harness.js";
import { bearer, FakeJwtVerifier, TEST_AUDIENCE } from "./conformance/support/fake-auth.js";

const COWORK_AUDIENCE = "api://hve-squad-mcp-test-cowork";
const TOKEN_STORE_CLIENT = "ab3be6b7-f5df-413d-ac2d-abf1e3fd9c0b";
const STUDIO_CLIENT = "11111111-1111-1111-1111-111111111111";
const ROGUE_CLIENT = "99999999-9999-9999-9999-999999999999";

function stack() {
  const verifier = new FakeJwtVerifier();
  const harness = buildHarness({
    verifier,
    audiences: [TEST_AUDIENCE, COWORK_AUDIENCE],
    allowedClientsByAudience: {
      [COWORK_AUDIENCE]: [TOKEN_STORE_CLIENT],
      [TEST_AUDIENCE]: [STUDIO_CLIENT],
    },
  });
  return { verifier, authenticator: harness.authenticator };
}

test("the same person arriving through Cowork and Copilot Studio resolves to one principal despite different sub values", async () => {
  const { verifier, authenticator } = stack();
  verifier.register({
    token: "cowork", tenantId: "t1", subject: "oid-alice", sub: "pairwise-cowork", scopes: ["Squad.Run"],
    audience: COWORK_AUDIENCE, azp: TOKEN_STORE_CLIENT,
  });
  verifier.register({
    token: "studio", tenantId: "t1", subject: "oid-alice", sub: "pairwise-studio", scopes: ["Squad.Run"],
    audience: TEST_AUDIENCE, azp: STUDIO_CLIENT,
  });
  const cowork = await authenticator.authenticate(bearer("cowork"));
  const studio = await authenticator.authenticate(bearer("studio"));

  assert.notEqual(cowork.audience, studio.audience);
  assert.equal(cowork.clientAppId, TOKEN_STORE_CLIENT);
  assert.equal(studio.clientAppId, STUDIO_CLIENT);
  assert.deepEqual(userPrincipalOf(cowork), userPrincipalOf(studio));
  assert.equal(principalKeyOf(userPrincipalOf(cowork)!), "t1|oid-alice");
});

test("a token for the right audience from a client that is not allow-listed is refused", async () => {
  const { verifier, authenticator } = stack();
  verifier.register({
    token: "rogue", tenantId: "t1", subject: "oid-alice", scopes: ["Squad.Run"], audience: COWORK_AUDIENCE, azp: ROGUE_CLIENT,
  });
  await assert.rejects(authenticator.authenticate(bearer("rogue")), (error: unknown) =>
    error instanceof AuthError && error.status === 403 && error.reason === "client_not_allowed");
});

test("a client allowed for one audience cannot use the other audience", async () => {
  const { verifier, authenticator } = stack();
  verifier.register({
    token: "crossed", tenantId: "t1", subject: "oid-alice", scopes: ["Squad.Run"], audience: COWORK_AUDIENCE, azp: STUDIO_CLIENT,
  });
  await assert.rejects(authenticator.authenticate(bearer("crossed")), (error: unknown) =>
    error instanceof AuthError && error.reason === "client_not_allowed");
});

test("a token without an azp claim is refused where a client allow-list applies", async () => {
  const { verifier, authenticator } = stack();
  verifier.register({ token: "anon-client", tenantId: "t1", subject: "oid-alice", scopes: ["Squad.Run"], audience: COWORK_AUDIENCE });
  await assert.rejects(authenticator.authenticate(bearer("anon-client")), (error: unknown) =>
    error instanceof AuthError && error.reason === "client_not_allowed");
});

test("an app-only token never yields a user principal", async () => {
  const { verifier, authenticator } = stack();
  verifier.register({
    token: "daemon", tenantId: "t1", subject: "service-oid", scopes: ["Squad.Run"], audience: TEST_AUDIENCE,
    azp: STUDIO_CLIENT, appOnly: true,
  });
  const auth = await authenticator.authenticate(bearer("daemon"));
  assert.equal(auth.tokenKind, "app");
  assert.equal(userPrincipalOf(auth), undefined);
});

test("a delegated token without an oid never falls back to the pairwise sub", async () => {
  const verifier: import("../src/auth/entra.js").JwtVerifier = {
    verify: async () => ({
      iss: "https://login.microsoftonline.com/test-tenant/v2.0", aud: TEST_AUDIENCE, tid: "t1",
      sub: "pairwise-only", scp: "Squad.Run", azp: STUDIO_CLIENT, exp: Math.floor(Date.now() / 1000) + 600,
    }),
  };
  const harness = buildHarness({ audiences: [TEST_AUDIENCE] });
  const { EntraAuthenticator } = await import("../src/auth/entra.js");
  const direct = new EntraAuthenticator({ audiences: [TEST_AUDIENCE], verifier, logger: harness.logger });
  const auth = await direct.authenticate(bearer("any"));
  assert.equal(auth.subject, "pairwise-only");
  assert.equal(auth.tokenKind, "delegated");
  assert.equal(userPrincipalOf(auth), undefined);
});

test("audiences without an allow-list entry keep the previous unrestricted behavior", async () => {
  const verifier = new FakeJwtVerifier();
  const { authenticator } = buildHarness({ verifier, audiences: [TEST_AUDIENCE] });
  verifier.register({ token: "legacy", tenantId: "t1", subject: "oid-bob", scopes: ["Squad.Run"] });
  const auth = await authenticator.authenticate(bearer("legacy"));
  assert.equal(auth.clientAppId, undefined);
  assert.deepEqual(userPrincipalOf(auth), { tenantId: "t1", objectId: "oid-bob" });
});
