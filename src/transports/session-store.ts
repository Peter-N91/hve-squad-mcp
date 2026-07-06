/**
 * Identity-bound session store (SEC-8).
 *
 * Streamable HTTP sessions are identified by an `Mcp-Session-Id`. To satisfy the
 * council's SEC-8 condition the id must be:
 *
 *   * **Unguessable** — generated from a CSPRNG (`randomBytes`), not a counter or
 *     timestamp, so it cannot be predicted or enumerated.
 *   * **Bound to the authenticated identity** — a session created by one
 *     tenant/subject cannot be replayed by another. `validate` rejects a session
 *     id presented under a different identity even if the id itself is correct.
 *
 * Sessions also expire after an idle window so a leaked id has a bounded life.
 * This store is in-memory (per process); a multi-replica deployment would back it
 * with a shared store, but the thin slice runs scale-to-zero with low concurrency.
 */
import { randomBytes } from "node:crypto";

import type { AuthContext } from "../auth/entra.js";

export interface SessionRecord {
  readonly id: string;
  /** The identity this session is bound to (`tenantId|subject`). */
  readonly identityKey: string;
  readonly createdAt: number;
  lastSeen: number;
}

/** The identity key a session is bound to (SEC-8 binding). */
export function identityKeyOf(auth: AuthContext): string {
  return `${auth.tenantId}|${auth.subject}`;
}

export interface SessionStoreOptions {
  /** Idle timeout (ms) after which a session is invalid. */
  idleMs: number;
  /** Clock injection for tests (default `Date.now`). */
  now?: () => number;
}

export class SessionStore {
  private readonly idleMs: number;
  private readonly now: () => number;
  private readonly sessions = new Map<string, SessionRecord>();

  constructor(options: SessionStoreOptions) {
    this.idleMs = options.idleMs;
    this.now = options.now ?? Date.now;
  }

  /** Create a new session bound to the caller's identity, with a CSPRNG id. */
  create(auth: AuthContext): SessionRecord {
    const now = this.now();
    const record: SessionRecord = {
      id: randomBytes(32).toString("base64url"),
      identityKey: identityKeyOf(auth),
      createdAt: now,
      lastSeen: now,
    };
    this.sessions.set(record.id, record);
    return record;
  }

  /**
   * Validate a presented session id against the CURRENT caller identity. Returns
   * true only when the id exists, is not idle-expired, and is bound to the same
   * identity. A mismatched identity is treated as invalid (and the stale record
   * left untouched — it belongs to the original identity).
   */
  validate(id: string | undefined, auth: AuthContext): boolean {
    if (!id) {
      return false;
    }
    const record = this.sessions.get(id);
    if (!record) {
      return false;
    }
    const now = this.now();
    if (now - record.lastSeen > this.idleMs) {
      this.sessions.delete(id);
      return false;
    }
    if (record.identityKey !== identityKeyOf(auth)) {
      // SEC-8: an id minted for another identity cannot be replayed here.
      return false;
    }
    record.lastSeen = now;
    return true;
  }

  /** Explicitly end a session (the DELETE verb). */
  delete(id: string | undefined): void {
    if (id) {
      this.sessions.delete(id);
    }
  }

  /** Current live session count (test/observability helper). */
  get size(): number {
    return this.sessions.size;
  }
}
