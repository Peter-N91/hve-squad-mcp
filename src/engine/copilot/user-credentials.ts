/**
 * Per-user GitHub identity for the Copilot runtime.
 *
 * `CopilotCredentials` (copilot-credentials.ts) models ONE server-owned GitHub
 * identity. This broker replaces it where each caller must run as their own
 * GitHub user: it resolves a linked user token for an Entra principal, proves
 * Copilot entitlement for that token, and hands the SDK a per-session
 * `gitHubTokenProvider`. There is deliberately no fallback to any shared
 * credential: a user without a usable link gets a typed, actionable failure.
 *
 * The runtime stays shared (one sandbox, one SDK client); only the credential
 * differs per session. The broker knows nothing about how tokens are stored: it
 * depends on {@link UserTokenResolver}, implemented by the GitHub link service.
 */
import type { UserPrincipal } from "../../auth/entra.js";
import { principalKeyOf } from "../../auth/entra.js";
import { type CopilotEntitlementVerifier, CopilotRuntimeUnavailableError, isCredentialRejection, type GitHubTokenProviderResult } from "./copilot-credentials.js";

export type UserIdentityCode =
  | "delegated_user_required"
  | "github_connection_required"
  | "github_reauthentication_required"
  | "github_identity_changed"
  | "copilot_entitlement_missing"
  | "copilot_verification_failed"
  | "copilot_runtime_unavailable";

const LINK_CODES: ReadonlySet<string> = new Set([
  "github_connection_required",
  "github_reauthentication_required",
  "github_identity_changed",
]);

/** A GitHub user token resolved for one principal. */
export interface UserTokenGrant {
  accessToken: string;
  expiresInSeconds: number;
  githubUserId: number;
  credentialVersion: number;
  linkGeneration?: string;
}

/** Source of linked user tokens; implemented by the GitHub link service. */
export interface UserTokenResolver {
  tokenFor(
    principal: UserPrincipal,
    options: { reason: "initial" | "refresh"; expectedGithubUserId?: number; expectedLinkGeneration?: string },
  ): Promise<UserTokenGrant>;
}

/** Identity pinned onto a run when it starts; a later credential for another GitHub user is refused. */
export interface RunOwner extends UserPrincipal {
  githubUserId?: number;
}

export interface UserIdentityStatus {
  ready: boolean;
  code?: UserIdentityCode;
  /** Safe, token-free explanation fit to show the caller. */
  reason: string;
  /** Why identity is not ready: the user's own credential, or the shared runtime. */
  cause?: "credential" | "runtime";
  githubUserId?: number;
  credentialVersion?: number;
  linkGeneration?: string;
  checkedAt?: string;
  models?: number;
  modelIds?: readonly string[];
  premiumRemainingPercent?: number;
}

export interface PerUserCopilotCredentialsOptions {
  tokens: UserTokenResolver;
  verifier: CopilotEntitlementVerifier;
  /** How long a successful entitlement check for one credential version is trusted. */
  verifyCacheMs?: number;
  now?: () => number;
  githubHost?: string;
}

// Exact shapes captured from the real runtime for a revoked or invalid token (see isCredentialRejection):
// the user fixes these by reconnecting, which is different from a missing license.
const ENTITLEMENT_FAILURE = /\b(403|forbidden|not entitled|no copilot|copilot (is )?not (enabled|available)|subscription)\b/i;

/** The runtime rejects a token reported with 3600 seconds or less remaining; never report less. */
export const MIN_PROVIDER_LIFETIME_SECONDS = 3601;

export function userIdentityCodeOf(error: unknown): UserIdentityCode | undefined {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "string" && LINK_CODES.has(code) ? (code as UserIdentityCode) : undefined;
}

const MESSAGES: Record<UserIdentityCode, string> = {
  delegated_user_required: "This operation needs a signed-in user. Sign in to the connection with your own account.",
  github_connection_required: "Your GitHub account is not connected. Run squad_github_connect and open the link it returns.",
  github_reauthentication_required: "Your GitHub connection has expired or was revoked. Run squad_github_connect to reconnect.",
  github_identity_changed: "The GitHub account or connection generation no longer matches this run. Start a new run with the connected account. A disconnected connection is never silently adopted.",
  copilot_entitlement_missing: "The connected GitHub account has no usable GitHub Copilot access.",
  copilot_verification_failed: "GitHub Copilot access could not be verified for the connected account.",
  copilot_runtime_unavailable: "The Copilot runtime is temporarily unavailable. Try again shortly.",
};

export function userIdentityMessage(code: UserIdentityCode): string {
  return MESSAGES[code];
}

export class PerUserCopilotCredentials {
  private readonly cache = new Map<string, { status: UserIdentityStatus; at: number }>();
  private readonly inflight = new Map<string, Promise<UserIdentityStatus>>();

  constructor(private readonly options: PerUserCopilotCredentialsOptions) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private notReady(code: UserIdentityCode, cause: "credential" | "runtime", extra: Partial<UserIdentityStatus> = {}): UserIdentityStatus {
    return { ready: false, code, reason: MESSAGES[code], cause, checkedAt: new Date(this.now()).toISOString(), ...extra };
  }

  /**
   * Resolve the user's token and prove Copilot entitlement. Concurrent callers
   * for one principal share a single check, and a verified credential version is
   * trusted for `verifyCacheMs` so the model list is not fetched on every call.
   */
  verifyFor(principal: UserPrincipal, pin?: { githubUserId?: number; linkGeneration?: string }): Promise<UserIdentityStatus> {
    const key = `${principalKeyOf(principal)}|${pin?.githubUserId ?? ""}|${pin?.linkGeneration ?? ""}`;
    const running = this.inflight.get(key);
    if (running) return running;
    if (this.inflight.size >= 1024) throw new Error("Copilot identity verification capacity reached.");
    const task = this.verifyUncached(principal, pin).finally(() => this.inflight.delete(key));
    this.inflight.set(key, task);
    return task;
  }

  private async verifyUncached(principal: UserPrincipal, pin?: { githubUserId?: number; linkGeneration?: string }): Promise<UserIdentityStatus> {
    for (const [key, entry] of this.cache) {
      if (this.now() - entry.at > 10 * 60_000) this.cache.delete(key);
    }
    let grant: UserTokenGrant;
    try {
      grant = await this.options.tokens.tokenFor(principal, {
        reason: "initial",
        ...(pin?.githubUserId !== undefined ? { expectedGithubUserId: pin.githubUserId } : {}),
        ...(pin?.linkGeneration ? { expectedLinkGeneration: pin.linkGeneration } : {}),
      });
    } catch (error) {
      const code = userIdentityCodeOf(error);
      if (code) return this.notReady(code, "credential");
      throw error;
    }
    const cacheKey = `${principalKeyOf(principal)}|v${grant.credentialVersion}|u${grant.githubUserId}|g${grant.linkGeneration ?? ""}`;
    const hit = this.cache.get(cacheKey);
    if (hit && this.now() - hit.at < (this.options.verifyCacheMs ?? 5 * 60_000)) return { ...hit.status };
    let status: UserIdentityStatus;
    try {
      const result = await this.options.verifier.verify(grant.accessToken);
      if (result.models.length === 0) {
        status = this.notReady("copilot_entitlement_missing", "credential", { githubUserId: grant.githubUserId, credentialVersion: grant.credentialVersion });
      } else {
        status = {
          ready: true,
          reason: "Copilot access verified for the connected GitHub account.",
          checkedAt: new Date(this.now()).toISOString(),
          githubUserId: grant.githubUserId,
          credentialVersion: grant.credentialVersion,
          ...(grant.linkGeneration ? { linkGeneration: grant.linkGeneration } : {}),
          models: result.models.length,
          modelIds: [...result.models],
          ...(result.premiumRemainingPercent !== undefined ? { premiumRemainingPercent: result.premiumRemainingPercent } : {}),
        };
      }
    } catch (error) {
      const base = { githubUserId: grant.githubUserId, credentialVersion: grant.credentialVersion };
      if (error instanceof CopilotRuntimeUnavailableError) {
        return this.notReady("copilot_runtime_unavailable", "runtime", base);
      }
      const text = error instanceof Error ? error.message : String(error);
      // Runtime failures are not cached, so a recovered sandbox is used immediately.
      if (isCredentialRejection(text)) return this.notReady("github_reauthentication_required", "credential", base);
      return this.notReady(ENTITLEMENT_FAILURE.test(text) ? "copilot_entitlement_missing" : "copilot_verification_failed", "credential", base);
    }
    if (status.ready && this.options.verifyCacheMs !== 0) {
      if (this.cache.size >= 1024) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(cacheKey, { status, at: this.now() });
    }
    return { ...status };
  }

  /** Last successful verification for this principal's current credential, or undefined when none is trusted. */
  cachedStatus(principal: UserPrincipal): UserIdentityStatus | undefined {
    const prefix = `${principalKeyOf(principal)}|v`;
    let best: { status: UserIdentityStatus; at: number } | undefined;
    for (const [key, entry] of this.cache) {
      if (!key.startsWith(prefix)) continue;
      if (this.now() - entry.at >= (this.options.verifyCacheMs ?? 5 * 60_000)) continue;
      if (!best || entry.at > best.at) best = entry;
    }
    return best ? { ...best.status } : undefined;
  }

  /**
   * SDK `gitHubTokenProvider` for one principal. The runtime calls it when a
   * session starts and again before the token expires; every call re-resolves
   * the stored link, so rotation and revocation take effect without a restart.
   * A failed resolution throws: the session never falls back to another identity.
   */
  tokenProviderFor(principal: UserPrincipal, pin?: { githubUserId?: number; linkGeneration?: string }): (args: { reason?: string; host?: string; sessionId?: string }) => Promise<GitHubTokenProviderResult> {
    return async (args) => {
      if (this.options.githubHost && !args.host) {
        throw new Error("GitHub credential provider omitted its effective host.");
      }
      if (args.host) {
        const origin = new URL(args.host.includes("://") ? args.host : `https://${args.host}`);
        const expected = this.options.githubHost ?? "github.com";
        if (origin.protocol !== "https:" || origin.hostname !== expected || origin.username ||
            origin.password || origin.port || origin.pathname !== "/" || origin.search || origin.hash) {
          throw new Error("GitHub credential provider host is not permitted.");
        }
      }
      const grant = await this.options.tokens.tokenFor(principal, {
        reason: args.reason === "refresh" ? "refresh" : "initial",
        ...(pin?.githubUserId !== undefined ? { expectedGithubUserId: pin.githubUserId } : {}),
        ...(pin?.linkGeneration ? { expectedLinkGeneration: pin.linkGeneration } : {}),
      });
      // The runtime refuses a credential with an hour or less left, and fails session
      // creation rather than refreshing it. Fail here with a reconnect instruction.
      if (grant.expiresInSeconds < MIN_PROVIDER_LIFETIME_SECONDS) {
        throw Object.assign(new Error("github_reauthentication_required"), { code: "github_reauthentication_required" });
      }
      return { kind: "token", accessToken: grant.accessToken, expiresIn: grant.expiresInSeconds };
    };
  }
}
