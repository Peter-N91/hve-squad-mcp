/**
 * Per-user GitHub link service.
 *
 * Linking flow (three browser legs, every step single-use and short-lived):
 *   begin(principal)                       -> start URL carrying a one-time nonce bound to {tenantId, oid}
 *   GET /github/link/start?nonce=          -> safe landing, no sign-in or nonce consumption
 *   POST /github/link/start               -> same-origin CSRF consent, then Entra sign-in (code + PKCE)
 *   GET /github/link/entra-callback        -> verifies the browser user == nonce principal, redirects to GitHub
 *   GET /github/link/callback              -> verifies state, exchanges the code, stores the encrypted link
 * A browser-binding cookie set at /start must accompany both callbacks, so a leaked
 * callback URL is useless from another browser.
 *
 * Token refresh (GitHub App ghu_ tokens, 8h, with ghr_ refresh tokens, 6 months):
 * GitHub ROTATES the refresh token on every use and invalidates the old pair
 * (https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens).
 * tokenFor therefore:
 *   1. takes a lease on the row with putIfMatch (CAS) so only one caller across all
 *      replicas calls GitHub;
 *   2. persists the NEW pair with putIfMatch BEFORE returning it;
 *   3. on CAS loss, re-reads and uses the winner's tokens.
 * RESIDUAL RISK (documented, not removable): if the process dies after GitHub
 * answered the refresh but before step 2 completes, the old refresh token is already
 * invalidated and the new one is lost. An expired lease never replays that refresh.
 * The user must repeat the link flow (github_reauthentication_required).
 * Persisting before use shrinks the window to one store write; it cannot close it.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { principalKeyOf, type UserPrincipal } from "../auth/entra.js";
import type { FieldCipher } from "../engine/field-cipher.js";
import type { PrincipalVault } from "../auth/principal-vault.js";
import type { HttpRequestLike, HttpResponseLike } from "../transports/http-core.js";
import { newPkce, type EntraSignInPort } from "./entra-sign-in.js";
import { InMemoryLinkFlowStore, type FlowKind, type LinkFlowEntry, type LinkFlowStore } from "./flow-store.js";
import { consentPage, errorPage, methodNotAllowed, redirectResponse, successPage } from "./pages.js";
import { credentialBinding, TokenSealer } from "./token-seal.js";
import {
  GitHubLinkError,
  GitHubOAuthError,
  GitHubUnlinkPartialError,
  type CopilotGitHubTokenProvider,
  type GitHubLinkErrorCode,
  type GitHubLinkRecord,
  type GitHubLinkStatus,
  type GitHubLinkStore,
  type GitHubOAuthPort,
  type GitHubTokenSet,
  type GitHubUser,
  type LinkLogger,
  type PutResult,
  type StoredGitHubLink,
  type TokenForOptions,
  type TokenForResult,
} from "./types.js";

export const LINK_START_PATH = "/github/link/start";
export const LINK_ENTRA_CALLBACK_PATH = "/github/link/entra-callback";
export const LINK_GITHUB_CALLBACK_PATH = "/github/link/callback";
export const LINK_CONFIRM_PATH = "/github/link/confirm";

/** The Copilot runtime treats a token with less than an hour left as due and asks again. */
export const DEFAULT_REFRESH_WINDOW_SECONDS = 65 * 60;
/** A provider must never report less than this (one hour plus one second). */
export const MIN_PROVIDER_EXPIRES_IN_SECONDS = 3601;
const NO_EXPIRY_REPORTED_SECONDS = 8 * 3600;
const COOKIE_NAME = "ghlink_bind";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;

export interface GitHubLinkServiceOptions {
  store: GitHubLinkStore;
  cipher: FieldCipher | PrincipalVault;
  oauth: GitHubOAuthPort;
  entra: EntraSignInPort;
  /** Externally visible origin of this server, e.g. https://mcp.example.com (no path). */
  publicBaseUrl: string;
  flowStore?: LinkFlowStore;
  logger?: LinkLogger;
  /** Clock in epoch ms (tests inject a fake). */
  now?: () => number;
  /** Refresh when less than this many seconds remain. Default 65 minutes; minimum 3601. */
  refreshWindowSeconds?: number;
  /** Lifetime of a link nonce and of each flow step. Default 10 minutes. */
  flowTtlMs?: number;
  /** Refresh lease lifetime. Expiry requires relinking, never takeover. Default 30s. */
  leaseTtlMs?: number;
  leasePollMs?: number;
  /** Max time a caller waits for another caller's refresh. Default leaseTtlMs + 5s. */
  leaseWaitMs?: number;
  /** Set false only for plain-http local development. */
  secureCookies?: boolean;
  /** Revocation after local unlink. Failure produces a partial receipt error. */
  revoke?: (accessToken: string) => Promise<void>;
  /** SDK credential audience. No caller-supplied alternate GitHub host is accepted. */
  githubHost?: string;
}

export interface BeginOptions {
  /** Compatibility hint only. Browser confirmation is always required for a switch. */
  allowRebind?: boolean;
}

export interface BeginResult {
  startUrl: string;
  expiresAt: string;
  alreadyLinked: boolean;
  linkedGithubLogin?: string;
  /** The previous failed attempt for this principal, e.g. github_identity_changed. */
  lastLinkError?: GitHubLinkErrorCode;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function equalHex(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function samePrincipal(a: UserPrincipal, b: UserPrincipal): boolean {
  return a.tenantId === b.tenantId && a.objectId === b.objectId;
}

function parseCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) {
      return part.slice(index + 1).trim();
    }
  }
  return undefined;
}

export class GitHubLinkService {
  private readonly sealer: TokenSealer;
  private readonly flows: LinkFlowStore;
  private readonly now: () => number;
  private readonly baseUrl: string;
  private readonly windowSeconds: number;
  private readonly flowTtlMs: number;
  private readonly leaseTtlMs: number;
  private readonly leasePollMs: number;
  private readonly leaseWaitMs: number;
  private readonly secureCookies: boolean;
  private readonly lastErrors = new Map<string, GitHubLinkErrorCode>();
  private readonly inflight = new Map<string, Promise<{ stored: StoredGitHubLink; refreshed: boolean }>>();
  private readonly locallyUnlinked = new Map<string, string | undefined>();

  constructor(private readonly options: GitHubLinkServiceOptions) {
    this.sealer = new TokenSealer(options.cipher);
    this.now = options.now ?? Date.now;
    this.flows = options.flowStore ?? new InMemoryLinkFlowStore(this.now);
    this.baseUrl = options.publicBaseUrl.replace(/\/+$/, "");
    const base = new URL(this.baseUrl);
    if (base.origin !== this.baseUrl || base.username || base.password ||
        (base.protocol !== "https:" && !(options.secureCookies === false && base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)))) {
      throw new Error("GitHub link publicBaseUrl must be a secure origin.");
    }
    this.windowSeconds = options.refreshWindowSeconds ?? DEFAULT_REFRESH_WINDOW_SECONDS;
    if (!Number.isFinite(this.windowSeconds) || this.windowSeconds < MIN_PROVIDER_EXPIRES_IN_SECONDS) {
      throw new Error(`refreshWindowSeconds must be at least ${MIN_PROVIDER_EXPIRES_IN_SECONDS}.`);
    }
    this.flowTtlMs = options.flowTtlMs ?? 10 * 60_000;
    this.leaseTtlMs = options.leaseTtlMs ?? 30_000;
    this.leasePollMs = options.leasePollMs ?? 50;
    this.leaseWaitMs = options.leaseWaitMs ?? this.leaseTtlMs + 5_000;
    this.secureCookies = options.secureCookies ?? true;
    if (!Number.isFinite(this.flowTtlMs) || this.flowTtlMs <= 0 || this.flowTtlMs > 10 * 60_000 ||
        !Number.isFinite(this.leaseTtlMs) || this.leaseTtlMs <= 0 || this.leaseTtlMs > 120_000 ||
        !Number.isFinite(this.leasePollMs) || this.leasePollMs < 1 ||
        !Number.isFinite(this.leaseWaitMs) || this.leaseWaitMs < 0 || this.leaseWaitMs > 180_000) {
      throw new Error("Invalid GitHub link lifetime configuration.");
    }
  }

  // ---------------------------------------------------------------- begin / status / unlink

  async begin(principal: UserPrincipal, options: BeginOptions = {}): Promise<BeginResult> {
    const key = principalKeyOf(principal);
    let existing = await this.options.store.get(key);
    if (!existing) {
      const now = new Date(this.now()).toISOString();
      const placeholder: GitHubLinkRecord = {
        tenantId: principal.tenantId, oid: principal.objectId, githubUserId: 0, githubLogin: "",
        tokenKind: "other", accessTokenEnc: "", credentialVersion: 0, linkedAt: now, updatedAt: now,
        linkGeneration: randomBytes(24).toString("base64url"), state: "unlinked",
      };
      const created = await this.options.store.putIfMatch(placeholder, undefined);
      existing = created.ok ? { record: placeholder, etag: created.etag } : await this.options.store.get(key);
      if (!existing) throw new GitHubLinkError("github_token_refresh_conflict");
    }
    if (existing && !this.recordMatches(existing.record, principal)) {
      throw new GitHubLinkError("github_link_principal_mismatch");
    }
    const nonce = randomBytes(32).toString("base64url");
    const expiresAtMs = this.now() + this.flowTtlMs;
    await this.flows.put(this.flowKey("link", nonce), {
      kind: "link",
      principal: { tenantId: principal.tenantId, objectId: principal.objectId },
      allowRebind: options.allowRebind === true,
      linkGeneration: this.generation(existing.record),
      expiresAtMs,
    });
    const lastLinkError = this.lastErrors.get(key);
    this.lastErrors.delete(key);
    return {
      startUrl: `${this.baseUrl}${LINK_START_PATH}?nonce=${nonce}`,
      expiresAt: new Date(expiresAtMs).toISOString(),
      alreadyLinked: existing.record.state !== "unlinked",
      linkedGithubLogin: existing.record.state === "unlinked" ? undefined : existing.record.githubLogin,
      lastLinkError,
    };
  }

  async status(principal: UserPrincipal): Promise<GitHubLinkStatus> {
    const key = principalKeyOf(principal);
    const stored = await this.options.store.get(key);
    const lastLinkError = this.lastErrors.get(key);
    if (!stored || stored.record.state === "unlinked") {
      return { linked: false, ...(lastLinkError ? { lastLinkError } : {}) };
    }
    this.requireRecordMatches(stored.record, principal);
    const { record } = stored;
    return {
      linked: true,
      githubLogin: record.githubLogin,
      githubUserId: record.githubUserId,
      tokenKind: record.tokenKind,
      accessExpiresAt: record.accessExpiresAt,
      linkGeneration: this.generation(record),
      reauthenticationRequired: record.state === "reauth-required",
      ...(lastLinkError ? { lastLinkError } : {}),
    };
  }

  /** Tombstone first, then revoke. A thrown revocation error means local unlink succeeded. */
  async unlink(principal: UserPrincipal): Promise<boolean> {
    const key = principalKeyOf(principal);
    this.locallyUnlinked.set(key, undefined);
    let stored = await this.options.store.get(key);
    this.lastErrors.delete(key);
    if (!stored) {
      this.locallyUnlinked.delete(key);
      return false;
    }
    this.locallyUnlinked.set(key, this.generation(stored.record));
    this.requireRecordMatches(stored.record, principal);
    let accessToken: string | undefined;
    try {
      accessToken = this.sealer.open(credentialBinding(key, stored.record), "access", stored.record.accessTokenEnc);
    } catch {
      accessToken = undefined;
    }
    let deleted = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      this.locallyUnlinked.set(key, this.generation(stored.record));
      try { accessToken = this.sealer.open(credentialBinding(key, stored.record), "access", stored.record.accessTokenEnc); }
      catch { accessToken = undefined; }
      const tombstone: GitHubLinkRecord = { ...stored.record, state: "unlinked",
        accessTokenEnc: "", refreshTokenEnc: undefined, refreshLease: undefined,
        linkGeneration: randomBytes(24).toString("base64url"), credentialVersion: stored.record.credentialVersion + 1 };
      let result: PutResult;
      try { result = await this.options.store.putIfMatch(tombstone, stored.etag); }
      catch {
        const receipt = await this.options.store.get(key);
        if (receipt?.record.state === "unlinked" && receipt.record.linkGeneration === tombstone.linkGeneration) {
          result = { ok: true, etag: receipt.etag };
        } else throw new GitHubLinkError("github_token_refresh_conflict", "Local unlink could not be confirmed.");
      }
      if (result.ok) { deleted = stored.record.state !== "unlinked"; break; }
      stored = await this.options.store.get(key);
      if (!stored) throw new GitHubLinkError("github_token_refresh_conflict");
      if (attempt === 7) throw new GitHubLinkError("github_token_refresh_conflict");
    }
    const revoke = this.options.revoke ?? this.options.oauth.revoke?.bind(this.options.oauth);
    if (accessToken && revoke) {
      try {
        await revoke(accessToken);
      } catch {
        this.log("warn", "github_link.revoke_failed", principal);
        throw new GitHubUnlinkPartialError("failed");
      }
    } else if (deleted) {
      throw new GitHubUnlinkPartialError("unavailable");
    }
    this.log("info", "github_link.unlinked", principal);
    return deleted;
  }

  // ---------------------------------------------------------------- tokens

  async tokenFor(principal: UserPrincipal, options: TokenForOptions): Promise<TokenForResult> {
    const key = principalKeyOf(principal);
    if (this.locallyUnlinked.has(key) && this.locallyUnlinked.get(key) === undefined) throw new GitHubLinkError("github_connection_required");
    let stored = await this.load(principal);
    const generation = this.generation(stored.record);
    if (this.locallyUnlinked.has(key)) {
      if (this.locallyUnlinked.get(key) === generation) throw new GitHubLinkError("github_connection_required");
      this.locallyUnlinked.delete(key);
    }
    if (options.expectedLinkGeneration !== undefined && generation !== options.expectedLinkGeneration) throw new GitHubLinkError("github_identity_changed");
    this.assertIdentity(stored.record, options.expectedGithubUserId);
    let refreshed = false;

    if (this.needsRefresh(stored.record) && this.canRefresh(stored.record)) {
      const flightKey = `${key}|${generation}`;
      const existing = this.inflight.get(flightKey);
      if (existing) {
        stored = (await existing).stored;
      } else {
        const flight = this.refreshExclusive(principal);
        this.inflight.set(flightKey, flight);
        try {
          const result = await flight;
          stored = result.stored;
          refreshed = result.refreshed;
        } finally {
          this.inflight.delete(flightKey);
        }
      }
      this.assertIdentity(stored.record, options.expectedGithubUserId);
    }
    const latest = await this.load(principal);
    if (this.locallyUnlinked.has(key) || this.generation(latest.record) !== generation ||
        this.generation(stored.record) !== generation) throw new GitHubLinkError("github_identity_changed");
    return this.toResult(principal, latest.record, refreshed);
  }

  /**
   * Copilot SDK `gitHubTokenProvider`. Always reports expiresIn >= 3601, or throws.
   * It never falls back to any other credential: a GitHubLinkError propagates.
   */
  asGitHubTokenProvider(principal: UserPrincipal, expectedGithubUserId?: number, expectedLinkGeneration?: string): CopilotGitHubTokenProvider {
    const boundGeneration = this.load(principal).then(row => this.generation(row.record));
    // A provider may be created but never invoked.
    void boundGeneration.catch(() => undefined);
    return async ({ reason, host }) => {
      if (host !== undefined && host.toLowerCase() !== (this.options.githubHost ?? "github.com").toLowerCase()) {
        throw new GitHubLinkError("github_link_state_invalid", "GitHub credential host mismatch.");
      }
      const result = await this.tokenFor(principal, { reason, expectedGithubUserId,
        expectedLinkGeneration: expectedLinkGeneration ?? await boundGeneration });
      if (result.expiresInSeconds < MIN_PROVIDER_EXPIRES_IN_SECONDS) {
        throw new GitHubLinkError(
          "github_reauthentication_required",
          "The linked GitHub token cannot be refreshed; relink GitHub.",
        );
      }
      return { kind: "token", accessToken: result.accessToken, expiresIn: result.expiresInSeconds };
    };
  }

  private remainingSeconds(record: GitHubLinkRecord): number | undefined {
    return record.accessExpiresAt === undefined ? undefined : (Date.parse(record.accessExpiresAt) - this.now()) / 1000;
  }

  private needsRefresh(record: GitHubLinkRecord): boolean {
    const remaining = this.remainingSeconds(record);
    return remaining !== undefined && remaining < this.windowSeconds;
  }

  private canRefresh(record: GitHubLinkRecord): boolean {
    if (!record.refreshTokenEnc) {
      return false;
    }
    return record.refreshExpiresAt === undefined || Date.parse(record.refreshExpiresAt) > this.now();
  }

  private toResult(principal: UserPrincipal, record: GitHubLinkRecord, refreshed: boolean): TokenForResult {
    const remaining = this.remainingSeconds(record);
    if (remaining !== undefined && (!Number.isFinite(remaining) || remaining <= 3600)) {
      throw new GitHubLinkError("github_reauthentication_required", "The linked GitHub token expired.");
    }
    const key = principalKeyOf(principal);
    const accessToken = this.sealer.open(credentialBinding(key, record), "access", record.accessTokenEnc);
    this.options.logger?.registerSecret?.(accessToken);
    return {
      accessToken,
      expiresInSeconds: remaining === undefined ? NO_EXPIRY_REPORTED_SECONDS : Math.floor(remaining),
      githubUserId: record.githubUserId,
      credentialVersion: record.credentialVersion,
      linkGeneration: this.generation(record),
      refreshed,
    };
  }

  private assertIdentity(record: GitHubLinkRecord, expected: number | undefined): void {
    if (expected !== undefined && record.githubUserId !== expected) {
      throw new GitHubLinkError("github_identity_changed", "The linked GitHub account differs from the expected one.");
    }
  }

  private async load(principal: UserPrincipal): Promise<StoredGitHubLink> {
    const stored = await this.options.store.get(principalKeyOf(principal));
    if (!stored || stored.record.state === "unlinked") {
      throw new GitHubLinkError("github_connection_required");
    }
    this.requireRecordMatches(stored.record, principal);
    if (stored.record.state === "reauth-required") throw new GitHubLinkError("github_reauthentication_required");
    return stored;
  }

  private generation(record: GitHubLinkRecord): string {
    return record.linkGeneration ?? `legacy:${record.linkedAt}`;
  }

  private recordMatches(record: GitHubLinkRecord, principal: UserPrincipal): boolean {
    return record.tenantId === principal.tenantId && record.oid === principal.objectId;
  }

  private requireRecordMatches(record: GitHubLinkRecord, principal: UserPrincipal): void {
    if (!this.recordMatches(record, principal)) {
      throw new GitHubLinkError("github_link_principal_mismatch");
    }
  }

  /**
   * Single-flight refresh across replicas. Returns the row to use (ours after a
   * successful refresh, or the winner's), already persisted.
   */
  private async refreshExclusive(principal: UserPrincipal): Promise<{ stored: StoredGitHubLink; refreshed: boolean }> {
    const key = principalKeyOf(principal);
    const maxPolls = Math.max(1, Math.ceil(this.leaseWaitMs / this.leasePollMs));
    let polls = 0;

    for (;;) {
      const current = await this.load(principal);
      if (!this.needsRefresh(current.record) || !this.canRefresh(current.record)) {
        return { stored: current, refreshed: false };
      }
      const lease = current.record.refreshLease;
      if (lease && (!Number.isFinite(Date.parse(lease.expiresAt)) || Date.parse(lease.expiresAt) <= this.now())) {
        await this.markReauthentication(current.record, current.etag);
        throw new GitHubLinkError("github_reauthentication_required");
      }
      if (lease && Date.parse(lease.expiresAt) > this.now()) {
        if (++polls > maxPolls) {
          throw new GitHubLinkError("github_token_refresh_conflict", "Another refresh is still in progress.");
        }
        await new Promise((resolve) => setTimeout(resolve, this.leasePollMs));
        continue;
      }

      const leaseId = randomBytes(16).toString("base64url");
      const leasedRecord: GitHubLinkRecord = {
        ...current.record,
        refreshLease: { id: leaseId, expiresAt: new Date(this.now() + this.leaseTtlMs).toISOString() },
      };
      const leased = await this.options.store.putIfMatch(leasedRecord, current.etag);
      if (!leased.ok) {
        continue; // lost the CAS: re-read and use the winner's tokens
      }

      const startVersion = current.record.credentialVersion;
      let tokens: GitHubTokenSet;
      try {
        const refreshToken = this.sealer.open(credentialBinding(key, current.record), "refresh", current.record.refreshTokenEnc as string);
        this.options.logger?.registerSecret?.(refreshToken);
        tokens = await this.options.oauth.refresh(refreshToken);
      } catch (error) {
        await this.markReauthentication(leasedRecord, leased.etag);
        throw this.mapRefreshFailure(principal, error);
      }
      this.registerTokenSecrets(tokens);

      const persisted = await this.persistRefreshed(principal, current.record, tokens, startVersion, leased.etag);
      if (persisted) {
        this.log("info", "github_link.refreshed", principal, { credentialVersion: persisted.record.credentialVersion });
        return { stored: persisted, refreshed: true };
      }
      await this.revokeUnused(tokens.accessToken);
      // The row was relinked while we refreshed; the fresh link wins, loop to read it.
    }
  }

  private async persistRefreshed(
    principal: UserPrincipal,
    base: GitHubLinkRecord,
    tokens: GitHubTokenSet,
    startVersion: number,
    leasedEtag: string,
  ): Promise<StoredGitHubLink | undefined> {
    const key = principalKeyOf(principal);
    const nowMs = this.now();
    const next: GitHubLinkRecord = {
      ...base,
      tokenKind: tokens.tokenKind,
      accessTokenEnc: this.sealer.seal(credentialBinding(key, base), "access", tokens.accessToken),
      refreshTokenEnc: tokens.refreshToken ? this.sealer.seal(credentialBinding(key, base), "refresh", tokens.refreshToken) : undefined,
      accessExpiresAt:
        tokens.expiresInSeconds === undefined ? undefined : new Date(nowMs + tokens.expiresInSeconds * 1000).toISOString(),
      refreshExpiresAt:
        tokens.refreshExpiresInSeconds === undefined
          ? undefined
          : new Date(nowMs + tokens.refreshExpiresInSeconds * 1000).toISOString(),
      credentialVersion: startVersion + 1,
      updatedAt: new Date(nowMs).toISOString(),
      refreshLease: undefined,
    };
    delete next.refreshLease;
    if (next.refreshTokenEnc === undefined) delete next.refreshTokenEnc;
    if (next.accessExpiresAt === undefined) delete next.accessExpiresAt;
    if (next.refreshExpiresAt === undefined) delete next.refreshExpiresAt;

    let etag = leasedEtag;
    for (let attempt = 0; attempt < 5; attempt++) {
      let result: PutResult;
      try {
        result = await this.options.store.putIfMatch(next, etag);
      } catch {
        result = { ok: false };
      }
      if (result.ok) {
        return { record: next, etag: result.etag };
      }
      let latest: StoredGitHubLink | undefined;
      try {
        latest = await this.options.store.get(key);
      } catch {
        latest = undefined;
      }
      if (!latest) {
        if (attempt >= 1) {
          // Either unlinked meanwhile or the store is failing; either way there is nothing to overwrite.
          throw new GitHubLinkError("github_connection_required");
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
        continue;
      }
      if (latest.record.linkGeneration === next.linkGeneration &&
          latest.record.accessTokenEnc === next.accessTokenEnc &&
          latest.record.refreshTokenEnc === next.refreshTokenEnc &&
          latest.record.credentialVersion === next.credentialVersion && latest.record.state === next.state) {
        return latest; // Our write succeeded but its receipt was lost.
      }
      if (latest.record.state === "reauth-required" || latest.record.state === "unlinked" ||
          this.generation(latest.record) !== this.generation(base) ||
          latest.record.credentialVersion !== startVersion || latest.record.githubUserId !== base.githubUserId) {
        return undefined;
      }
      // Our lease row was touched (e.g. the lease expired and was taken over). GitHub already
      // invalidated the old pair, so ours is the only valid one: overwrite on the fresh etag.
      etag = latest.etag;
    }
    throw new GitHubLinkError(
      "github_token_refresh_conflict",
      "Refreshed GitHub credentials could not be saved; relink may be required.",
    );
  }

  private async markReauthentication(original: GitHubLinkRecord, leasedEtag: string): Promise<void> {
    try {
      await this.options.store.putIfMatch({ ...original, state: "reauth-required" }, leasedEtag);
    } catch {
      // The durable lease remains. Its expiry also fails closed, never replays refresh.
    }
  }

  private mapRefreshFailure(principal: UserPrincipal, error: unknown): GitHubLinkError {
    if (error instanceof GitHubLinkError) {
      return error;
    }
    if (error instanceof GitHubOAuthError && error.kind === "invalid_grant") {
      this.log("warn", "github_link.refresh_rejected", principal);
      return new GitHubLinkError("github_reauthentication_required", "GitHub rejected the refresh token; relink GitHub.");
    }
    const kind = error instanceof GitHubOAuthError ? error.kind : "unknown";
    this.log("error", "github_link.refresh_failed", principal, { kind });
    return new GitHubLinkError("github_reauthentication_required", "GitHub refresh outcome is unknown; relink GitHub.");
  }

  private registerTokenSecrets(tokens: GitHubTokenSet): void {
    this.options.logger?.registerSecret?.(tokens.accessToken);
    this.options.logger?.registerSecret?.(tokens.refreshToken);
  }

  // ---------------------------------------------------------------- HTTP

  async handleHttp(req: HttpRequestLike): Promise<HttpResponseLike | undefined> {
    if (![LINK_START_PATH, LINK_ENTRA_CALLBACK_PATH, LINK_GITHUB_CALLBACK_PATH, LINK_CONFIRM_PATH].includes(req.path)) {
      return undefined;
    }
    if (req.method !== "GET" && !(req.method === "POST" && [LINK_START_PATH, LINK_CONFIRM_PATH].includes(req.path))) {
      return methodNotAllowed();
    }
    const query = new URLSearchParams((req.query ?? "").slice(0, 4096));
    try {
      switch (req.path) {
        case LINK_START_PATH:
          return req.method === "GET" ? this.startLanding(query) : await this.handleStart(this.postForm(req), req);
        case LINK_CONFIRM_PATH:
          if (req.method !== "POST") return methodNotAllowed();
          return await this.handleConfirm(this.postForm(req), req);
        case LINK_ENTRA_CALLBACK_PATH:
          return await this.handleEntraCallback(query, req);
        default:
          return await this.handleGitHubCallback(query, req);
      }
    } catch (error) {
      const code = this.httpErrorCode(error);
      this.options.logger?.warn("github_link.http_failed", { path: req.path, code });
      return errorPage(code, { "set-cookie": this.clearCookie() });
    }
  }

  private httpErrorCode(error: unknown): GitHubLinkErrorCode {
    if (error instanceof GitHubLinkError) {
      return error.code;
    }
    if (error instanceof GitHubOAuthError) {
      return error.kind === "invalid_grant" ? "github_link_state_invalid" : "github_token_refresh_conflict";
    }
    return "github_token_refresh_conflict";
  }

  private startLanding(query: URLSearchParams): HttpResponseLike {
    const nonce = query.get("nonce");
    if (!nonce || !TOKEN_PATTERN.test(nonce)) throw new GitHubLinkError("github_link_state_invalid");
    const csrf = randomBytes(32).toString("base64url");
    return consentPage(LINK_START_PATH, { nonce, csrf }, false, { "set-cookie": this.setCookie(csrf) }, undefined, this.options.entra.authorizeOrigin);
  }

  private postForm(req: HttpRequestLike): URLSearchParams {
    if (req.headers.origin !== this.baseUrl ||
        (req.headers["sec-fetch-site"] !== undefined && req.headers["sec-fetch-site"] !== "same-origin") ||
        req.headers["content-type"]?.split(";")[0].trim() !== "application/x-www-form-urlencoded") {
      throw new GitHubLinkError("github_link_state_invalid");
    }
    const raw = typeof req.body === "string" ? req.body : Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
    if (Buffer.byteLength(raw) > 4096) throw new GitHubLinkError("github_link_state_invalid");
    const form = new URLSearchParams(raw);
    const csrf = form.get("csrf");
    const cookie = parseCookie(req.headers.cookie, COOKIE_NAME);
    if (!csrf || !cookie || !TOKEN_PATTERN.test(csrf) || !equalHex(csrf, cookie)) {
      throw new GitHubLinkError("github_link_state_invalid");
    }
    return form;
  }

  private async handleStart(query: URLSearchParams, _req: HttpRequestLike): Promise<HttpResponseLike> {
    const entry = await this.takeFlow("link", query.get("nonce"));
    const browser = randomBytes(32).toString("base64url");
    const state = randomBytes(32).toString("base64url");
    const pkce = newPkce();
    const oidcNonce = randomBytes(32).toString("base64url");
    await this.flows.put(this.flowKey("entra", state), {
      kind: "entra",
      principal: entry.principal,
      allowRebind: entry.allowRebind,
      linkGeneration: entry.linkGeneration,
      expiresAtMs: this.now() + this.flowTtlMs,
      codeVerifier: pkce.codeVerifier,
      oidcNonce,
      browserHash: sha256Hex(browser),
    });
    const location = this.options.entra.buildAuthorizeUrl({
      state,
      nonce: oidcNonce,
      codeChallenge: pkce.codeChallenge,
      redirectUri: `${this.baseUrl}${LINK_ENTRA_CALLBACK_PATH}`,
    });
    return redirectResponse(location, { "set-cookie": this.setCookie(browser) });
  }

  private async handleEntraCallback(query: URLSearchParams, req: HttpRequestLike): Promise<HttpResponseLike> {
    const entry = await this.takeFlow("entra", query.get("state"));
    this.requireBrowser(entry, req);
    const code = query.get("code");
    if (query.get("error") || !code || code.length > 4096) {
      throw new GitHubLinkError("github_link_state_invalid", "Entra sign-in did not complete.");
    }
    const signedIn = await this.options.entra.completeSignIn({
      code,
      codeVerifier: entry.codeVerifier as string,
      nonce: entry.oidcNonce as string,
      redirectUri: `${this.baseUrl}${LINK_ENTRA_CALLBACK_PATH}`,
    });
    if (!samePrincipal(signedIn, entry.principal)) {
      this.options.logger?.warn("github_link.principal_mismatch", {
        expected: this.principalTag(entry.principal),
        actual: this.principalTag(signedIn),
      });
      throw new GitHubLinkError(
        "github_link_principal_mismatch",
        "The signed-in user is not the user who requested this link.",
      );
    }
    const state = randomBytes(32).toString("base64url");
    const pkce = newPkce();
    await this.flows.put(this.flowKey("github", state), {
      kind: "github",
      principal: entry.principal,
      allowRebind: entry.allowRebind,
      linkGeneration: entry.linkGeneration,
      expiresAtMs: this.now() + this.flowTtlMs,
      codeVerifier: pkce.codeVerifier,
      browserHash: entry.browserHash,
    });
    return redirectResponse(
      this.options.oauth.buildAuthorizeUrl(state, `${this.baseUrl}${LINK_GITHUB_CALLBACK_PATH}`, {
        codeChallenge: pkce.codeChallenge,
      }),
    );
  }

  private async handleGitHubCallback(query: URLSearchParams, req: HttpRequestLike): Promise<HttpResponseLike> {
    const entry = await this.takeFlow("github", query.get("state"));
    this.requireBrowser(entry, req);
    const code = query.get("code");
    if (query.get("error") || !code || code.length > 4096) {
      throw new GitHubLinkError("github_link_state_invalid", "GitHub authorization did not complete.");
    }
    const tokens = await this.options.oauth.exchangeCode(code, `${this.baseUrl}${LINK_GITHUB_CALLBACK_PATH}`, {
      codeVerifier: entry.codeVerifier as string,
    });
    this.registerTokenSecrets(tokens);
    try {
      const user = await this.options.oauth.getUser(tokens.accessToken);
      const existing = await this.options.store.get(principalKeyOf(entry.principal));
      this.requireFlowGeneration(entry, existing);
      if (existing && existing.record.state !== "unlinked" && existing.record.githubUserId !== user.id) {
        const state = randomBytes(32).toString("base64url");
        await this.flows.put(this.flowKey("confirm", state), {
          ...entry, kind: "confirm", expiresAtMs: this.now() + this.flowTtlMs,
          pendingTokens: this.sealer.seal(credentialBinding(principalKeyOf(entry.principal),
            { githubUserId: user.id, linkGeneration: entry.linkGeneration }), "pending", JSON.stringify(tokens)), pendingUser: user,
        });
        return consentPage(LINK_CONFIRM_PATH, { state, csrf: parseCookie(req.headers.cookie, COOKIE_NAME)! }, true, {},
          { from: existing.record.githubLogin, to: user.login });
      }
      await this.completeLink(entry.principal, tokens, user, false, entry.linkGeneration);
    } catch (error) {
      // The just-issued token is not going to be stored; do not leave it live at GitHub.
      await this.revokeUnused(tokens.accessToken);
      throw error;
    }
    return successPage({ "set-cookie": this.clearCookie() });
  }

  private requireFlowGeneration(entry: LinkFlowEntry, existing: StoredGitHubLink | undefined): void {
    if (!existing || !entry.linkGeneration || this.generation(existing.record) !== entry.linkGeneration) {
      throw new GitHubLinkError("github_link_state_invalid");
    }
  }

  private async handleConfirm(form: URLSearchParams, req: HttpRequestLike): Promise<HttpResponseLike> {
    const entry = await this.takeFlow("confirm", form.get("state"));
    this.requireBrowser(entry, req);
    if (!entry.pendingTokens || !entry.pendingUser) throw new GitHubLinkError("github_link_state_invalid");
    const tokens = JSON.parse(this.sealer.open(credentialBinding(principalKeyOf(entry.principal),
      { githubUserId: entry.pendingUser.id, linkGeneration: entry.linkGeneration }), "pending", entry.pendingTokens)) as GitHubTokenSet;
    try {
      await this.completeLink(entry.principal, tokens, entry.pendingUser, true, entry.linkGeneration);
    } catch (error) {
      await this.revokeUnused(tokens.accessToken);
      throw error;
    }
    return successPage({ "set-cookie": this.clearCookie() });
  }

  private async completeLink(
    principal: UserPrincipal,
    tokens: GitHubTokenSet,
    user: GitHubUser,
    allowRebind: boolean,
    expectedGeneration: string | undefined,
  ): Promise<void> {
    const key = principalKeyOf(principal);
    for (let attempt = 0; attempt < 3; attempt++) {
      const existing = await this.options.store.get(key);
      this.requireFlowGeneration({ linkGeneration: expectedGeneration } as LinkFlowEntry, existing);
      if (existing) {
        this.requireRecordMatches(existing.record, principal);
        if (existing.record.state !== "unlinked" && existing.record.githubUserId !== user.id && !allowRebind) {
          this.lastErrors.set(key, "github_identity_changed");
          this.log("warn", "github_link.identity_changed", principal);
          throw new GitHubLinkError(
            "github_identity_changed",
            "A different GitHub account is already linked; explicit confirmation is required.",
          );
        }
      }
      const nowIso = new Date(this.now()).toISOString();
      const linkGeneration = randomBytes(24).toString("base64url");
      const binding = credentialBinding(key, { githubUserId: user.id, linkGeneration });
      const record: GitHubLinkRecord = {
        tenantId: principal.tenantId,
        oid: principal.objectId,
        githubUserId: user.id,
        githubLogin: user.login,
        tokenKind: tokens.tokenKind,
        accessTokenEnc: this.sealer.seal(binding, "access", tokens.accessToken),
        credentialVersion: (existing?.record.credentialVersion ?? 0) + 1,
        linkedAt: existing && existing.record.githubUserId === user.id ? existing.record.linkedAt : nowIso,
        updatedAt: nowIso,
        state: "active",
        linkGeneration,
      };
      if (tokens.refreshToken) record.refreshTokenEnc = this.sealer.seal(binding, "refresh", tokens.refreshToken);
      if (tokens.expiresInSeconds !== undefined) {
        record.accessExpiresAt = new Date(this.now() + tokens.expiresInSeconds * 1000).toISOString();
      }
      if (tokens.refreshToken && tokens.refreshExpiresInSeconds !== undefined) {
        record.refreshExpiresAt = new Date(this.now() + tokens.refreshExpiresInSeconds * 1000).toISOString();
      }
      let result: PutResult;
      try { result = await this.options.store.putIfMatch(record, existing?.etag); }
      catch {
        const receipt = await this.options.store.get(key);
        if (receipt && receipt.record.linkGeneration === record.linkGeneration && receipt.record.accessTokenEnc === record.accessTokenEnc) {
          result = { ok: true, etag: receipt.etag };
        } else throw new GitHubLinkError("github_token_refresh_conflict", "GitHub link persistence could not be confirmed.");
      }
      if (result.ok) {
        this.locallyUnlinked.delete(key);
        this.lastErrors.delete(key);
        this.log("info", "github_link.linked", principal, { githubUserId: user.id });
        if (existing && existing.record.state !== "unlinked" && existing.record.githubUserId !== user.id) {
          await this.revokeOld(key, existing.record);
        }
        return;
      }
    }
    throw new GitHubLinkError("github_token_refresh_conflict", "The link changed concurrently; try again.");
  }

  private async revokeUnused(accessToken: string): Promise<void> {
    const revoke = this.options.revoke ?? this.options.oauth.revoke?.bind(this.options.oauth);
    try {
      await revoke?.(accessToken);
    } catch {
      // best effort
    }
  }

  private async revokeOld(key: string, record: GitHubLinkRecord): Promise<void> {
    const revoke = this.options.revoke ?? this.options.oauth.revoke?.bind(this.options.oauth);
    if (!revoke) {
      return;
    }
    try {
      await revoke(this.sealer.open(credentialBinding(key, record), "access", record.accessTokenEnc));
    } catch {
      // best effort
    }
  }

  // ---------------------------------------------------------------- helpers

  private flowKey(kind: FlowKind, value: string): string {
    return `${kind}:${sha256Hex(value)}`;
  }

  private async takeFlow(kind: FlowKind, value: string | null): Promise<LinkFlowEntry> {
    if (!value || !TOKEN_PATTERN.test(value)) {
      throw new GitHubLinkError("github_link_state_invalid", "The link is invalid or expired.");
    }
    const entry = await this.flows.take(this.flowKey(kind, value), this.now());
    if (!entry || entry.kind !== kind) {
      throw new GitHubLinkError("github_link_state_invalid", "The link is invalid, expired or already used.");
    }
    return entry;
  }

  private requireBrowser(entry: LinkFlowEntry, req: HttpRequestLike): void {
    const cookie = parseCookie(req.headers.cookie, COOKIE_NAME);
    if (!cookie || !entry.browserHash || !equalHex(sha256Hex(cookie), entry.browserHash)) {
      throw new GitHubLinkError("github_link_state_invalid", "This browser did not start the link.");
    }
  }

  private cookieAttributes(): string {
    return `Path=/github/link; HttpOnly; SameSite=Lax${this.secureCookies ? "; Secure" : ""}`;
  }

  private setCookie(value: string): string {
    return `${COOKIE_NAME}=${value}; ${this.cookieAttributes()}; Max-Age=${Math.ceil(this.flowTtlMs / 1000)}`;
  }

  private clearCookie(): string {
    return `${COOKIE_NAME}=; ${this.cookieAttributes()}; Max-Age=0`;
  }

  private principalTag(principal: UserPrincipal): string {
    return sha256Hex(principalKeyOf(principal)).slice(0, 12);
  }

  private log(level: "info" | "warn" | "error", message: string, principal: UserPrincipal, fields: Record<string, unknown> = {}): void {
    this.options.logger?.[level](message, { principal: this.principalTag(principal), ...fields });
  }
}
