/**
 * Squad memory-store seam (shared-state broker — DR-01 / DR-03).
 *
 * The Scenario B broker exposes the project's own `.copilot-tracking/squad/`
 * memory + history as scope-guarded, tenant-isolated MCP resources plus a
 * compare-and-swap (CAS) write-back tool. This module defines the persistence
 * ENTITY and the store SEAM the broker reads/writes through, deliberately
 * SEPARATE from the run-shaped {@link import("./run-state.js").RunState} (a memory
 * entry is not a run — DR-03 forbids overloading `RunState`).
 *
 * Two realizations land beside this seam, mirroring the run-state stores:
 *   * `file`  — {@link import("./backends/file-squad-memory.js").FileSquadMemoryStore}
 *     (single-replica, directory-backed; dev / single-instance).
 *   * `table` — {@link import("./backends/azure-table-squad-memory.js").AzureTableSquadMemoryStore}
 *     (Azure Table Storage with ETag CAS; multi-replica / production).
 *
 * Security posture (held by BOTH realizations):
 *   * Tenant isolation — the store key is ALWAYS prefixed with the authenticated
 *     `tenantId` (from the validated Entra token, never caller input). `project`
 *     is an explicit input (shape-checked at the protocol layer in later phases);
 *     the stores additionally reject unsafe segments so a traversal payload can
 *     never reach the filesystem / a foreign partition (SEC-4, defense in depth).
 *   * Encryption at rest — `content` is caller/model text, so both stores encrypt
 *     it with the injected {@link import("./field-cipher.js").FieldCipher} exactly
 *     as the run-state stores protect `request`/`context` (MEDIUM-3).
 *   * CAS — `write` takes an optional `expectedEtag`; a stale token loses the
 *     race (a 412 in the table store, an etag mismatch in the file store) so a
 *     concurrent writer never silently clobbers another's write.
 */

/**
 * One persisted squad-memory record. `path` is the logical location within a
 * project's memory (e.g. `state`, `decisions`, `history/<agent>`,
 * `repo-memory/<name>`); `etag` is the opaque CAS token for the NEXT write.
 */
export interface SquadMemoryEntry {
  /** The owning tenant — the isolation key (from the validated Entra token). */
  readonly tenantId: string;
  /** The project namespace within the tenant (shape-checked caller input). */
  readonly project: string;
  /** The logical memory path (e.g. `state`, `history/<agent>`). */
  readonly path: string;
  /** The decrypted content of the entry. */
  readonly content: string;
  /** The opaque CAS token identifying this revision (pass as `expectedEtag`). */
  readonly etag: string;
  /** Epoch ms the entry was last written. */
  readonly updatedAt: number;
}

/** A successful {@link SquadMemoryStore.write}: the new CAS token + persisted entry. */
export interface SquadMemoryWriteOk {
  readonly ok: true;
  /** The new etag AFTER the write — the CAS token to pass on the next write. */
  readonly etag: string;
  /** The persisted entry (decrypted view). */
  readonly entry: SquadMemoryEntry;
}

/**
 * A lost {@link SquadMemoryStore.write} CAS race: the caller's `expectedEtag` did
 * not match the current revision (or the entry was gone). `current` is the entry
 * the caller lost to (undefined when the entry no longer exists), so the caller
 * can re-read and retry.
 */
export interface SquadMemoryWriteConflict {
  readonly ok: false;
  readonly conflict: true;
  readonly current: SquadMemoryEntry | undefined;
}

/** The discriminated result of a {@link SquadMemoryStore.write}. */
export type SquadMemoryWriteResult = SquadMemoryWriteOk | SquadMemoryWriteConflict;

/**
 * The store seam the broker reads/writes through. Interface-first (mirroring
 * {@link import("./run-state.js").RunStateStore}) so the file + table realizations
 * are drop-in and the resource/tool layers never depend on a concrete backend.
 * Every method takes `tenantId` FIRST — the isolation key is never derivable from
 * caller input.
 */
export interface SquadMemoryStore {
  /** List every entry for a `tenantId:project` partition (empty when none). */
  list(tenantId: string, project: string): Promise<SquadMemoryEntry[]>;
  /**
   * Optionally list entries updated at or after an epoch-millisecond boundary.
   * Decorators can use this to avoid rehydrating old overflow payloads.
   */
  listUpdatedSince?(
    tenantId: string,
    project: string,
    updatedAt: number,
  ): Promise<SquadMemoryEntry[]>;
  /** Read a single entry, or `undefined` when it does not exist. */
  read(tenantId: string, project: string, path: string): Promise<SquadMemoryEntry | undefined>;
  /**
   * Write (create or replace) an entry under CAS. When `expectedEtag` is provided
   * the write applies only if it matches the current revision (else a conflict);
   * when omitted the write is an unconditional upsert (first-write / overwrite).
   */
  write(
    tenantId: string,
    project: string,
    path: string,
    content: string,
    expectedEtag?: string,
  ): Promise<SquadMemoryWriteResult>;
  /** List the distinct project namespaces that exist for a tenant. */
  listProjects(tenantId: string): Promise<string[]>;
}

/** A single safe path segment: alphanumerics plus `.`, `_`, `-` (no traversal). */
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * True when a memory `path` is safe to use as a store key / filesystem location:
 * one or more `/`-joined {@link SAFE_SEGMENT}s with no empty, `.`, or `..`
 * segment. This is the SEC-4 traversal guard both stores apply before a caller
 * `path` reaches the filesystem or a table RowKey (defense in depth; the protocol
 * layer shape-checks inputs separately in later phases).
 */
export function isSafeMemoryPath(path: string): boolean {
  if (path.length === 0) {
    return false;
  }
  const segments = path.split("/");
  return segments.every(
    (segment) => segment !== "." && segment !== ".." && SAFE_SEGMENT.test(segment),
  );
}

/**
 * True when a tenant/project identifier is a single safe segment (no `/`, no
 * traversal). `tenantId` is a validated Entra tenant id and `project` is
 * shape-checked at the protocol layer, but the stores re-check so a bad value can
 * never escape its partition / directory. Dot-segments (`.` / `..`) are rejected
 * even though they match {@link SAFE_SEGMENT}'s character class: a bare `..`
 * segment would otherwise collapse under `path.join` in the file backend and let
 * a caller escape its tenant/project directory into a foreign partition (SEC-4).
 */
export function isSafeMemorySegment(segment: string): boolean {
  return segment !== "." && segment !== ".." && SAFE_SEGMENT.test(segment);
}
