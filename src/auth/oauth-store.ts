/**
 * One-time OAuth grant storage.
 *
 * Login, authorization, and refresh codes are opaque CSPRNG values. Stores receive
 * the raw value only at their trust boundary and index it by SHA-256, so neither a
 * file nor Azure Table backend persists a reusable credential.
 */
import { createHash } from "node:crypto";

export type OAuthGrantKind =
  | "login"
  | "authorization"
  | "refresh"
  | "refresh-family";

export interface OAuthStoredGrant {
  /** Encrypted/signed payload owned by the OAuth authority. */
  payload: string;
  /** Epoch milliseconds after which the record is invalid. */
  expiresAt: number;
}

export interface OAuthGrantStore {
  /** Store a new one-time grant. A duplicate secret must fail rather than replace. */
  put(kind: OAuthGrantKind, secret: string, grant: OAuthStoredGrant): Promise<void>;
  /** Atomically consume a grant. Exactly one concurrent caller may receive it. */
  consume(kind: OAuthGrantKind, secret: string): Promise<OAuthStoredGrant | undefined>;
  /**
   * Atomically replace an active grant with a replay tombstone. A concurrent or
   * later caller receives the tombstone rather than racing a separate insert.
   */
  consumeWithTombstone(
    kind: OAuthGrantKind,
    secret: string,
    makeTombstone: (grant: OAuthStoredGrant) => OAuthStoredGrant,
  ): Promise<
    | { status: "consumed"; grant: OAuthStoredGrant }
    | { status: "replayed"; tombstone: OAuthStoredGrant }
    | undefined
  >;
  /** ETag-CAS update of a persistent grant such as refresh-family state. */
  update(
    kind: OAuthGrantKind,
    secret: string,
    transform: (grant: OAuthStoredGrant) => OAuthStoredGrant | undefined,
  ): Promise<"updated" | "missing" | "rejected">;
  /** Delete a bounded number of expired grants; returns the number removed. */
  sweepExpired(limit?: number): Promise<number>;
}

/** Stable, non-reversible row key for an OAuth secret. */
export function oauthSecretHash(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/** In-memory implementation for tests and explicitly single-process development. */
export class InMemoryOAuthGrantStore implements OAuthGrantStore {
  private readonly grants = new Map<
    string,
    { grant: OAuthStoredGrant; consumed: boolean }
  >();

  constructor(private readonly now: () => number = Date.now) {}

  async put(kind: OAuthGrantKind, secret: string, grant: OAuthStoredGrant): Promise<void> {
    const key = `${kind}:${oauthSecretHash(secret)}`;
    if (this.grants.has(key)) {
      throw new Error("OAuth grant collision.");
    }
    this.grants.set(key, { grant, consumed: false });
  }

  async consume(kind: OAuthGrantKind, secret: string): Promise<OAuthStoredGrant | undefined> {
    const key = `${kind}:${oauthSecretHash(secret)}`;
    const entry = this.grants.get(key);
    if (!entry) {
      return undefined;
    }
    this.grants.delete(key);
    return !entry.consumed && entry.grant.expiresAt > this.now()
      ? entry.grant
      : undefined;
  }

  async consumeWithTombstone(
    kind: OAuthGrantKind,
    secret: string,
    makeTombstone: (grant: OAuthStoredGrant) => OAuthStoredGrant,
  ): Promise<
    | { status: "consumed"; grant: OAuthStoredGrant }
    | { status: "replayed"; tombstone: OAuthStoredGrant }
    | undefined
  > {
    const key = `${kind}:${oauthSecretHash(secret)}`;
    const entry = this.grants.get(key);
    if (!entry || entry.grant.expiresAt <= this.now()) {
      this.grants.delete(key);
      return undefined;
    }
    if (entry.consumed) {
      return { status: "replayed", tombstone: entry.grant };
    }
    const original = entry.grant;
    this.grants.set(key, { grant: makeTombstone(original), consumed: true });
    return { status: "consumed", grant: original };
  }

  async update(
    kind: OAuthGrantKind,
    secret: string,
    transform: (grant: OAuthStoredGrant) => OAuthStoredGrant | undefined,
  ): Promise<"updated" | "missing" | "rejected"> {
    const key = `${kind}:${oauthSecretHash(secret)}`;
    const entry = this.grants.get(key);
    if (!entry || entry.grant.expiresAt <= this.now()) {
      this.grants.delete(key);
      return "missing";
    }
    if (entry.consumed) {
      return "rejected";
    }
    const updated = transform(entry.grant);
    if (!updated) {
      return "rejected";
    }
    this.grants.set(key, { grant: updated, consumed: false });
    return "updated";
  }

  async sweepExpired(limit = 100): Promise<number> {
    let removed = 0;
    for (const [key, entry] of this.grants) {
      if (removed >= limit) {
        break;
      }
      if (entry.grant.expiresAt <= this.now()) {
        this.grants.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
}
