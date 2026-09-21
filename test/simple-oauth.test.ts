import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";

import { EntraAuthenticator } from "../src/auth/entra.js";
import { InMemoryOAuthGrantStore } from "../src/auth/oauth-store.js";
import {
  SimpleOAuthAuthority,
  SimpleOAuthHttpHandler,
  type SimpleOAuthConfig,
} from "../src/auth/simple-oauth.js";
import type { OAuthGrantStore } from "../src/auth/oauth-store.js";
import { RedactingLogger } from "../src/observability/logger.js";
import type { HttpRequestLike, HttpResponseLike } from "../src/transports/http-core.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const ISSUER = "https://squad.example";
const REDIRECT = "http://127.0.0.1:43123/callback";
const KEY = randomBytes(32).toString("base64");

function config(): SimpleOAuthConfig {
  return {
    enabled: true,
    externalUrl: ISSUER,
    allowedScopes: ["Squad.Run", "Squad.Architect", "Squad.Memory"],
    signingKeysBase64: [KEY],
    accessTokenTtlSeconds: 3600,
    authorizationCodeTtlSeconds: 300,
    refreshTokenTtlSeconds: 86400,
    loginCodeMaxTtlSeconds: 900,
    clientRegistrationTtlSeconds: 86400,
    allowedTenants: [TENANT],
    tableName: "squadoauth",
  };
}

function request(
  method: string,
  path: string,
  body?: unknown,
  query?: string,
): HttpRequestLike {
  return {
    method,
    path,
    query,
    headers: {
      "content-type":
        typeof body === "string"
          ? "application/x-www-form-urlencoded"
          : "application/json",
    },
    body,
  };
}

function bodyOf<T>(response: HttpResponseLike): T {
  return response.body as T;
}

function hiddenRequest(html: string): string {
  const value = html.match(/name="request" value="([^"]+)"/)?.[1];
  assert.ok(value, "authorization form contains a signed request");
  return value;
}

function makeAuthority(nowRef = { value: Date.now() }) {
  const logger = new RedactingLogger({ sink: () => undefined });
  return {
    logger,
    authority: new SimpleOAuthAuthority({
      config: config(),
      store: new InMemoryOAuthGrantStore(() => nowRef.value),
      logger,
      now: () => nowRef.value,
    }),
  };
}

async function registerClient(authority: SimpleOAuthAuthority): Promise<string> {
  const response = await authority.handle(
    request("POST", "/oauth/register", {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  );
  assert.equal(response?.status, 201);
  return bodyOf<{ client_id: string }>(response as HttpResponseLike).client_id;
}

test("publishes RFC 9728 and RFC 8414 metadata for MCP OAuth discovery", async () => {
  const { authority } = makeAuthority();
  const resource = await authority.handle(
    request("GET", "/.well-known/oauth-protected-resource/mcp"),
  );
  assert.deepEqual(bodyOf<Record<string, unknown>>(resource as HttpResponseLike), {
    resource: `${ISSUER}/mcp`,
    authorization_servers: [ISSUER],
    scopes_supported: ["Squad.Run", "Squad.Architect", "Squad.Memory"],
    bearer_methods_supported: ["header"],
  });

  const server = await authority.handle(
    request("GET", "/.well-known/oauth-authorization-server"),
  );
  const metadata = bodyOf<Record<string, unknown>>(server as HttpResponseLike);
  assert.equal(metadata.issuer, ISSUER);
  assert.equal(metadata.registration_endpoint, `${ISSUER}/oauth/register`);
  assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
  assert.deepEqual(metadata.token_endpoint_auth_methods_supported, ["none"]);
});

test("dynamic registration accepts loopback redirects and rejects remote redirects", async () => {
  const { authority } = makeAuthority();
  const clientId = await registerClient(authority);
  assert.match(clientId, /^[^.]+\.[^.]+\.[^.]+$/);

  const remote = await authority.handle(
    request("POST", "/oauth/register", {
      redirect_uris: ["https://attacker.example/callback"],
    }),
  );
  assert.equal(remote?.status, 400);
  assert.equal(
    bodyOf<{ error: string }>(remote as HttpResponseLike).error,
    "invalid_redirect_uri",
  );

  const tampered = `${clientId.slice(0, -1)}${clientId.endsWith("A") ? "B" : "A"}`;
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorization = await authority.handle(
    request(
      "GET",
      "/oauth/authorize",
      undefined,
      new URLSearchParams({
        client_id: tampered,
        response_type: "code",
        redirect_uri: REDIRECT,
        scope: "Squad.Run",
        code_challenge: challenge,
        code_challenge_method: "S256",
      }).toString(),
    ),
  );
  assert.equal(authorization?.status, 400);
});

test("authorization code flow enforces PKCE, consumes codes once, and rotates refresh tokens", async () => {
  const { authority, logger } = makeAuthority();
  const clientId = await registerClient(authority);
  const login = await authority.issueLoginCode({
    tenantId: TENANT,
    subject: "operator-approved-user",
    scopes: ["Squad.Run", "Squad.Memory"],
    ttlSeconds: 600,
  });
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const query = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: REDIRECT,
    resource: `${ISSUER}/mcp`,
    scope: "Squad.Run Squad.Memory offline_access",
    state: "client-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  const formResponse = await authority.handle(
    request("GET", "/oauth/authorize", undefined, query),
  );
  assert.equal(formResponse?.status, 200);
  const signedRequest = hiddenRequest(bodyOf<string>(formResponse as HttpResponseLike));

  const approval = await authority.handle(
    request(
      "POST",
      "/oauth/authorize",
      new URLSearchParams({
        request: signedRequest,
        login_code: login.code,
      }).toString(),
    ),
  );
  assert.equal(approval?.status, 302);
  const redirect = new URL(approval?.headers.location ?? "");
  const code = redirect.searchParams.get("code");
  assert.ok(code);
  assert.equal(redirect.searchParams.get("state"), "client-state");

  const replayedLogin = await authority.handle(
    request(
      "POST",
      "/oauth/authorize",
      new URLSearchParams({
        request: signedRequest,
        login_code: login.code,
      }).toString(),
    ),
  );
  assert.equal(replayedLogin?.status, 401);

  const badPkce = await authority.handle(
    request(
      "POST",
      "/oauth/token",
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        redirect_uri: REDIRECT,
        code_verifier: `${verifier.slice(0, -1)}A`,
        resource: `${ISSUER}/mcp`,
      }).toString(),
    ),
  );
  assert.equal(badPkce?.status, 400);
  assert.equal(
    bodyOf<{ error: string }>(badPkce as HttpResponseLike).error,
    "invalid_grant",
  );

  const login2 = await authority.issueLoginCode({
    tenantId: TENANT,
    subject: "operator-approved-user",
    scopes: ["Squad.Run", "Squad.Memory"],
  });
  const form2 = await authority.handle(
    request("GET", "/oauth/authorize", undefined, query),
  );
  const request2 = hiddenRequest(bodyOf<string>(form2 as HttpResponseLike));
  const approval2 = await authority.handle(
    request(
      "POST",
      "/oauth/authorize",
      new URLSearchParams({ request: request2, login_code: login2.code }).toString(),
    ),
  );
  const code2 = new URL(approval2?.headers.location ?? "").searchParams.get("code");
  assert.ok(code2);
  const token = await authority.handle(
    request(
      "POST",
      "/oauth/token",
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code: code2,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
        resource: `${ISSUER}/mcp`,
      }).toString(),
    ),
  );
  assert.equal(token?.status, 200);
  const issued = bodyOf<{
    access_token: string;
    refresh_token: string;
    scope: string;
  }>(token as HttpResponseLike);
  assert.equal(issued.scope, "Squad.Run Squad.Memory");
  assert.ok(logger.secretSet.has(issued.access_token));
  assert.ok(logger.secretSet.has(issued.refresh_token));

  const claims = await authority.verifier.verify(issued.access_token);
  assert.equal(claims.tid, TENANT);
  assert.equal(claims.sub, "operator-approved-user");
  assert.equal(claims.scp, "Squad.Run Squad.Memory");

  const authenticator = new EntraAuthenticator({
    audiences: [`${ISSUER}/mcp`],
    allowedIssuers: [ISSUER],
    allowedTenants: [TENANT],
    verifier: authority.verifier,
    logger,
  });
  const auth = await authenticator.authenticate(`Bearer ${issued.access_token}`);
  authenticator.authorizeTool(auth, "squad_run");

  const refreshed = await authority.handle(
    request(
      "POST",
      "/oauth/token",
      new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: issued.refresh_token,
        scope: "Squad.Run",
        resource: `${ISSUER}/mcp`,
      }).toString(),
    ),
  );
  assert.equal(refreshed?.status, 200);
  const rotated = bodyOf<{ refresh_token: string; scope: string }>(
    refreshed as HttpResponseLike,
  );
  assert.equal(rotated.scope, "Squad.Run");
  assert.notEqual(rotated.refresh_token, issued.refresh_token);

  const replayRefresh = await authority.handle(
    request(
      "POST",
      "/oauth/token",
      new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: issued.refresh_token,
        resource: `${ISSUER}/mcp`,
      }).toString(),
    ),
  );
  assert.equal(replayRefresh?.status, 400);
  assert.equal(
    bodyOf<{ error: string }>(replayRefresh as HttpResponseLike).error,
    "invalid_grant",
  );

  const revokedFamily = await authority.handle(
    request(
      "POST",
      "/oauth/token",
      new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: rotated.refresh_token,
        resource: `${ISSUER}/mcp`,
      }).toString(),
    ),
  );
  assert.equal(revokedFamily?.status, 400);
  assert.equal(
    bodyOf<{ error: string }>(revokedFamily as HttpResponseLike).error,
    "invalid_grant",
  );
});

test("login codes cannot elevate beyond their operator-issued scopes", async () => {
  const { authority } = makeAuthority();
  const clientId = await registerClient(authority);
  const login = await authority.issueLoginCode({
    tenantId: TENANT,
    subject: "limited-user",
    scopes: ["Squad.Memory"],
  });
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const form = await authority.handle(
    request(
      "GET",
      "/oauth/authorize",
      undefined,
      new URLSearchParams({
        client_id: clientId,
        response_type: "code",
        redirect_uri: REDIRECT,
        resource: `${ISSUER}/mcp`,
        scope: "Squad.Run",
        state: "limited-state",
        code_challenge: challenge,
        code_challenge_method: "S256",
      }).toString(),
    ),
  );
  const result = await authority.handle(
    request(
      "POST",
      "/oauth/authorize",
      new URLSearchParams({
        request: hiddenRequest(bodyOf<string>(form as HttpResponseLike)),
        login_code: login.code,
      }).toString(),
    ),
  );
  assert.equal(result?.status, 302);
  const denied = new URL(result?.headers.location ?? "");
  assert.equal(denied.searchParams.get("error"), "access_denied");
  assert.equal(denied.searchParams.get("state"), "limited-state");
});

test("authorization and token requests require the canonical MCP resource indicator", async () => {
  const { authority } = makeAuthority();
  const clientId = await registerClient(authority);
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const missingAuthorizationResource = await authority.handle(
    request(
      "GET",
      "/oauth/authorize",
      undefined,
      new URLSearchParams({
        client_id: clientId,
        response_type: "code",
        redirect_uri: REDIRECT,
        scope: "Squad.Run",
        code_challenge: challenge,
        code_challenge_method: "S256",
      }).toString(),
    ),
  );
  assert.equal(missingAuthorizationResource?.status, 302);
  assert.equal(
    new URL(missingAuthorizationResource?.headers.location ?? "").searchParams.get("error"),
    "invalid_target",
  );

  const missingTokenResource = await authority.handle(
    request(
      "POST",
      "/oauth/token",
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code: "not-a-code",
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      }).toString(),
    ),
  );
  assert.equal(missingTokenResource?.status, 400);
  assert.equal(
    bodyOf<{ error: string }>(missingTokenResource as HttpResponseLike).error,
    "invalid_target",
  );
});

test("OAuth storage outages return a contained 503 instead of rejecting the HTTP handler", async () => {
  const logger = new RedactingLogger({ sink: () => undefined });
  const failingStore: OAuthGrantStore = {
    put: () => Promise.reject(new Error("storage unavailable")),
    consume: () => Promise.reject(new Error("storage unavailable")),
    consumeWithTombstone: () => Promise.reject(new Error("storage unavailable")),
    update: () => Promise.reject(new Error("storage unavailable")),
    sweepExpired: () => Promise.reject(new Error("storage unavailable")),
  };
  const authority = new SimpleOAuthAuthority({
    config: config(),
    store: failingStore,
    logger,
  });
  const clientId = bodyOf<{ client_id: string }>(
    (await authority.handle(
      request("POST", "/oauth/register", {
        redirect_uris: [REDIRECT],
      }),
    )) as HttpResponseLike,
  ).client_id;
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const form = await authority.handle(
    request(
      "GET",
      "/oauth/authorize",
      undefined,
      new URLSearchParams({
        client_id: clientId,
        response_type: "code",
        redirect_uri: REDIRECT,
        resource: `${ISSUER}/mcp`,
        scope: "Squad.Run",
        code_challenge: challenge,
        code_challenge_method: "S256",
      }).toString(),
    ),
  );
  const wrapper = new SimpleOAuthHttpHandler(
    authority,
    {
      handle: () => Promise.reject(new Error("OAuth request must not fall through")),
    },
    logger,
  );
  const response = await wrapper.handle(
    request(
      "POST",
      "/oauth/authorize",
      new URLSearchParams({
        request: hiddenRequest(bodyOf<string>(form as HttpResponseLike)),
        login_code: "ABCDE-FGHIJ-KLMNO-PQRST",
      }).toString(),
    ),
  );
  assert.equal(response.status, 503);
  assert.deepEqual(bodyOf<Record<string, unknown>>(response), {
    error: "temporarily_unavailable",
    error_description: "The authorization service is temporarily unavailable.",
  });
});
