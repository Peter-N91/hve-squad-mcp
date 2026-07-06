/**
 * Conformance corpus 6 — auth-rejection negatives (SEC-1, SEC-2, SEC-8, PROD-1).
 *
 * The other corpora prove the POSITIVE paths (a valid caller gets a contained,
 * routed, server-side result). This corpus proves the binding gate FAILS CLOSED:
 * every control that protects the remote `/mcp` surface is exercised by a request
 * that MUST be rejected, so a regression that weakened the control would turn one
 * of these green→red. Each test drives the REAL stack assembled by the harness
 * (`ToolRouter` -> `EntraAuthenticator` -> `SessionStore` -> `HttpMcpHandler` ->
 * `EmbeddedCoordinator`); only the `jose` verifier and the AOAI backend are faked,
 * and neither fake is where these decisions live (audience/issuer/tenant/scope are
 * in the real `entra.ts`; origin/session/hero-filter are in the real `http-core.ts`).
 *
 * For every rejection we ALSO assert `backend.callCount === 0`: no model call may
 * leak before a control denies the request (the same fail-closed property SEC-6
 * proves for the gate).
 *
 * Stimuli here are DATA — forged tokens, wrong audiences, bad origins, replayed
 * session ids — never executed as authority.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildHarness, callTool, initializeSession } from "./support/harness.js";
import { FakeJwtVerifier, TEST_ISSUER, bearer } from "./support/fake-auth.js";
import type { HttpResponseLike } from "../../src/transports/http-core.js";

const ORIGIN = "https://copilotstudio.microsoft.com";
const JSON_HEADERS: Record<string, string> = { "content-type": "application/json" };

const TENANT = "33333333-cccc-4ccc-8ccc-cccccccccccc";
const TENANT_OTHER = "44444444-dddd-4ddd-8ddd-dddddddddddd";

/** The flat `{ error: reason }` body returned by the auth/origin gates. */
function reasonOf(res: HttpResponseLike): string | undefined {
  return (res.body as { error?: string } | undefined)?.error;
}

/** The JSON-RPC error object returned by the session / hero-filter gates. */
function rpcErrorOf(res: HttpResponseLike): { code: number; message: string } | undefined {
  return (res.body as { error?: { code: number; message: string } } | undefined)?.error;
}

// ---------------------------------------------------------------------------
// SEC-1 — no anonymous /mcp; audience-bound, trusted-issuer tokens only.
// ---------------------------------------------------------------------------

test("SEC-1: a request with NO bearer token is rejected 401 (no anonymous /mcp)", async () => {
  const { handler, backend } = buildHarness();
  const res = await handler.handle({
    method: "POST",
    path: "/mcp",
    headers: { origin: ORIGIN, ...JSON_HEADERS },
    body: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
  });
  assert.equal(res.status, 401, "anonymous initialize must be 401");
  assert.equal(reasonOf(res), "missing_token");
  assert.equal(backend.callCount, 0, "no model call on an anonymous request");
});

test("SEC-1: a token whose AUDIENCE does not match this resource server is rejected 401", async () => {
  const verifier = new FakeJwtVerifier();
  const { handler, backend } = buildHarness({ verifier });
  // A token minted for a DIFFERENT resource (pass-through / confused-deputy).
  verifier.register({
    token: "wrong-audience",
    tenantId: TENANT,
    subject: "user-c-oid",
    scopes: ["Squad.Research"],
    audience: "api://some-other-resource-server",
  });
  const res = await handler.handle({
    method: "POST",
    path: "/mcp",
    headers: { origin: ORIGIN, authorization: bearer("wrong-audience"), ...JSON_HEADERS },
    body: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
  });
  assert.equal(res.status, 401, "wrong-audience token must be 401");
  assert.equal(reasonOf(res), "wrong_audience");
  assert.equal(res.headers["Mcp-Session-Id"], undefined, "no session minted for a wrong-audience token");
  assert.equal(backend.callCount, 0);
});

test("SEC-1: a token from an UNTRUSTED issuer is rejected 401", async () => {
  const verifier = new FakeJwtVerifier();
  const { handler, backend } = buildHarness({ verifier, allowedIssuers: [TEST_ISSUER] });
  verifier.register({
    token: "untrusted-issuer",
    tenantId: TENANT,
    subject: "user-c-oid",
    scopes: ["Squad.Research"],
    issuer: "https://login.microsoftonline.com/attacker-tenant/v2.0",
  });
  const res = await handler.handle({
    method: "POST",
    path: "/mcp",
    headers: { origin: ORIGIN, authorization: bearer("untrusted-issuer"), ...JSON_HEADERS },
    body: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
  });
  assert.equal(res.status, 401, "untrusted-issuer token must be 401");
  assert.equal(reasonOf(res), "untrusted_issuer");
  assert.equal(backend.callCount, 0);
});

test("SEC-1: a forged/unverifiable token is rejected 401 (never trusted)", async () => {
  const { handler, backend } = buildHarness(); // fresh verifier knows no tokens
  const res = await handler.handle({
    method: "POST",
    path: "/mcp",
    headers: { origin: ORIGIN, authorization: bearer("forged.jwt.value"), ...JSON_HEADERS },
    body: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
  });
  assert.equal(res.status, 401, "forged token must be 401");
  assert.equal(reasonOf(res), "invalid_token");
  assert.equal(backend.callCount, 0);
});

// ---------------------------------------------------------------------------
// SEC-2 — per-tool scope authorization (authorizeTool default-deny).
// ---------------------------------------------------------------------------

test("SEC-2: an authenticated caller MISSING the required scope is rejected 403", async () => {
  const verifier = new FakeJwtVerifier();
  const harness = buildHarness({ verifier });
  // Authenticates fine (correct audience/issuer/tenant) but carries NO scope.
  verifier.register({ token: "no-scope", tenantId: TENANT, subject: "user-c-oid", scopes: [] });

  const sessionId = await initializeSession(harness.handler, "no-scope");
  const res = await callTool(harness.handler, {
    token: "no-scope",
    sessionId,
    name: "squad_research",
    args: { request: "Research caching options." },
  });

  assert.equal(res.status, 403, "missing scope must be 403");
  assert.equal(reasonOf(res), "missing_scope");
  assert.equal(harness.backend.callCount, 0, "authorizeTool denies before any execution");
});

test("SEC-2: scope is per-tool — a Squad.Review-only token cannot call squad_research", async () => {
  const verifier = new FakeJwtVerifier();
  const harness = buildHarness({ verifier });
  verifier.register({ token: "review-only", tenantId: TENANT, subject: "user-c-oid", scopes: ["Squad.Review"] });

  const sessionId = await initializeSession(harness.handler, "review-only");
  const res = await callTool(harness.handler, {
    token: "review-only",
    sessionId,
    name: "squad_research",
    args: { request: "Research caching options." },
  });

  assert.equal(res.status, 403, "wrong-tool scope must be 403");
  assert.equal(reasonOf(res), "missing_scope");
  assert.equal(harness.backend.callCount, 0);
});

test("SEC-2: the advisory tools squad_plan / squad_architect are FAIL-CLOSED (missing scope -> 403, no model call)", async () => {
  // Phase 5 exposes squad_plan + squad_architect remotely; prove they remain
  // default-deny — a token MISSING their scope is rejected 403 before any embedded
  // dispatch, so exposing them did not open an unauthenticated/underscoped path.
  for (const [name, present] of [
    ["squad_plan", "Squad.Architect"],
    ["squad_architect", "Squad.Plan"],
  ] as const) {
    const verifier = new FakeJwtVerifier();
    const harness = buildHarness({ verifier });
    // Carries the SIBLING advisory scope only — so a rejection proves per-tool scope.
    verifier.register({ token: "sibling-scope", tenantId: TENANT, subject: "user-c-oid", scopes: [present] });
    const sessionId = await initializeSession(harness.handler, "sibling-scope");
    const res = await callTool(harness.handler, {
      token: "sibling-scope",
      sessionId,
      name,
      args: { request: "Do the thing." },
    });
    assert.equal(res.status, 403, `${name} missing its scope must be 403`);
    assert.equal(reasonOf(res), "missing_scope", `${name} denied for missing scope`);
    assert.equal(harness.backend.callCount, 0, `${name} makes no model call when under-scoped`);
  }
});

// ---------------------------------------------------------------------------
// SEC-8 — strict Origin allow-list + identity-bound sessions.
// ---------------------------------------------------------------------------

test("SEC-8: a request with a DISALLOWED Origin is rejected 403 before auth runs", async () => {
  const verifier = new FakeJwtVerifier();
  const { handler, backend } = buildHarness({ verifier });
  // Even a perfectly valid token must not get past a disallowed Origin.
  verifier.register({ token: "valid", tenantId: TENANT, subject: "user-c-oid", scopes: ["Squad.Research"] });
  const res = await handler.handle({
    method: "POST",
    path: "/mcp",
    headers: { origin: "https://evil.example", authorization: bearer("valid"), ...JSON_HEADERS },
    body: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
  });
  assert.equal(res.status, 403, "disallowed Origin must be 403");
  assert.equal(reasonOf(res), "origin_not_allowed");
  assert.equal(res.headers["Access-Control-Allow-Origin"], undefined, "no CORS grant for a disallowed Origin");
  assert.equal(backend.callCount, 0);
});

test("SEC-8: an INVALID/forged session id is rejected 404 (re-initialize required)", async () => {
  const verifier = new FakeJwtVerifier();
  const harness = buildHarness({ verifier });
  verifier.register({ token: "valid", tenantId: TENANT, subject: "user-c-oid", scopes: ["Squad.Research"] });

  // Authenticated, but presenting a session id that was never minted.
  const res = await callTool(harness.handler, {
    token: "valid",
    sessionId: "this-session-was-never-minted",
    name: "squad_research",
    args: { request: "Research caching options." },
  });

  assert.equal(res.status, 404, "an unminted session must be 404");
  assert.equal(rpcErrorOf(res)?.code, -32600);
  assert.equal(harness.backend.callCount, 0);
});

test("SEC-8: a session minted for tenant A cannot be replayed by tenant B (404 at the handler)", async () => {
  const verifier = new FakeJwtVerifier();
  const harness = buildHarness({ verifier });
  verifier.register({ token: "tenant-a", tenantId: TENANT, subject: "user-a-oid", scopes: ["Squad.Research"] });
  verifier.register({ token: "tenant-b", tenantId: TENANT_OTHER, subject: "user-b-oid", scopes: ["Squad.Research"] });

  const aSession = await initializeSession(harness.handler, "tenant-a");
  // Tenant B authenticates fine but presents tenant A's session id.
  const res = await callTool(harness.handler, {
    token: "tenant-b",
    sessionId: aSession,
    name: "squad_research",
    args: { request: "Research caching options." },
  });

  assert.equal(res.status, 404, "cross-identity session replay must be 404");
  assert.equal(rpcErrorOf(res)?.code, -32600);
  assert.equal(harness.backend.callCount, 0);
});

// ---------------------------------------------------------------------------
// PROD-1 (Phase 5) — the remote surface exposes the full advisory surface: the
// hero tools plus the advisory tools squad_plan / squad_architect, plus the gated
// async pipeline squad_run and the squad_status poll utility. No catalog tool
// remains delegated-only; a NON-catalog (unknown) tool id is still rejected so the
// "not everything is callable" guarantee holds.
// ---------------------------------------------------------------------------

test("PROD-1: tools/list advertises the remotely-exposed tools over HTTP", async () => {
  const verifier = new FakeJwtVerifier();
  const harness = buildHarness({ verifier });
  verifier.register({
    token: "all-scopes",
    tenantId: TENANT,
    subject: "user-c-oid",
    scopes: ["Squad.Research", "Squad.Review", "Squad.Plan", "Squad.Architect", "Squad.Run"],
  });

  const sessionId = await initializeSession(harness.handler, "all-scopes");
  const res = await harness.handler.handle({
    method: "POST",
    path: "/mcp",
    headers: { origin: ORIGIN, authorization: bearer("all-scopes"), "mcp-session-id": sessionId, ...JSON_HEADERS },
    body: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  });

  const tools = (res.body as { result?: { tools?: { name: string }[] } }).result?.tools ?? [];
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ["squad_architect", "squad_plan", "squad_research", "squad_review", "squad_run", "squad_status"],
    "the remote surface lists the advisory tools plus squad_run and squad_status",
  );
});

test("PROD-1: a non-catalog (unknown) tool over HTTP is rejected even with a fully-scoped token", async () => {
  const verifier = new FakeJwtVerifier();
  const harness = buildHarness({ verifier });
  // A token carrying EVERY scope — so a rejection proves the exposure filter, not scope.
  // After Phase 5 no catalog tool remains delegated-only (squad_plan / squad_architect
  // are now advisory-exposed), so the "not everything is callable" guarantee is proven
  // against unknown tool ids that are not in the catalog at all.
  verifier.register({
    token: "all-scopes",
    tenantId: TENANT,
    subject: "user-c-oid",
    scopes: ["Squad.Research", "Squad.Review", "Squad.Plan", "Squad.Architect", "Squad.Run"],
  });

  const sessionId = await initializeSession(harness.handler, "all-scopes");

  for (const name of ["squad_deploy", "squad_unknown"]) {
    const res = await callTool(harness.handler, {
      token: "all-scopes",
      sessionId,
      name,
      args: { request: "Do the thing." },
    });
    // The exposure filter returns a JSON-RPC method-not-found (-32601) at HTTP 200.
    assert.equal(res.status, 200, `${name} reaches the JSON-RPC layer`);
    assert.equal(rpcErrorOf(res)?.code, -32601, `${name} must be unavailable over HTTP`);
    assert.match(rpcErrorOf(res)?.message ?? "", /Unknown or unavailable tool/, `${name} reported unavailable`);
  }
  assert.equal(harness.backend.callCount, 0, "no unknown tool reached the embedded backend");
});
