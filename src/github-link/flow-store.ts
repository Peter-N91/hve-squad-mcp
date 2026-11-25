import type { UserPrincipal } from "../auth/entra.js";

export type FlowKind = "link" | "entra" | "github" | "confirm";

/** One step of the linking flow. Bound to a single principal; consumed exactly once. */
export interface LinkFlowEntry {
  kind: FlowKind;
  principal: UserPrincipal;
  /** Operator-confirmed permission to replace an existing link with a different GitHub account. */
  allowRebind: boolean;
  expiresAtMs: number;
  /** PKCE verifier for the Entra (kind=entra) or GitHub (kind=github) leg. */
  codeVerifier?: string;
  /** OIDC nonce expected in the Entra id_token (kind=entra). */
  oidcNonce?: string;
  /** sha256 of the browser-binding cookie set at /start (kind=entra, github). */
  browserHash?: string;
  linkGeneration?: string;
  pendingTokens?: string;
  pendingUser?: { id: number; login: string };
}

/**
 * Single-use flow state. `take` MUST be atomic: return the entry and remove it in
 * one step so a replay (or a race between two replicas) gets undefined. Keys are
 * already hashed by the service, so the store never sees a raw nonce or state.
 *
 * The in-memory implementation is per process. With more than one web replica the
 * browser can land on a different replica between legs, so production needs a
 * shared implementation (Azure Table: insert on put, delete-with-ETag on take,
 * reject when the delete returns 404/412, plus a TTL sweep).
 */
export interface LinkFlowStore {
  put(key: string, entry: LinkFlowEntry): Promise<void>;
  take(key: string, nowMs: number): Promise<LinkFlowEntry | undefined>;
}

export class InMemoryLinkFlowStore implements LinkFlowStore {
  private readonly entries = new Map<string, LinkFlowEntry>();
  constructor(private readonly now: () => number = Date.now) {}

  async put(key: string, entry: LinkFlowEntry): Promise<void> {
    const now = this.now();
    if (!Number.isFinite(entry.expiresAtMs) || entry.expiresAtMs > now + 600_000) throw new Error("Invalid link flow lifetime.");
    for (const [existingKey, existing] of this.entries) {
      if (existing.expiresAtMs <= now) {
        this.entries.delete(existingKey);
      }
    }
    if (this.entries.has(key)) throw new Error("Link flow entry already exists.");
    if (this.entries.size >= 10_000) throw new Error("Link flow capacity exceeded.");
    this.entries.set(key, structuredClone(entry));
  }

  async take(key: string, nowMs: number): Promise<LinkFlowEntry | undefined> {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    this.entries.delete(key);
    return entry.expiresAtMs > nowMs ? entry : undefined;
  }
}
