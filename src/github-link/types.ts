/**
 * Per-user GitHub account linking: shared types.
 *
 * The caller identity on /mcp is an Entra delegated token resolved to
 * {tenantId, objectId} ({@link UserPrincipal}). GitHub credentials are a SECOND,
 * separately consented credential: Entra OBO cannot mint GitHub tokens, so the
 * server stores a link `tenantId|oid <-> immutable GitHub numeric user id` plus
 * encrypted GitHub user tokens. Entra `sub` is pairwise per client app and is
 * never used; only `oid`.
 */
import type { UserPrincipal } from "../auth/entra.js";

export type { UserPrincipal };

/** Stable failure codes surfaced to the MCP layer. None of them ever carries a token. */
export type GitHubLinkErrorCode =
  | "github_connection_required"
  | "github_reauthentication_required"
  | "github_identity_changed"
  | "github_link_state_invalid"
  | "github_link_principal_mismatch"
  | "github_token_refresh_conflict";

export class GitHubLinkError extends Error {
  readonly code: GitHubLinkErrorCode;

  constructor(code: GitHubLinkErrorCode, message?: string) {
    super(message ?? code);
    this.name = "GitHubLinkError";
    this.code = code;
  }

}

/** Local removal succeeded even though GitHub's revocation receipt is incomplete. */
export class GitHubUnlinkPartialError extends GitHubLinkError {
  readonly localUnlinked = true;
  constructor(readonly revocation: "failed" | "unavailable") {
    super("github_reauthentication_required",
      `GitHub disconnected locally, but upstream revocation ${revocation === "failed" ? "failed" : "was unavailable"}. Revoke the app in GitHub settings.`);
    this.name = "GitHubUnlinkPartialError";
  }
}

/** `ghu` = GitHub App user token, `gho` = OAuth app token, `other` = unrecognised prefix. */
export type GitHubTokenKind = "ghu" | "gho" | "other";

/** In-flight refresh lease stored on the row; see GitHubLinkService.tokenFor. */
export interface RefreshLease {
  id: string;
  expiresAt: string;
}

/**
 * The persisted link. Token fields hold FieldCipher ciphertext whose plaintext
 * is bound to the principal (see token-seal.ts). Everything else is non-secret
 * metadata.
 */
export interface GitHubLinkRecord {
  tenantId: string;
  oid: string;
  /** Immutable numeric GitHub user id; the login can be renamed, the id cannot. */
  githubUserId: number;
  githubLogin: string;
  tokenKind: GitHubTokenKind;
  accessTokenEnc: string;
  refreshTokenEnc?: string;
  /** ISO timestamp; absent for non-expiring OAuth app (gho_) tokens. */
  accessExpiresAt?: string;
  refreshExpiresAt?: string;
  /** Bumped on every token rotation or relink. */
  credentialVersion: number;
  linkedAt: string;
  updatedAt: string;
  /** Present only while one caller is refreshing; makes refresh single-flight across replicas. */
  refreshLease?: RefreshLease;
  /** Stable across refresh, replaced on every relink/unlink. */
  linkGeneration?: string;
  state?: "active" | "unlinked" | "reauth-required";
}

export interface StoredGitHubLink {
  record: GitHubLinkRecord;
  /** Opaque concurrency token. Compare for equality only. */
  etag: string;
}

export type PutResult = { ok: true; etag: string } | { ok: false };

/**
 * Optimistic-concurrency store keyed by `principalKeyOf(principal)`.
 *
 * Azure Table mapping (see azure-table-store.ts): PartitionKey = sha256(tenantId)
 * hex, RowKey = oid, one entity per principal with the record fields as
 * properties. `get` returns the entity plus `odata.etag` (request
 * `Accept: application/json;odata=fullmetadata`). `putIfMatch(record, undefined)`
 * is Insert Entity (HTTP 409 EntityAlreadyExists => `{ok:false}`);
 * `putIfMatch(record, etag)` is Update Entity (PUT) with `If-Match: <etag>`
 * (HTTP 412 => `{ok:false}`) and the new etag comes from the response `ETag`
 * header. `delete` is Delete Entity with `If-Match: <etag>`, or `*` when no etag is
 * given. Never use an unconditional upsert for token rows.
 */
export interface GitHubLinkStore {
  get(principalKey: string): Promise<StoredGitHubLink | undefined>;
  /** `expectedEtag === undefined` means "create only if absent". */
  putIfMatch(record: GitHubLinkRecord, expectedEtag: string | undefined): Promise<PutResult>;
  /** Returns true when a row was deleted. With `expectedEtag`, deletes only on a match. */
  delete(principalKey: string, expectedEtag?: string): Promise<boolean>;
}

export interface GitHubTokenSet {
  accessToken: string;
  tokenKind: GitHubTokenKind;
  expiresInSeconds?: number;
  refreshToken?: string;
  refreshExpiresInSeconds?: number;
}

export interface GitHubUser {
  id: number;
  login: string;
}

/** The OAuth operations GitHubLinkService needs; GitHubOAuthClient implements it. */
export interface GitHubOAuthPort {
  buildAuthorizeUrl(state: string, redirectUri: string, pkce?: { codeChallenge: string }): string;
  exchangeCode(code: string, redirectUri: string, pkce?: { codeVerifier: string }): Promise<GitHubTokenSet>;
  refresh(refreshToken: string): Promise<GitHubTokenSet>;
  getUser(accessToken: string): Promise<GitHubUser>;
  revoke?(accessToken: string): Promise<void>;
}

/** Why a GitHub OAuth call failed, without echoing any response text. */
export type GitHubOAuthFailureKind =
  /** The credential is dead (invalid/expired/revoked code or refresh token). */
  | "invalid_grant"
  /** Our client credentials or redirect URI are wrong. Operator problem. */
  | "configuration"
  /** Network failure, timeout, 5xx, 429 or an unparseable body. The outcome is unknown. */
  | "transient"
  | "other";

export class GitHubOAuthError extends Error {
  readonly kind: GitHubOAuthFailureKind;
  /** GitHub's short machine `error` value when it matched /^[a-z_]{1,64}$/. */
  readonly githubError?: string;

  constructor(kind: GitHubOAuthFailureKind, githubError?: string) {
    super(`GitHub OAuth request failed (${kind}${githubError ? `: ${githubError}` : ""}).`);
    this.name = "GitHubOAuthError";
    this.kind = kind;
    this.githubError = githubError;
  }
}

/** Minimal logger shape; RedactingLogger satisfies it. */
export interface LinkLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  registerSecret?(value: string | undefined | null): void;
}

export interface GitHubLinkStatus {
  linked: boolean;
  githubLogin?: string;
  githubUserId?: number;
  tokenKind?: GitHubTokenKind;
  accessExpiresAt?: string;
  linkGeneration?: string;
  reauthenticationRequired?: boolean;
  /** Last failed link attempt for this principal (this process only); e.g. github_identity_changed. */
  lastLinkError?: GitHubLinkErrorCode;
}

export interface TokenForOptions {
  reason: "initial" | "refresh";
  expectedGithubUserId?: number;
  expectedLinkGeneration?: string;
}

export interface TokenForResult {
  accessToken: string;
  /** Positive seconds remaining; 8h is reported for tokens with no expiry. */
  expiresInSeconds: number;
  githubUserId: number;
  credentialVersion: number;
  linkGeneration: string;
  /** True only when THIS call performed the GitHub refresh (observability). */
  refreshed: boolean;
}

/** The GitHub Copilot SDK `gitHubTokenProvider` shape. */
export type CopilotGitHubTokenProvider = (args: {
  reason: "initial" | "refresh";
  host?: string;
}) => Promise<{ kind: "token"; accessToken: string; expiresIn: number }>;
