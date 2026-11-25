/**
 * Per-user identity gate for the HTTP transport.
 *
 * Sits between the authenticated MCP caller and Copilot-backed execution:
 *
 *   * `admit` proves the caller is a signed-in user, has a linked GitHub
 *     account, and that account has Copilot access, BEFORE a run exists. The
 *     result pins the owner (Entra object id + GitHub user id) onto the run.
 *     An unlinked caller gets an actionable result, never a half-started run
 *     and never another identity's quota.
 *   * the connect, status and disconnect tools are how a user manages the link
 *     from inside Cowork or Copilot Studio. Neither host can drive a second
 *     sign-in from within one connector, so the connect tool returns a one-time
 *     browser link and the user finishes there.
 *
 * It uses no host-specific behavior: Cowork and Copilot Studio reach it the same
 * way, as a tools/call carrying a delegated Entra token.
 */
import { userPrincipalOf, type AuthContext, type UserPrincipal } from "../auth/entra.js";
import {
  PerUserCopilotCredentials,
  userIdentityMessage,
  type UserIdentityCode,
} from "../engine/copilot/user-credentials.js";
import type { RunOwnerRecord } from "../engine/run-state.js";
import { GitHubUnlinkPartialError } from "../github-link/index.js";

/** What the gate needs from the GitHub link service. */
export interface GitHubLinkFacade {
  begin(principal: UserPrincipal): Promise<{ url: string; expiresAt: string | number }>;
  status(principal: UserPrincipal): Promise<{
    linked: boolean;
    githubLogin?: string;
    githubUserId?: number;
    tokenKind?: string;
    accessExpiresAt?: string | number;
  }>;
  unlink(principal: UserPrincipal): Promise<void>;
}

export type AdmitResult =
  | { ok: true; owner: RunOwnerRecord }
  | { ok: false; code: UserIdentityCode; text: string };

export interface UserIdentityGateOptions {
  link: GitHubLinkFacade;
  credentials: PerUserCopilotCredentials;
  /** Tool ids that run Copilot-backed work for the caller. */
  executionTools: ReadonlySet<string>;
}

export class UserIdentityGate {
  constructor(private readonly options: UserIdentityGateOptions) {}

  /** True when a call to this tool must be admitted before it runs. */
  appliesTo(toolId: string): boolean {
    return this.options.executionTools.has(toolId);
  }

  async admit(auth: AuthContext): Promise<AdmitResult> {
    const principal = userPrincipalOf(auth);
    if (!principal) {
      return { ok: false, code: "delegated_user_required", text: userIdentityMessage("delegated_user_required") };
    }
    const status = await this.options.credentials.verifyFor(principal);
    if (!status.ready) {
      const code = status.code ?? "copilot_verification_failed";
      return { ok: false, code, text: status.reason };
    }
    return {
      ok: true,
      owner: {
        authorityTenantId: principal.tenantId,
        objectId: principal.objectId,
        ...(status.githubUserId !== undefined ? { githubUserId: status.githubUserId } : {}),
        ...(status.credentialVersion !== undefined ? { credentialVersion: status.credentialVersion } : {}),
        ...(status.linkGeneration ? { linkGeneration: status.linkGeneration } : {}),
      },
    };
  }

  /** `squad_github_status`: never reveals a token, only who is connected and whether it works. */
  async statusText(auth: AuthContext): Promise<{ text: string; connected: boolean }> {
    const principal = userPrincipalOf(auth);
    if (!principal) return { text: userIdentityMessage("delegated_user_required"), connected: false };
    const link = await this.options.link.status(principal);
    if (!link.linked) {
      return { text: `${userIdentityMessage("github_connection_required")}`, connected: false };
    }
    const check = await this.options.credentials.verifyFor(principal);
    const who = link.githubLogin ? `GitHub user ${link.githubLogin}` : "a GitHub user";
    return check.ready
      ? { text: `Connected as ${who}. GitHub Copilot access is verified (${check.models ?? 0} models).`, connected: true }
      : { text: `Connected as ${who}, but not usable: ${check.reason}`, connected: false };
  }

  /** `squad_github_connect`: returns a single-use link bound to this caller. */
  async connectText(auth: AuthContext): Promise<{ text: string; ok: boolean }> {
    const principal = userPrincipalOf(auth);
    if (!principal) return { text: userIdentityMessage("delegated_user_required"), ok: false };
    const begun = await this.options.link.begin(principal);
    const expiresAt = typeof begun.expiresAt === "number" ? begun.expiresAt : Date.parse(begun.expiresAt);
    const minutes = Math.max(1, Math.round((expiresAt - Date.now()) / 60_000));
    return {
      ok: true,
      text:
        `Open this link in your browser to connect your own GitHub account: ${begun.url}\n` +
        `It works once, for about ${minutes} minutes, and only for you. You will be asked to sign in ` +
        `with your work account first. Do not share the link. When you are done, call squad_github_status.`,
    };
  }

  async disconnectText(auth: AuthContext): Promise<{ text: string; ok: boolean }> {
    const principal = userPrincipalOf(auth);
    if (!principal) return { text: userIdentityMessage("delegated_user_required"), ok: false };
    try {
      await this.options.link.unlink(principal);
    } catch (error) {
      if (!(error instanceof GitHubUnlinkPartialError)) throw error;
      return {
        ok: false,
        text: "Your local GitHub connection is disabled, but GitHub-side revocation was not confirmed. Revoke this app in GitHub Authorized Apps. Existing runs cannot resume with a replacement connection.",
      };
    }
    return { text: "Your GitHub account is disconnected. Runs you started with it can no longer continue.", ok: true };
  }
}
