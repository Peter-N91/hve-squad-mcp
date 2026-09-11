/**
 * Server-owned OAuth 2.1 authority for zero-configuration MCP clients.
 *
 * This opt-in authority intentionally does not replace Entra. It provides an
 * additional local issuer for environments where tenant policy prevents each MCP
 * client from registering an Entra application:
 *
 *   * RFC 9728 protected-resource metadata.
 *   * RFC 8414 authorization-server metadata.
 *   * RFC 7591 public-client registration.
 *   * Authorization code + PKCE S256 and rotating refresh tokens.
 *   * Operator-issued, single-use browser login codes.
 *
 * Redirects are restricted to loopback HTTP. Access tokens are short-lived HS256
 * JWTs accepted only by this MCP server; login/auth/refresh codes are one-time and
 * stored by hash through {@link OAuthGrantStore}.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { JwtVerifier } from "./entra.js";
import { OAuthKeyRing } from "./oauth-key-ring.js";
import type { OAuthGrantKind, OAuthGrantStore } from "./oauth-store.js";
import type { RedactingLogger } from "../observability/logger.js";
import type { HttpRequestLike, HttpResponseLike } from "../transports/http-core.js";

const OFFLINE_ACCESS_SCOPE = "offline_access";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const PKCE_VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;
const LOGIN_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

interface RegisteredClientEnvelope {
  typ: "client";
  exp: number;
  redirectUris: string[];
}

interface AuthorizationRequestEnvelope {
  typ: "authorization-request";
  exp: number;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  offlineAccess: boolean;
  codeChallenge: string;
  state?: string;
}

interface LoginGrantPayload {
  typ: "login";
  tenantId: string;
  subject: string;
  scopes: string[];
}

interface AuthorizationGrantPayload {
  typ: "authorization";
  tenantId: string;
  subject: string;
  scopes: string[];
  offlineAccess: boolean;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
}

interface RefreshGrantPayload {
  typ: "refresh";
  tenantId: string;
  subject: string;
  scopes: string[];
  clientId: string;
  familyId: string;
  generation: number;
  familyExpiresAt: number;
}

interface RefreshReplayPayload {
  typ: "refresh-replay";
  familyId: string;
}

interface RefreshFamilyPayload {
  typ: "refresh-family";
  generation: number;
  revoked: boolean;
}

type GrantPayload =
  | LoginGrantPayload
  | AuthorizationGrantPayload
  | RefreshGrantPayload
  | RefreshReplayPayload
  | RefreshFamilyPayload;

export interface SimpleOAuthConfig {
  enabled: boolean;
  /** Public HTTPS origin of this MCP server, with no path/query/fragment. */
  externalUrl: string;
  /** Short tool scopes this local issuer may grant. Never includes Squad.Operate. */
  allowedScopes: string[];
  /** Current key first, followed by previous keys retained during rotation. */
  signingKeysBase64: string[];
  accessTokenTtlSeconds: number;
  authorizationCodeTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  loginCodeMaxTtlSeconds: number;
  clientRegistrationTtlSeconds: number;
  /** Optional tenant allow-list shared with the resource server. */
  allowedTenants: string[];
  tableName: string;
}

export interface IssueLoginCodeInput {
  tenantId: string;
  subject: string;
  scopes?: string[];
  ttlSeconds?: number;
}

export interface IssuedLoginCode {
  code: string;
  tenantId: string;
  subject: string;
  scopes: string[];
  expiresAt: number;
  authorizationUrl: string;
}

export interface SimpleOAuthDeps {
  config: SimpleOAuthConfig;
  store: OAuthGrantStore;
  logger: RedactingLogger;
  now?: () => number;
}

function jsonHeaders(): Record<string, string> {
  return {
    "content-type": "application/json",
    "cache-control": "no-store",
    pragma: "no-cache",
    "x-content-type-options": "nosniff",
  };
}

function htmlHeaders(): Record<string, string> {
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    pragma: "no-cache",
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  };
}

function oauthError(status: number, error: string, description: string): HttpResponseLike {
  return {
    status,
    headers: jsonHeaders(),
    body: { error, error_description: description },
  };
}

function authorizationErrorRedirect(
  redirectUri: string,
  state: string | undefined,
  error: string,
  description: string,
): HttpResponseLike {
  const location = new URL(redirectUri);
  location.searchParams.set("error", error);
  location.searchParams.set("error_description", description);
  if (state !== undefined) {
    location.searchParams.set("state", state);
  }
  return {
    status: 302,
    headers: {
      location: location.toString(),
      "cache-control": "no-store",
      pragma: "no-cache",
      "referrer-policy": "no-referrer",
    },
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function randomSecret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function randomLoginCode(): string {
  let value = "";
  const bytes = randomBytes(20);
  for (const byte of bytes) {
    value += LOGIN_CODE_ALPHABET[byte % LOGIN_CODE_ALPHABET.length];
  }
  return value.match(/.{1,5}/g)?.join("-") ?? value;
}

function normalizeLoginCode(value: string): string {
  return value.replace(/[\s-]/g, "").toUpperCase();
}

function normalizeScopeList(value: string | undefined): string[] {
  return [...new Set((value ?? "").split(/\s+/).map((scope) => scope.trim()).filter(Boolean))];
}

function isLoopbackRedirect(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      LOOPBACK_HOSTS.has(url.hostname.toLowerCase()) &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.hash.length === 0
    );
  } catch {
    return false;
  }
}

function normalizedLoopbackRedirect(value: string): string | undefined {
  if (!isLoopbackRedirect(value)) {
    return undefined;
  }
  return new URL(value).toString();
}

function matchesResourceIndicator(value: string | null, expected: string): boolean {
  if (value === null) {
    return false;
  }
  try {
    const actual = new URL(value);
    const target = new URL(expected);
    return actual.hash.length === 0 && actual.href === target.href;
  } catch {
    return false;
  }
}

function scopeSetsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((scope) => right.includes(scope));
}

function pkceMatches(verifier: string, challenge: string): boolean {
  if (!PKCE_VERIFIER.test(verifier)) {
    return false;
  }
  const expected = createHash("sha256").update(verifier, "ascii").digest();
  const presented = Buffer.from(challenge, "base64url");
  return expected.length === presented.length && timingSafeEqual(expected, presented);
}

function validUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

export class SimpleOAuthAuthority {
  readonly issuer: string;
  readonly resourceUrl: string;
  readonly resourceMetadataUrl: string;
  readonly verifier: JwtVerifier;

  private readonly config: SimpleOAuthConfig;
  private readonly store: OAuthGrantStore;
  private readonly logger: RedactingLogger;
  private readonly now: () => number;
  private readonly keyRing: OAuthKeyRing;
  private readonly allowedScopeSet: ReadonlySet<string>;

  constructor(deps: SimpleOAuthDeps) {
    this.config = deps.config;
    this.store = deps.store;
    this.logger = deps.logger;
    this.now = deps.now ?? Date.now;
    this.issuer = deps.config.externalUrl.replace(/\/$/, "");
    this.resourceUrl = `${this.issuer}/mcp`;
    this.resourceMetadataUrl = `${this.issuer}/.well-known/oauth-protected-resource/mcp`;
    this.allowedScopeSet = new Set(deps.config.allowedScopes);
    this.keyRing = new OAuthKeyRing(
      deps.config.signingKeysBase64,
      this.issuer,
      this.resourceUrl,
      this.now,
    );
    this.verifier = this.keyRing;
    for (const key of deps.config.signingKeysBase64) {
      this.logger.registerSecret(key);
    }
  }

  private validateRequestedScopes(scopes: readonly string[]): boolean {
    return (
      scopes.length > 0 &&
      scopes.every(
        (scope) => scope === OFFLINE_ACCESS_SCOPE || this.allowedScopeSet.has(scope),
      )
    );
  }

  private async putGrant(
    kind: OAuthGrantKind,
    secret: string,
    payload: GrantPayload,
    expiresAt: number,
  ): Promise<void> {
    this.logger.registerSecret(secret);
    await this.store.put(kind, secret, {
      payload: this.keyRing.seal(payload as unknown as Record<string, unknown>),
      expiresAt,
    });
  }

  private async consumeGrant<T extends GrantPayload>(
    kind: OAuthGrantKind,
    secret: string,
    expectedType: T["typ"],
  ): Promise<T | undefined> {
    const grant = await this.store.consume(kind, secret);
    if (!grant) {
      return undefined;
    }
    try {
      const payload = this.keyRing.open<Record<string, unknown>>(grant.payload);
      return payload.typ === expectedType ? (payload as unknown as T) : undefined;
    } catch {
      return undefined;
    }
  }

  async issueLoginCode(input: IssueLoginCodeInput): Promise<IssuedLoginCode> {
    if (!validUuid(input.tenantId)) {
      throw new Error("OAuth login-code tenantId must be a UUID.");
    }

    if (
      this.config.allowedTenants.length > 0 &&
      !this.config.allowedTenants.includes(input.tenantId)
    ) {
      throw new Error("OAuth login-code tenantId is not in SQUAD_MCP_ALLOWED_TENANTS.");
    }
    const subject = input.subject.trim();
    if (subject.length === 0 || subject.length > 128) {
      throw new Error("OAuth login-code subject must contain 1-128 characters.");
    }
    const scopes = input.scopes ?? this.config.allowedScopes;
    if (
      scopes.length === 0 ||
      scopes.some((scope) => !this.allowedScopeSet.has(scope))
    ) {
      throw new Error("OAuth login-code scopes must be a non-empty subset of the allowed scopes.");
    }
    const ttlSeconds = input.ttlSeconds ?? Math.min(600, this.config.loginCodeMaxTtlSeconds);
    if (ttlSeconds < 60 || ttlSeconds > this.config.loginCodeMaxTtlSeconds) {
      throw new Error(
        `OAuth login-code ttlSeconds must be between 60 and ${this.config.loginCodeMaxTtlSeconds}.`,
      );
    }

    await this.store.sweepExpired(100);
    const code = randomLoginCode();
    const normalized = normalizeLoginCode(code);
    const expiresAt = this.now() + ttlSeconds * 1000;
    await this.putGrant(
      "login",
      normalized,
      {
        typ: "login",
        tenantId: input.tenantId,
        subject,
        scopes: [...new Set(scopes)],
      },
      expiresAt,
    );
    return {
      code,
      tenantId: input.tenantId,
      subject,
      scopes: [...new Set(scopes)],
      expiresAt,
      authorizationUrl: `${this.issuer}/oauth/authorize`,
    };
  }

  sweepExpired(limit = 500): Promise<number> {
    return this.store.sweepExpired(limit);
  }

  private resourceMetadata(): HttpResponseLike {
    return {
      status: 200,
      headers: jsonHeaders(),
      body: {
        resource: this.resourceUrl,
        authorization_servers: [this.issuer],
        scopes_supported: this.config.allowedScopes,
        bearer_methods_supported: ["header"],
      },
    };
  }

  private authorizationMetadata(): HttpResponseLike {
    return {
      status: 200,
      headers: jsonHeaders(),
      body: {
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}/oauth/authorize`,
        token_endpoint: `${this.issuer}/oauth/token`,
        registration_endpoint: `${this.issuer}/oauth/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: [...this.config.allowedScopes, OFFLINE_ACCESS_SCOPE],
      },
    };
  }

  private register(req: HttpRequestLike): HttpResponseLike {
    if (req.method !== "POST") {
      return { status: 405, headers: { ...jsonHeaders(), allow: "POST" } };
    }
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
      return oauthError(400, "invalid_client_metadata", "Registration body must be JSON.");
    }
    const input = req.body as Record<string, unknown>;
    if (
      input.token_endpoint_auth_method !== undefined &&
      input.token_endpoint_auth_method !== "none"
    ) {
      return oauthError(
        400,
        "invalid_client_metadata",
        "Only public clients with token_endpoint_auth_method=none are supported.",
      );
    }
    const redirectInputs = Array.isArray(input.redirect_uris) ? input.redirect_uris : [];
    if (
      redirectInputs.length === 0 ||
      redirectInputs.length > 10 ||
      redirectInputs.some((value) => typeof value !== "string")
    ) {
      return oauthError(
        400,
        "invalid_redirect_uri",
        "Provide between one and ten loopback redirect URIs.",
      );
    }
    const redirectUris = redirectInputs.map((value) =>
      normalizedLoopbackRedirect(value as string),
    );
    if (redirectUris.some((value) => value === undefined)) {
      return oauthError(
        400,
        "invalid_redirect_uri",
        "Redirect URIs must use HTTP on localhost, 127.0.0.1, or [::1].",
      );
    }
    const grantTypes = Array.isArray(input.grant_types)
      ? input.grant_types
      : ["authorization_code", "refresh_token"];
    const responseTypes = Array.isArray(input.response_types) ? input.response_types : ["code"];
    if (
      grantTypes.some(
        (value) => value !== "authorization_code" && value !== "refresh_token",
      ) ||
      responseTypes.some((value) => value !== "code")
    ) {
      return oauthError(
        400,
        "invalid_client_metadata",
        "Only authorization_code, refresh_token, and response_type=code are supported.",
      );
    }

    const nowSeconds = Math.floor(this.now() / 1000);
    const exp = this.now() + this.config.clientRegistrationTtlSeconds * 1000;
    const clientId = this.keyRing.signEnvelope({
      typ: "client",
      exp,
      redirectUris: redirectUris as string[],
    });
    return {
      status: 201,
      headers: jsonHeaders(),
      body: {
        client_id: clientId,
        client_id_issued_at: nowSeconds,
        client_id_expires_at: Math.floor(exp / 1000),
        redirect_uris: redirectUris,
        token_endpoint_auth_method: "none",
        grant_types: [...new Set(grantTypes)],
        response_types: ["code"],
      },
    };
  }

  private parseClient(clientId: string): RegisteredClientEnvelope | undefined {
    try {
      const client = this.keyRing.verifyEnvelope<RegisteredClientEnvelope>(clientId);
      return client.typ === "client" && Array.isArray(client.redirectUris) ? client : undefined;
    } catch {
      return undefined;
    }
  }

  private authorizationForm(requestEnvelope: string, scopes: readonly string[], error?: string): string {
    const errorBlock = error
      ? `<p role="alert" class="error">${escapeHtml(error)}</p>`
      : "";
    const scopeItems = scopes.map((scope) => `<li><code>${escapeHtml(scope)}</code></li>`).join("");
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize HVE Squad</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; background: #f5f7fa; color: #172033; }
    main { max-width: 34rem; margin: 8vh auto; padding: 2rem; background: white; border-radius: .75rem; box-shadow: 0 8px 30px #0002; }
    label { display: block; font-weight: 650; margin: 1.25rem 0 .4rem; }
    input { box-sizing: border-box; width: 100%; padding: .8rem; font: inherit; letter-spacing: .08em; }
    button { margin-top: 1rem; padding: .8rem 1rem; font: inherit; font-weight: 650; }
    .error { color: #a4262c; font-weight: 650; }
    .muted { color: #4d5870; }
  </style>
</head>
<body>
  <main>
    <h1>Authorize HVE Squad</h1>
    <p class="muted">Enter a single-use code issued by the deployment operator. The code is consumed after one attempt.</p>
    ${errorBlock}
    <p>Requested permissions:</p>
    <ul>${scopeItems}</ul>
    <form method="post" action="/oauth/authorize">
      <input type="hidden" name="request" value="${escapeHtml(requestEnvelope)}">
      <label for="login_code">Single-use login code</label>
      <input id="login_code" name="login_code" type="text" autocomplete="one-time-code" required maxlength="32" pattern="[A-Za-z0-9 -]+">
      <button type="submit">Authorize</button>
    </form>
  </main>
</body>
</html>`;
  }

  private authorizeGet(req: HttpRequestLike): HttpResponseLike {
    const query = new URLSearchParams(req.query ?? "");
    const clientId = query.get("client_id") ?? "";
    const client = this.parseClient(clientId);
    if (!client) {
      return oauthError(400, "invalid_request", "Unknown or expired client_id.");
    }
    const redirectUri = normalizedLoopbackRedirect(query.get("redirect_uri") ?? "");
    if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
      return oauthError(400, "invalid_request", "redirect_uri is not registered for this client.");
    }
    const rawState = query.get("state") ?? undefined;
    const state = rawState !== undefined && rawState.length <= 1024 ? rawState : undefined;
    if (rawState !== undefined && state === undefined) {
      return authorizationErrorRedirect(
        redirectUri,
        undefined,
        "invalid_request",
        "state exceeds 1024 characters.",
      );
    }
    if (query.get("response_type") !== "code") {
      return authorizationErrorRedirect(
        redirectUri,
        state,
        "unsupported_response_type",
        "Only response_type=code is supported.",
      );
    }
    if (!matchesResourceIndicator(query.get("resource"), this.resourceUrl)) {
      return authorizationErrorRedirect(
        redirectUri,
        state,
        "invalid_target",
        "The resource parameter must identify this MCP server.",
      );
    }
    const codeChallenge = query.get("code_challenge") ?? "";
    if (
      query.get("code_challenge_method") !== "S256" ||
      !/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge)
    ) {
      return authorizationErrorRedirect(
        redirectUri,
        state,
        "invalid_request",
        "PKCE with code_challenge_method=S256 is required.",
      );
    }
    const requested = normalizeScopeList(query.get("scope") ?? "");
    if (!this.validateRequestedScopes(requested)) {
      return authorizationErrorRedirect(
        redirectUri,
        state,
        "invalid_scope",
        "One or more requested scopes are not allowed.",
      );
    }
    const offlineAccess = requested.includes(OFFLINE_ACCESS_SCOPE);
    const scopes = requested.filter((scope) => scope !== OFFLINE_ACCESS_SCOPE);
    if (scopes.length === 0) {
      return authorizationErrorRedirect(
        redirectUri,
        state,
        "invalid_scope",
        "At least one HVE Squad scope is required.",
      );
    }
    const envelope = this.keyRing.signEnvelope({
      typ: "authorization-request",
      exp: this.now() + 10 * 60 * 1000,
      clientId,
      redirectUri,
      scopes,
      offlineAccess,
      codeChallenge,
      ...(state === undefined ? {} : { state }),
    });
    return {
      status: 200,
      headers: htmlHeaders(),
      body: this.authorizationForm(envelope, scopes),
    };
  }

  private async authorizePost(req: HttpRequestLike): Promise<HttpResponseLike> {
    if (typeof req.body !== "string") {
      return oauthError(400, "invalid_request", "Authorization form body is required.");
    }
    const form = new URLSearchParams(req.body);
    const requestEnvelope = form.get("request") ?? "";
    let request: AuthorizationRequestEnvelope;
    try {
      request = this.keyRing.verifyEnvelope<AuthorizationRequestEnvelope>(requestEnvelope);
      if (request.typ !== "authorization-request") {
        throw new Error("wrong envelope type");
      }
    } catch {
      return oauthError(400, "invalid_request", "Authorization request expired or is invalid.");
    }

    const loginCode = normalizeLoginCode(form.get("login_code") ?? "");
    const login = await this.consumeGrant<LoginGrantPayload>("login", loginCode, "login");
    if (!login) {
      return {
        status: 401,
        headers: htmlHeaders(),
        body: this.authorizationForm(
          requestEnvelope,
          request.scopes,
          "The login code is invalid, expired, or already used.",
        ),
      };
    }
    if (request.scopes.some((scope) => !login.scopes.includes(scope))) {
      return authorizationErrorRedirect(
        request.redirectUri,
        request.state,
        "access_denied",
        "The login code does not grant every requested scope.",
      );
    }

    const code = randomSecret();
    const expiresAt = this.now() + this.config.authorizationCodeTtlSeconds * 1000;
    await this.putGrant(
      "authorization",
      code,
      {
        typ: "authorization",
        tenantId: login.tenantId,
        subject: login.subject,
        scopes: request.scopes,
        offlineAccess: request.offlineAccess,
        clientId: request.clientId,
        redirectUri: request.redirectUri,
        codeChallenge: request.codeChallenge,
      },
      expiresAt,
    );
    const location = new URL(request.redirectUri);
    location.searchParams.set("code", code);
    if (request.state !== undefined) {
      location.searchParams.set("state", request.state);
    }
    return {
      status: 302,
      headers: {
        location: location.toString(),
        "cache-control": "no-store",
        pragma: "no-cache",
        "referrer-policy": "no-referrer",
      },
    };
  }

  private async issueAccessTokenResponse(
    grant: Pick<AuthorizationGrantPayload, "tenantId" | "subject" | "scopes" | "clientId">,
    refreshToken?: string,
  ): Promise<HttpResponseLike> {
    const accessToken = await this.keyRing.issueAccessToken({
      tenantId: grant.tenantId,
      subject: grant.subject,
      scopes: grant.scopes,
      clientId: grant.clientId,
      ttlSeconds: this.config.accessTokenTtlSeconds,
    });
    this.logger.registerSecret(accessToken);

    return {
      status: 200,
      headers: jsonHeaders(),
      body: {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: this.config.accessTokenTtlSeconds,
        scope: grant.scopes.join(" "),
        ...(refreshToken === undefined ? {} : { refresh_token: refreshToken }),
      },
    };
  }

  private async issueInitialTokenResponse(
    grant: AuthorizationGrantPayload,
  ): Promise<HttpResponseLike> {
    if (!grant.offlineAccess) {
      return this.issueAccessTokenResponse(grant);
    }
    const familyId = randomSecret();
    const familyExpiresAt = this.now() + this.config.refreshTokenTtlSeconds * 1000;
    const refreshToken = randomSecret(48);
    await this.putGrant(
      "refresh-family",
      familyId,
      { typ: "refresh-family", generation: 0, revoked: false },
      familyExpiresAt,
    );
    await this.putGrant(
      "refresh",
      refreshToken,
      {
        typ: "refresh",
        tenantId: grant.tenantId,
        subject: grant.subject,
        scopes: grant.scopes,
        clientId: grant.clientId,
        familyId,
        generation: 0,
        familyExpiresAt,
      },
      familyExpiresAt,
    );
    return this.issueAccessTokenResponse(grant, refreshToken);
  }

  private async revokeRefreshFamily(familyId: string): Promise<void> {
    await this.store.update("refresh-family", familyId, (stored) => {
      const family = this.keyRing.open<Record<string, unknown>>(stored.payload);
      if (family.typ !== "refresh-family") {
        return undefined;
      }
      return {
        payload: this.keyRing.seal({
          typ: "refresh-family",
          generation: Number(family.generation),
          revoked: true,
        }),
        expiresAt: stored.expiresAt,
      };
    });
  }

  private async consumeRefreshToken(
    refreshToken: string,
  ): Promise<RefreshGrantPayload | undefined> {
    let activeGrant: RefreshGrantPayload | undefined;
    const result = await this.store.consumeWithTombstone(
      "refresh",
      refreshToken,
      (stored) => {
        const payload = this.keyRing.open<Record<string, unknown>>(stored.payload);
        if (payload.typ !== "refresh") {
          throw new Error("OAuth refresh record has the wrong type.");
        }
        activeGrant = payload as unknown as RefreshGrantPayload;
        return {
          payload: this.keyRing.seal({
            typ: "refresh-replay",
            familyId: activeGrant.familyId,
          }),
          expiresAt: activeGrant.familyExpiresAt,
        };
      },
    );
    if (!result) {
      return undefined;
    }
    if (result.status === "replayed") {
      const replay = this.keyRing.open<Record<string, unknown>>(result.tombstone.payload);
      if (replay.typ === "refresh-replay") {
        await this.revokeRefreshFamily(String(replay.familyId ?? ""));
      }
      return undefined;
    }
    return activeGrant;
  }

  private async rotateRefreshToken(
    grant: RefreshGrantPayload,
    scopes: string[],
  ): Promise<HttpResponseLike> {
    const generation = grant.generation + 1;
    const familyUpdate = await this.store.update(
      "refresh-family",
      grant.familyId,
      (stored) => {
        const family = this.keyRing.open<Record<string, unknown>>(stored.payload);
        if (
          family.typ !== "refresh-family" ||
          family.revoked === true ||
          Number(family.generation) !== grant.generation
        ) {
          return undefined;
        }
        return {
          payload: this.keyRing.seal({
            typ: "refresh-family",
            generation,
            revoked: false,
          }),
          expiresAt: stored.expiresAt,
        };
      },
    );
    if (familyUpdate !== "updated") {
      return oauthError(400, "invalid_grant", "Refresh-token family is revoked.");
    }
    const refreshToken = randomSecret(48);
    await this.putGrant(
      "refresh",
      refreshToken,
      { ...grant, scopes, generation },
      grant.familyExpiresAt,
    );
    return this.issueAccessTokenResponse({ ...grant, scopes }, refreshToken);
  }

  private async token(req: HttpRequestLike): Promise<HttpResponseLike> {
    if (req.method !== "POST") {
      return { status: 405, headers: { ...jsonHeaders(), allow: "POST" } };
    }
    if (typeof req.body !== "string") {
      return oauthError(400, "invalid_request", "Token request must be form-urlencoded.");
    }
    const form = new URLSearchParams(req.body);
    if (
      form.has("client_secret") ||
      form.has("client_assertion") ||
      form.has("client_assertion_type")
    ) {
      return oauthError(400, "invalid_client", "This endpoint accepts public clients only.");
    }
    const clientId = form.get("client_id") ?? "";
    if (!this.parseClient(clientId)) {
      return oauthError(401, "invalid_client", "Unknown or expired client_id.");
    }
    const grantType = form.get("grant_type");
    if (!matchesResourceIndicator(form.get("resource"), this.resourceUrl)) {
      return oauthError(
        400,
        "invalid_target",
        "The resource parameter must identify this MCP server.",
      );
    }

    if (grantType === "authorization_code") {
      const code = form.get("code") ?? "";
      const grant = await this.consumeGrant<AuthorizationGrantPayload>(
        "authorization",
        code,
        "authorization",
      );
      if (!grant) {
        return oauthError(400, "invalid_grant", "Authorization code is invalid or already used.");
      }
      const redirectUri = normalizedLoopbackRedirect(form.get("redirect_uri") ?? "");
      const verifier = form.get("code_verifier") ?? "";
      const requestedScopes = normalizeScopeList(form.get("scope") ?? "");
      if (
        grant.clientId !== clientId ||
        grant.redirectUri !== redirectUri ||
        !pkceMatches(verifier, grant.codeChallenge) ||
        (requestedScopes.length > 0 && !scopeSetsEqual(requestedScopes, grant.scopes))
      ) {
        return oauthError(400, "invalid_grant", "Authorization code binding failed.");
      }
      return this.issueInitialTokenResponse(grant);
    }

    if (grantType === "refresh_token") {
      const refreshToken = form.get("refresh_token") ?? "";
      const grant = await this.consumeRefreshToken(refreshToken);
      if (!grant) {
        return oauthError(400, "invalid_grant", "Refresh token is invalid or already used.");
      }
      if (grant.clientId !== clientId) {
        await this.revokeRefreshFamily(grant.familyId);
        return oauthError(400, "invalid_grant", "Refresh token client binding failed.");
      }
      const requested = normalizeScopeList(form.get("scope") ?? "");
      if (
        requested.includes(OFFLINE_ACCESS_SCOPE) ||
        requested.some((scope) => !grant.scopes.includes(scope))
      ) {
        await this.revokeRefreshFamily(grant.familyId);
        return oauthError(400, "invalid_scope", "Refresh scope exceeds the original grant.");
      }
      const scopes = requested.length > 0 ? requested : grant.scopes;
      return this.rotateRefreshToken(grant, scopes);
    }

    return oauthError(
      400,
      "unsupported_grant_type",
      "Only authorization_code and refresh_token are supported.",
    );
  }

  async handle(req: HttpRequestLike): Promise<HttpResponseLike | undefined> {
    if (
      req.path === "/.well-known/oauth-protected-resource" ||
      req.path === "/.well-known/oauth-protected-resource/mcp"
    ) {
      return req.method === "GET"
        ? this.resourceMetadata()
        : { status: 405, headers: { ...jsonHeaders(), allow: "GET" } };
    }
    if (req.path === "/.well-known/oauth-authorization-server") {
      return req.method === "GET"
        ? this.authorizationMetadata()
        : { status: 405, headers: { ...jsonHeaders(), allow: "GET" } };
    }
    if (req.path === "/oauth/register") {
      return this.register(req);
    }
    if (req.path === "/oauth/authorize") {
      if (req.method === "GET") {
        return this.authorizeGet(req);
      }
      if (req.method === "POST") {
        return this.authorizePost(req);
      }
      return { status: 405, headers: { ...jsonHeaders(), allow: "GET, POST" } };
    }
    if (req.path === "/oauth/token") {
      return this.token(req);
    }
    return undefined;
  }
}

/** Wrapper that serves public OAuth routes and delegates everything else to MCP. */
export class SimpleOAuthHttpHandler {
  constructor(
    private readonly oauth: SimpleOAuthAuthority,
    private readonly next: { handle(req: HttpRequestLike): Promise<HttpResponseLike> },
    private readonly logger: RedactingLogger,
  ) {}

  async handle(req: HttpRequestLike): Promise<HttpResponseLike> {
    try {
      const response = await this.oauth.handle(req);
      if (response) {
        return response;
      }
    } catch (error) {
      this.logger.error("simple OAuth request failed", {
        path: req.path,
        error: String(error),
      });
      return {
        status: 503,
        headers: jsonHeaders(),
        body: {
          error: "temporarily_unavailable",
          error_description: "The authorization service is temporarily unavailable.",
        },
      };
    }
    return this.next.handle(req);
  }
}
