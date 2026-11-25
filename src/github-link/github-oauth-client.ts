/**
 * GitHub web application flow client (GitHub App user tokens and OAuth app tokens).
 *
 * Verified against official GitHub docs on 2026-10-17:
 *  - https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app
 *    GET  https://github.com/login/oauth/authorize (client_id, redirect_uri, state, code_challenge +
 *    code_challenge_method=S256, allow_signup). POST https://github.com/login/oauth/access_token
 *    (client_id, client_secret, code, redirect_uri, code_verifier). Response: access_token (ghu_),
 *    expires_in (always 28800 = 8h, omitted for non-expiring tokens), refresh_token (ghr_),
 *    refresh_token_expires_in (always 15897600 = 6 months), scope (always ""), token_type bearer.
 *    The `scope` parameter grants nothing to a GitHub App; the only supported value is
 *    `offline_access`, which forces an expiring token.
 *  - https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens
 *    POST https://github.com/login/oauth/access_token with grant_type=refresh_token, refresh_token,
 *    client_id, client_secret. "Once you use a refresh token, that refresh token and the old user
 *    access token will no longer work." => REFRESH TOKENS ROTATE. A lost response or two concurrent
 *    refreshes can permanently break the link, so callers MUST serialise refreshes and persist the
 *    new pair before use (see GitHubLinkService.tokenFor). Revocation of an app token:
 *    DELETE /applications/{client_id}/token.
 *  - https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
 *    Same endpoints for OAuth apps; the code expires after 10 minutes; OAuth app tokens (gho_) do
 *    not expire unless the app opted in to expiring tokens.
 *  - https://docs.github.com/en/apps/oauth-apps/maintaining-oauth-apps/troubleshooting-oauth-app-access-token-request-errors
 *    Errors (incorrect_client_credentials, redirect_uri_mismatch, bad_verification_code,
 *    unverified_user_email) are returned as a JSON body whose format follows the Accept header.
 *    The docs do not state the HTTP status. GitHub is widely reported to answer these with HTTP 200
 *    and an `{error: ...}` body (NOT verified in the docs), so this client treats an `error` field as
 *    failure regardless of status.
 *    NOT in the docs I fetched: the `bad_refresh_token` error name for a dead refresh token. It is
 *    GitHub's observed value and is mapped (with invalid_grant) to "invalid_grant" below.
 *  - https://docs.github.com/en/copilot/how-tos/copilot-sdk/setup/github-oauth
 *    The Copilot SDK accepts a per-user gho_ or ghu_ token. No OAuth scope is documented there for
 *    Copilot entitlement; `scopes` is therefore configurable and defaults to none.
 *
 * Error text from GitHub (error_description, bodies) is never copied into thrown errors or logs.
 */
import type { GitHubOAuthPort, GitHubTokenKind, GitHubTokenSet, GitHubUser } from "./types.js";
import { GitHubOAuthError } from "./types.js";
import { secureEndpoint } from "./url-policy.js";

export interface GitHubOAuthClientOptions {
  clientId: string;
  clientSecret: string;
  /** Default https://github.com (GitHub Enterprise Server: https://ghe.example.com). */
  webBaseUrl?: string;
  /** Default https://api.github.com. */
  apiBaseUrl?: string;
  /** Sent as `scope`. For GitHub Apps only `offline_access` is meaningful. */
  scopes?: readonly string[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  userAgent?: string;
}

const DEAD_CREDENTIAL_ERRORS = new Set(["bad_verification_code", "bad_refresh_token", "invalid_grant", "expired_token"]);
const CONFIGURATION_ERRORS = new Set([
  "incorrect_client_credentials",
  "redirect_uri_mismatch",
  "invalid_client",
  "unauthorized_client",
  "unsupported_grant_type",
]);
const TRANSIENT_ERRORS = new Set(["temporarily_unavailable", "server_error", "slow_down", "rate_limited"]);

function tokenKindOf(accessToken: string): GitHubTokenKind {
  if (accessToken.startsWith("ghu_")) return "ghu";
  if (accessToken.startsWith("gho_")) return "gho";
  return "other";
}

export class GitHubOAuthClient implements GitHubOAuthPort {
  private readonly webBase: string;
  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly userAgent: string;

  constructor(private readonly options: GitHubOAuthClientOptions) {
    if (!options.clientId || !options.clientSecret) {
      throw new Error("GitHubOAuthClient requires clientId and clientSecret.");
    }
    this.webBase = secureEndpoint(options.webBaseUrl ?? "https://github.com");
    this.apiBase = secureEndpoint(options.apiBaseUrl ?? "https://api.github.com");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 120_000) throw new Error("Invalid GitHub OAuth timeout.");
    this.userAgent = options.userAgent ?? "hve-squad-mcp-github-link";
  }

  buildAuthorizeUrl(state: string, redirectUri: string, pkce?: { codeChallenge: string }): string {
    const url = new URL(`${this.webBase}/login/oauth/authorize`);
    url.searchParams.set("client_id", this.options.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("allow_signup", "false");
    if (this.options.scopes && this.options.scopes.length > 0) {
      url.searchParams.set("scope", this.options.scopes.join(" "));
    }
    if (pkce) {
      url.searchParams.set("code_challenge", pkce.codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
    }
    return url.toString();
  }

  async exchangeCode(code: string, redirectUri: string, pkce?: { codeVerifier: string }): Promise<GitHubTokenSet> {
    const form: Record<string, string> = {
      client_id: this.options.clientId,
      client_secret: this.options.clientSecret,
      code,
      redirect_uri: redirectUri,
    };
    if (pkce) {
      form.code_verifier = pkce.codeVerifier;
    }
    return this.tokenRequest(form);
  }

  async refresh(refreshToken: string): Promise<GitHubTokenSet> {
    return this.tokenRequest({
      client_id: this.options.clientId,
      client_secret: this.options.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
  }

  async getUser(accessToken: string): Promise<GitHubUser> {
    const response = await this.send(`${this.apiBase}/user`, {
      method: "GET",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${accessToken}`,
        "x-github-api-version": "2022-11-28",
      },
    });
    if (response.status === 401) {
      throw new GitHubOAuthError("invalid_grant", "bad_credentials");
    }
    const body = await this.readJson(response);
    if (!response.ok) {
      throw new GitHubOAuthError(response.status >= 500 || response.status === 429 ? "transient" : "other");
    }
    const id = (body as { id?: unknown } | undefined)?.id;
    const login = (body as { login?: unknown } | undefined)?.login;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0 || typeof login !== "string" || !login) {
      throw new GitHubOAuthError("other", "invalid_user_response");
    }
    return { id, login };
  }

  /** Best-effort revocation of an app user token (DELETE /applications/{client_id}/token). */
  async revoke(accessToken: string): Promise<void> {
    const basic = Buffer.from(`${this.options.clientId}:${this.options.clientSecret}`, "utf8").toString("base64");
    const response = await this.send(`${this.apiBase}/applications/${encodeURIComponent(this.options.clientId)}/token`, {
      method: "DELETE",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Basic ${basic}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify({ access_token: accessToken }),
    });
    await response.arrayBuffer().catch(() => undefined);
    if (!response.ok && response.status !== 404 && response.status !== 422) {
      throw new GitHubOAuthError(response.status >= 500 ? "transient" : "other");
    }
  }

  private async tokenRequest(form: Record<string, string>): Promise<GitHubTokenSet> {
    const response = await this.send(`${this.webBase}/login/oauth/access_token`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
    });
    const body = await this.readJson(response);
    if (response.status >= 500 || response.status === 429) {
      throw new GitHubOAuthError("transient");
    }
    // GitHub reports most failures as HTTP 200 with {error: ...}.
    const errorCode = typeof body?.error === "string" ? body.error : undefined;
    if (errorCode !== undefined) {
      const safe = /^[a-z_]{1,64}$/.test(errorCode) ? errorCode : undefined;
      if (safe && DEAD_CREDENTIAL_ERRORS.has(safe)) throw new GitHubOAuthError("invalid_grant", safe);
      if (safe && CONFIGURATION_ERRORS.has(safe)) throw new GitHubOAuthError("configuration", safe);
      if (safe && TRANSIENT_ERRORS.has(safe)) throw new GitHubOAuthError("transient", safe);
      throw new GitHubOAuthError("other");
    }
    if (!response.ok) {
      throw new GitHubOAuthError("other");
    }
    const accessToken = body?.access_token;
    if (typeof accessToken !== "string" || accessToken.length === 0) {
      throw new GitHubOAuthError("other", "missing_access_token");
    }
    const refreshToken = typeof body?.refresh_token === "string" && body.refresh_token ? body.refresh_token : undefined;
    return {
      accessToken,
      tokenKind: tokenKindOf(accessToken),
      expiresInSeconds: positiveInt(body?.expires_in),
      refreshToken,
      refreshExpiresInSeconds: refreshToken ? positiveInt(body?.refresh_token_expires_in) : undefined,
    };
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, {
        ...init,
        headers: { "user-agent": this.userAgent, ...(init.headers as Record<string, string>) },
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      // Network error or timeout: the outcome at GitHub is unknown. Never include the cause text.
      throw new GitHubOAuthError("transient");
    }
  }

  private async readJson(response: Response): Promise<Record<string, unknown> | undefined> {
    try {
      const parsed = JSON.parse(await response.text()) as unknown;
      return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
    } catch {
      if (response.status >= 500) {
        return undefined;
      }
      throw new GitHubOAuthError("transient", "unparseable_response");
    }
  }
}

function positiveInt(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > 31_536_000) {
    throw new GitHubOAuthError("other", "invalid_expiry");
  }
  return value;
}
