/**
 * Entra browser re-authentication (OIDC authorization code + PKCE).
 *
 * Purpose: prove that the human holding the browser is the SAME Entra user
 * ({tenantId, oid}) that the MCP caller token resolved to, before any GitHub
 * credential is attached to that principal. Only the id_token is used; the Entra
 * access token returned by the token endpoint is ignored and never stored.
 *
 * The id_token is verified by an injected {@link JwtVerifier} (production:
 * createJoseVerifier against the tenant JWKS; tests: a local jose key). The
 * verifier owns signature, issuer and expiry; this class owns audience, nonce,
 * tid and oid. `sub` is pairwise per app and is never used.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { JwtClaims, JwtVerifier, UserPrincipal } from "../auth/entra.js";
import { GitHubLinkError } from "./types.js";
import { secureEndpoint } from "./url-policy.js";

export interface EntraBrowserSignInOptions {
  /** e.g. https://login.microsoftonline.com/<tenant>/oauth2/v2.0/authorize */
  authorizeEndpoint: string;
  /** e.g. https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token */
  tokenEndpoint: string;
  clientId: string;
  /** Exactly one of clientSecret / clientAssertion. */
  clientSecret?: string;
  /** Returns a fresh signed client assertion JWT (federated managed identity). */
  clientAssertion?: () => Promise<string>;
  verifier: JwtVerifier;
  /** Default "openid profile": profile supplies the immutable oid. No resource access is needed. */
  scope?: string;
  /** Default "login": force a fresh credential check so a stale browser session cannot be reused. */
  prompt?: "login" | "select_account" | "none";
  /** Restrict to these tenants. Omit only for a deliberately multi-tenant app. */
  allowedTenantIds?: readonly string[];
  /** Optional issuer pin, e.g. (tid) => `https://login.microsoftonline.com/${tid}/v2.0`. */
  issuerForTenant?: (tenantId: string) => string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface EntraAuthorizeParams {
  state: string;
  nonce: string;
  codeChallenge: string;
  redirectUri: string;
}

export interface EntraCompleteParams {
  code: string;
  codeVerifier: string;
  nonce: string;
  redirectUri: string;
}

export interface EntraSignInPort {
  readonly authorizeOrigin: string;
  buildAuthorizeUrl(params: EntraAuthorizeParams): string;
  completeSignIn(params: EntraCompleteParams): Promise<UserPrincipal>;
}

const ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

export function newPkce(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier, "utf8").digest("base64url");
  return { codeVerifier, codeChallenge };
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function invalid(message: string): GitHubLinkError {
  return new GitHubLinkError("github_link_state_invalid", message);
}

export class EntraBrowserSignIn implements EntraSignInPort {
  readonly authorizeOrigin: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: EntraBrowserSignInOptions) {
    if (Boolean(options.clientSecret) === Boolean(options.clientAssertion)) {
      throw new Error("EntraBrowserSignIn requires exactly one of clientSecret or clientAssertion.");
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.authorizeOrigin = new URL(secureEndpoint(options.authorizeEndpoint)).origin;
    secureEndpoint(options.tokenEndpoint);
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 120_000) throw new Error("Invalid Entra sign-in timeout.");
  }

  buildAuthorizeUrl(params: EntraAuthorizeParams): string {
    const url = new URL(this.options.authorizeEndpoint);
    url.searchParams.set("client_id", this.options.clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", params.redirectUri);
    url.searchParams.set("response_mode", "query");
    url.searchParams.set("scope", this.options.scope ?? "openid profile");
    url.searchParams.set("state", params.state);
    url.searchParams.set("nonce", params.nonce);
    url.searchParams.set("code_challenge", params.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("prompt", this.options.prompt ?? "login");
    return url.toString();
  }

  async completeSignIn(params: EntraCompleteParams): Promise<UserPrincipal> {
    const form = new URLSearchParams({
      client_id: this.options.clientId,
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: params.redirectUri,
      code_verifier: params.codeVerifier,
      scope: this.options.scope ?? "openid profile",
    });
    if (this.options.clientAssertion) {
      form.set("client_assertion_type", ASSERTION_TYPE);
      try { form.set("client_assertion", await this.options.clientAssertion()); }
      catch { throw invalid("Entra sign-in could not be completed."); }
    } else {
      form.set("client_secret", this.options.clientSecret as string);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(this.options.tokenEndpoint, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw invalid("Entra sign-in could not be completed.");
    }
    let body: { id_token?: unknown } | undefined;
    try {
      body = (await response.json()) as { id_token?: unknown };
    } catch {
      body = undefined;
    }
    if (!response.ok || typeof body?.id_token !== "string" || !body.id_token) {
      throw invalid("Entra sign-in was rejected.");
    }

    let claims: JwtClaims;
    try {
      claims = await this.options.verifier.verify(body.id_token);
    } catch {
      throw invalid("Entra id_token verification failed.");
    }

    const audiences = Array.isArray(claims.aud) ? claims.aud : claims.aud === undefined ? [] : [claims.aud];
    if (audiences.length !== 1 || audiences[0] !== this.options.clientId) {
      throw invalid("Entra id_token audience mismatch.");
    }
    if (typeof claims.nonce !== "string" || !constantTimeEqual(claims.nonce, params.nonce)) {
      throw invalid("Entra id_token nonce mismatch.");
    }
    const tenantId = claims.tid;
    const objectId = claims.oid;
    if (typeof tenantId !== "string" || !tenantId || typeof objectId !== "string" || !objectId) {
      throw invalid("Entra id_token is missing tid or oid.");
    }
    if (this.options.allowedTenantIds && !this.options.allowedTenantIds.includes(tenantId)) {
      throw invalid("Entra tenant is not allowed.");
    }
    if (this.options.issuerForTenant && claims.iss !== this.options.issuerForTenant(tenantId)) {
      throw invalid("Entra id_token issuer mismatch.");
    }
    return { tenantId, objectId };
  }
}
