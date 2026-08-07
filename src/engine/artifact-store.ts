/**
 * Squad ARTIFACT store — the `.copilot-tracking` tree, persisted.
 *
 * Auto-memory persists three flat keys per project (`state`, `decisions`, and
 * `history/<toolId>-<runId>`). That is enough for continuity between two turns
 * and nothing like what a squad run under GitHub Copilot leaves behind: a roster
 * in `team.md`, a routing table, `state.json`, an append-only decision log, one
 * history file per agent, a consumption ledger, and a deliverable under each
 * role's own root (`research/<date>/`, `plans/`, `ppt/<date>/<slug>/`, `docs/`).
 * A Copilot Studio user who pushes a backlog out through a connector has to be
 * able to open the run that produced it afterwards, and flat keys cannot be
 * browsed.
 *
 * This seam adds TREE semantics — a prefix listing — on top of the stores that
 * already exist, rather than a sixth storage backend:
 *
 *   * {@link MemoryBackedArtifactStore} adapts ANY {@link SquadMemoryStore}, so
 *     the filesystem, Azure Table, SharePoint/Graph, the caller-selectable
 *     target allow-list, and the >32 KiB blob-overflow decorator ALL become
 *     artifact backends for free, keeping the tenant isolation, the CAS write,
 *     the traversal guards, and the at-rest encryption those stores already
 *     carry rather than re-implementing (and re-auditing) each one.
 *
 * Paths are stored with their `.copilot-tracking/` prefix intact. It is one
 * redundant segment against a real benefit: what the Graph and filesystem
 * backends write is then byte-for-byte the tree a developer already browses
 * locally, so "read the history" is the same operation in both places.
 */
import {
  isSafeMemoryPath,
  type SquadMemoryEntry,
  type SquadMemoryStore,
} from "./squad-memory-state.js";

/** The tracking root every squad artifact path is written under. */
export const TRACKING_ROOT = ".copilot-tracking";

/** The squad-state directory within the tracking root. */
export const SQUAD_STATE_ROOT = `${TRACKING_ROOT}/squad`;

/** One stored artifact, content included. */
export interface SquadArtifact {
  readonly tenantId: string;
  readonly project: string;
  /** Tree path including the tracking root, e.g. `.copilot-tracking/plans/x.md`. */
  readonly path: string;
  readonly content: string;
  /** The opaque CAS token for the NEXT write of this path. */
  readonly etag: string;
  readonly updatedAt: number;
}

/** One entry in a listing — metadata only, so a large tree is cheap to browse. */
export interface SquadArtifactListEntry {
  readonly path: string;
  readonly size: number;
  readonly updatedAt: number;
}

/** A lost CAS race on {@link SquadArtifactStore.put}. */
export interface SquadArtifactConflict {
  readonly ok: false;
  readonly conflict: true;
  readonly current: SquadArtifact | undefined;
}

/** A successful {@link SquadArtifactStore.put}. */
export interface SquadArtifactWritten {
  readonly ok: true;
  readonly artifact: SquadArtifact;
}

export type SquadArtifactWriteResult = SquadArtifactWritten | SquadArtifactConflict;

/**
 * The tree-shaped store the squad writes its run output through.
 *
 * `tenantId` is FIRST on every method for the same reason it is on the memory
 * seam: the isolation key comes from the validated Entra token and is never
 * derivable from caller input.
 */
export interface SquadArtifactStore {
  /**
   * Create or replace an artifact. With `expectedEtag` the write applies only if
   * it matches the current revision; without it the write is an upsert.
   */
  put(
    tenantId: string,
    project: string,
    path: string,
    content: string,
    expectedEtag?: string,
  ): Promise<SquadArtifactWriteResult>;
  /** Read one artifact, or `undefined` when it does not exist. */
  get(tenantId: string, project: string, path: string): Promise<SquadArtifact | undefined>;
  /**
   * List artifacts under a path prefix, lexicographically by path. An omitted
   * prefix lists the whole project tree.
   */
  list(tenantId: string, project: string, prefix?: string): Promise<SquadArtifactListEntry[]>;
  /** Append a line/block to an append-only artifact, creating it when absent. */
  append(tenantId: string, project: string, path: string, block: string): Promise<SquadArtifact>;
}

/**
 * Reject a path that is unsafe or escapes the tracking root.
 *
 * The traversal guard is the memory seam's (`isSafeMemoryPath`), so both surfaces
 * enforce one rule. The root check is the artifact-specific half: a run must not
 * be able to write outside the tree the operator agreed to expose, and `docs/`
 * and `outputs/` are the two deliverable roots the roster deliberately keeps at
 * the repository root, so both are allowed alongside it.
 */
const ALLOWED_ROOTS = [TRACKING_ROOT, "docs", "outputs"];

export function assertSafeArtifactPath(path: string): void {
  if (!isSafeMemoryPath(path)) {
    throw new Error(`Unsafe artifact path: ${JSON.stringify(path)}.`);
  }
  const root = path.split("/")[0];
  if (!ALLOWED_ROOTS.includes(root)) {
    throw new Error(
      `Artifact path must sit under ${ALLOWED_ROOTS.join(", ")} — got ${JSON.stringify(path)}.`,
    );
  }
}

/** Maximum characters retained in a single artifact. */
export const ARTIFACT_MAX_CHARS = 256_000;

/** Maximum CAS attempts for an append before giving up. */
const APPEND_CAS_ATTEMPTS = 4;

function toArtifact(entry: SquadMemoryEntry): SquadArtifact {
  return {
    tenantId: entry.tenantId,
    project: entry.project,
    path: entry.path,
    content: entry.content,
    etag: entry.etag,
    updatedAt: entry.updatedAt,
  };
}

/**
 * A {@link SquadArtifactStore} over any {@link SquadMemoryStore}.
 *
 * The memory seam is already a keyed `read`/`write`/`list` with CAS and tenant
 * isolation; the only thing it lacks for a tree is a prefix filter, which is
 * applied here. Every existing backend therefore becomes an artifact backend
 * with no new credential path, no new traversal surface, and no second
 * encryption implementation to audit.
 */
export class MemoryBackedArtifactStore implements SquadArtifactStore {
  /**
   * One promise chain per `tenant/project/path`, so two appends to the same log
   * inside this process are serialized rather than racing.
   *
   * This is needed because the memory seam has no create-if-absent: `write` with
   * no `expectedEtag` is an unconditional upsert, so the FIRST two writers to a
   * path cannot be arbitrated by compare-and-swap and one would silently
   * overwrite the other. Every subsequent append does hold a real CAS token, and
   * {@link SquadLedger.seed} pre-creates the shared logs so the unarbitrated
   * window closes for them at seed time.
   */
  private readonly appendQueues = new Map<string, Promise<unknown>>();

  constructor(private readonly store: SquadMemoryStore) {}

  async put(
    tenantId: string,
    project: string,
    path: string,
    content: string,
    expectedEtag?: string,
  ): Promise<SquadArtifactWriteResult> {
    assertSafeArtifactPath(path);
    const bounded =
      content.length <= ARTIFACT_MAX_CHARS
        ? content
        : `${content.slice(0, ARTIFACT_MAX_CHARS)}\n…(truncated)…`;
    const result = await this.store.write(tenantId, project, path, bounded, expectedEtag);
    if (!result.ok) {
      return {
        ok: false,
        conflict: true,
        current: result.current ? toArtifact(result.current) : undefined,
      };
    }
    return { ok: true, artifact: toArtifact(result.entry) };
  }

  async get(
    tenantId: string,
    project: string,
    path: string,
  ): Promise<SquadArtifact | undefined> {
    assertSafeArtifactPath(path);
    const entry = await this.store.read(tenantId, project, path);
    return entry ? toArtifact(entry) : undefined;
  }

  async list(
    tenantId: string,
    project: string,
    prefix?: string,
  ): Promise<SquadArtifactListEntry[]> {
    const entries = await this.store.list(tenantId, project);
    const normalized = prefix?.replace(/\/+$/, "");
    return entries
      .filter((entry) =>
        normalized ? entry.path === normalized || entry.path.startsWith(`${normalized}/`) : true,
      )
      .map((entry) => ({
        path: entry.path,
        size: entry.content.length,
        updatedAt: entry.updatedAt,
      }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * Append under compare-and-swap.
   *
   * `decisions.md`, `notifications.md`, and `history/<agent>.md` are append-only
   * in `squad-state.instructions.md` — "new entries are added to the end; prior
   * entries are never edited or removed". Two roles finishing at once would
   * otherwise last-write-wins one of them away, which is exactly the silent loss
   * the append-only rule exists to prevent.
   */
  append(
    tenantId: string,
    project: string,
    path: string,
    block: string,
  ): Promise<SquadArtifact> {
    assertSafeArtifactPath(path);
    const key = `${tenantId}/${project}/${path}`;
    const previous = this.appendQueues.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.appendOnce(tenantId, project, path, block));
    this.appendQueues.set(key, next);
    // Drop the chain once it drains so a long-lived server does not retain a
    // queue entry for every path it has ever written.
    void next.catch(() => undefined).finally(() => {
      if (this.appendQueues.get(key) === next) {
        this.appendQueues.delete(key);
      }
    });
    return next;
  }

  private async appendOnce(
    tenantId: string,
    project: string,
    path: string,
    block: string,
  ): Promise<SquadArtifact> {
    let lastConflict: SquadArtifact | undefined;
    for (let attempt = 0; attempt < APPEND_CAS_ATTEMPTS; attempt += 1) {
      const current = await this.get(tenantId, project, path);
      const next = current ? `${current.content.replace(/\s*$/, "")}\n\n${block}\n` : `${block}\n`;
      const result = await this.put(tenantId, project, path, next, current?.etag);
      if (result.ok) {
        return result.artifact;
      }
      lastConflict = result.current;
    }
    throw new Error(
      `Could not append to ${path} after ${APPEND_CAS_ATTEMPTS} attempts (last revision ` +
        `${lastConflict?.etag ?? "unknown"}).`,
    );
  }
}
