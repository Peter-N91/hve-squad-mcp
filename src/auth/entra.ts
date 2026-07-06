/**
 * Entra ID / OAuth authentication + authorization (SEC-1, SEC-2, SEC-3, SEC-10).
 *
 * Attached to the HTTP path only (stdio inherits the local user's trust and is
 * outside the remote trust boundary). Responsibilities:
 *
 *   * SEC-1 — no anonymous `/mcp`. Every request must carry a `Bearer` token
 *     whose signature, issuer, and expiry validate AND whose audience is bound
 *     to THIS resource server (RFC 8707 resource indicator). Tokens minted for
 *     another audience (pass-through / confused-deputy tokens) are rejected.
 *   * SEC-2 — per-tool scope authorization. `authorizeTool` denies a tool call
 *     unless the token carries that tool's required scope.
 *   * SEC-3 — tenant resolution. The resolved tenant/identity is the single root
 *     for all downstream authorization in the embedded engine; no ambient server
 *     identity satisfies a caller request.
 *   * SEC-10 — the raw token is registered with the logger for redaction and is
 *     NEVER logged or surfaced; failure reasons never echo the token or claims.
 *
 * The cryptographic verification (signature + issuer + expiry) is delegated to a
 * pluggable {@link JwtVerifier} so this authorization logic is unit-testable
 * without a live Entra endpoint or a real signed token. The production verifier
 * (`jose-verifier.ts`) is wired only by the live HTTP bootstrap.
 */
import { requiredScopeFor, OPERATOR_APPROVAL_SCOPE } from "./scopes.js";
import type { RedactingLogger } from "../observability/logger.js";

/** The subset of JWT claims the authenticator reasons about. */
export interface JwtClaims {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  /** Entra tenant id. */
  tid?: string;
  sub?: string;
  /** Entra object id. */
  oid?: string;
  /** Space-delimited delegated scopes. */
  scp?: string;
  /** App roles (application permissions). */
  roles?: string[];
  appid?: string;
  [key: string]: unknown;
}

/**
 * Verifies a token's signature, issuer, and expiry and returns its claims.
 * Throws on any cryptographic or temporal failure. Audience, tenant, and scope
 * checks are intentionally NOT done here — the authenticator owns authorization.
 */
export interface JwtVerifier {
  verify(token: string): Promise<JwtClaims>;
}

/** The resolved caller identity — the single root for downstream authorization (SEC-3). */
export interface AuthContext {
  /** The caller's Entra tenant id (SEC-3 identity root). */
  tenantId: string;
  /** A stable subject identifier (oid or sub). */
  subject: string;
  /** The granted scopes parsed from the token. */
  scopes: string[];
  /** The audience the token was bound to (this resource server). */
  audience: string;
}

/** A failed authentication/authorization, carrying the HTTP status to return. */
export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403,
    readonly reason: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export interface EntraAuthenticatorOptions {
  /** The expected audience (this resource server; SEC-1, RFC 8707). */
  audience: string;
  /** Permitted issuers; empty = accept any issuer the verifier already validated. */
  allowedIssuers?: string[];
  /** Permitted tenants; empty = any tenant whose token validates. */
  allowedTenants?: string[];
  /** The cryptographic verifier (signature + issuer + expiry). */
  verifier: JwtVerifier;
  /** Logger used to register the token as a secret (SEC-10). */
  logger: RedactingLogger;
}

function audienceMatches(aud: string | string[] | undefined, expected: string): boolean {
  if (typeof aud === "string") {
    return aud === expected;
  }
  if (Array.isArray(aud)) {
    return aud.includes(expected);
  }
  return false;
}

function parseScopes(claims: JwtClaims): string[] {
  const scopes = new Set<string>();
  if (typeof claims.scp === "string") {
    for (const scope of claims.scp.split(/\s+/)) {
      if (scope.length > 0) {
        scopes.add(scope);
      }
    }
  }
  if (Array.isArray(claims.roles)) {
    for (const role of claims.roles) {
      if (typeof role === "string" && role.length > 0) {
        scopes.add(role);
      }
    }
  }
  return [...scopes];
}

/** Extract the bearer token from an `Authorization` header value. */
export function extractBearerToken(authorizationHeader: string | undefined): string | undefined {
  if (!authorizationHeader) {
    return undefined;
  }
  const match = authorizationHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : undefined;
}

/** Authenticates and authorizes remote callers against Entra/OAuth tokens. */
export class EntraAuthenticator {
  private readonly audience: string;
  private readonly allowedIssuers: Set<string>;
  private readonly allowedTenants: Set<string>;
  private readonly verifier: JwtVerifier;
  private readonly logger: RedactingLogger;

  constructor(options: EntraAuthenticatorOptions) {
    this.audience = options.audience;
    this.allowedIssuers = new Set(options.allowedIssuers ?? []);
    this.allowedTenants = new Set(options.allowedTenants ?? []);
    this.verifier = options.verifier;
    this.logger = options.logger;
  }

  /**
   * Authenticate one request. On success returns the resolved {@link AuthContext};
   * on any failure throws {@link AuthError} with the HTTP status. The token is
   * registered as a secret BEFORE any other work so it can never be logged
   * (SEC-10), and failure paths never include the token or claim values.
   */
  async authenticate(authorizationHeader: string | undefined): Promise<AuthContext> {
    const token = extractBearerToken(authorizationHeader);
    if (!token) {
      // SEC-1: no anonymous access.
      throw new AuthError("Missing bearer token.", 401, "missing_token");
    }
    // SEC-10: register the raw token so it is redacted everywhere, immediately.
    this.logger.registerSecret(token);

    let claims: JwtClaims;
    try {
      claims = await this.verifier.verify(token);
    } catch {
      // Never echo the token or the underlying crypto error detail.
      throw new AuthError("Token verification failed.", 401, "invalid_token");
    }

    // SEC-1: audience must be bound to THIS resource server (RFC 8707). A token
    // minted for a different resource (pass-through) is rejected outright.
    if (!audienceMatches(claims.aud, this.audience)) {
      throw new AuthError("Token audience is not bound to this resource.", 401, "wrong_audience");
    }

    if (this.allowedIssuers.size > 0 && (typeof claims.iss !== "string" || !this.allowedIssuers.has(claims.iss))) {
      throw new AuthError("Token issuer is not allowed.", 401, "untrusted_issuer");
    }

    // SEC-3: resolve the tenant — the single identity root for downstream auth.
    const tenantId = typeof claims.tid === "string" ? claims.tid : "";
    if (tenantId.length === 0) {
      throw new AuthError("Token has no tenant claim.", 401, "no_tenant");
    }
    if (this.allowedTenants.size > 0 && !this.allowedTenants.has(tenantId)) {
      throw new AuthError("Tenant is not permitted.", 403, "tenant_not_allowed");
    }

    const subject =
      (typeof claims.oid === "string" && claims.oid) ||
      (typeof claims.sub === "string" && claims.sub) ||
      "";
    if (subject.length === 0) {
      throw new AuthError("Token has no subject.", 401, "no_subject");
    }

    return {
      tenantId,
      subject,
      scopes: parseScopes(claims),
      audience: this.audience,
    };
  }

  /**
   * Authorize a specific tool call (SEC-2). Throws {@link AuthError} 403 when the
   * caller's token lacks the tool's required scope. `request`/`context` inputs
   * cannot influence this decision — the required scope is fixed per tool.
   */
  authorizeTool(context: AuthContext, toolId: string): void {
    const scope = requiredScopeFor(toolId);
    if (!scope) {
      throw new AuthError(`Unknown tool: ${toolId}`, 403, "unknown_tool");
    }
    if (!context.scopes.includes(scope)) {
      throw new AuthError(`Missing required scope for ${toolId}.`, 403, "missing_scope");
    }
  }

  /**
   * Authorize an out-of-band operator approval (the `/admin/approve` route). Throws
   * {@link AuthError} 403 unless the caller's token carries the distinct
   * high-privilege {@link OPERATOR_APPROVAL_SCOPE} — deliberately NOT `Squad.Run`,
   * so a caller that may start or poll a run cannot release its Human Gate. Like
   * {@link authorizeTool}, no `request`/`context` input can influence this: the
   * required scope is fixed, and this method is only reached from the admin route,
   * never from a `tools/call` or model output (SEC-6).
   */
  authorizeApproval(context: AuthContext): void {
    if (!context.scopes.includes(OPERATOR_APPROVAL_SCOPE)) {
      throw new AuthError("Missing operator approval scope.", 403, "missing_operator_scope");
    }
  }
}
