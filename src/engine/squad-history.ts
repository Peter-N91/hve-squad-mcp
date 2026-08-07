/**
 * Reading a run's own history back.
 *
 * Auto-memory reads the tail of a rolling `state` digest — 8 000 characters of
 * one-line summaries. That is continuity for the next dispatch and nothing an
 * operator can audit: a Copilot Studio user who pushed a backlog out through a
 * connector cannot open the plan, the council verdict, or the per-role history
 * that produced it, because a flat digest has no structure to open.
 *
 * This module turns the persisted tree into two operations a host can actually
 * use — browse and open — plus a run INDEX that is cheap enough to inject at the
 * start of a run without spending the context window on artifact bodies.
 *
 * Everything here is READ-ONLY and tenant-scoped by construction: `tenantId`
 * comes from the validated Entra token at the call site and is the store's first
 * argument, exactly as it is on every write path.
 */
import {
  SQUAD_STATE_ROOT,
  TRACKING_ROOT,
  type SquadArtifactListEntry,
  type SquadArtifactStore,
} from "./artifact-store.js";
import { DECISIONS_PATH, STATE_PATH, type SquadStateJson } from "./squad-ledger.js";

/** Maximum artifacts returned by one listing, newest-path-last. */
export const HISTORY_LIST_LIMIT = 500;

/** Maximum characters returned for a single artifact read. */
export const HISTORY_READ_MAX_CHARS = 64_000;

/** Maximum characters of index injected into a prompt at run start. */
export const HISTORY_INDEX_MAX_CHARS = 4_000;

/** A single node in a browsable history listing. */
export interface HistoryEntry {
  path: string;
  size: number;
  updatedAt: number;
}

/** The compact picture of a project's prior work. */
export interface HistoryIndex {
  /** The profile the squad is cast under, when it has been seeded. */
  profile?: string;
  /** The current turn counter from `state.json`. */
  turn?: number;
  /** Deliverables grouped by their tracking directory. */
  deliverables: { directory: string; count: number; latest: string }[];
  /** Agents that have a history file, with their entry counts. */
  agents: string[];
  /** Total artifacts stored for the project. */
  total: number;
}

/** Read-only browsing over a persisted squad tree. */
export class SquadHistory {
  constructor(private readonly store: SquadArtifactStore) {}

  /** List artifacts under a prefix (whole project when omitted). */
  async list(
    tenantId: string,
    project: string,
    prefix?: string,
  ): Promise<HistoryEntry[]> {
    const entries = await this.store.list(tenantId, project, prefix);
    return entries.slice(0, HISTORY_LIST_LIMIT);
  }

  /** Read one artifact, bounded so a single read cannot blow the context window. */
  async read(
    tenantId: string,
    project: string,
    path: string,
  ): Promise<{ path: string; content: string; updatedAt: number } | undefined> {
    const artifact = await this.store.get(tenantId, project, path);
    if (!artifact) {
      return undefined;
    }
    const content =
      artifact.content.length <= HISTORY_READ_MAX_CHARS
        ? artifact.content
        : `${artifact.content.slice(0, HISTORY_READ_MAX_CHARS)}\n…(truncated)…`;
    return { path: artifact.path, content, updatedAt: artifact.updatedAt };
  }

  /**
   * Build the compact index of what a project already holds.
   *
   * Deliberately metadata-only. The point of an index is to let the model decide
   * WHICH artifact to open; inlining bodies would reintroduce the unbounded read
   * that the 8 000-character digest cap existed to prevent.
   */
  async index(tenantId: string, project: string): Promise<HistoryIndex> {
    const entries = await this.store.list(tenantId, project);
    const state = await this.readState(tenantId, project);

    const byDirectory = new Map<string, SquadArtifactListEntry[]>();
    const agents: string[] = [];
    for (const entry of entries) {
      const historyMatch = entry.path.match(
        new RegExp(`^${escapeRegExp(SQUAD_STATE_ROOT)}/history/(.+)\\.md$`),
      );
      if (historyMatch) {
        agents.push(historyMatch[1]);
        continue;
      }
      if (entry.path.startsWith(`${SQUAD_STATE_ROOT}/`)) {
        continue; // Squad state is reported through `profile`/`turn`, not as a deliverable.
      }
      const directory = entry.path.split("/").slice(0, -1).join("/");
      const bucket = byDirectory.get(directory) ?? [];
      bucket.push(entry);
      byDirectory.set(directory, bucket);
    }

    const deliverables = [...byDirectory.entries()]
      .map(([directory, items]) => ({
        directory,
        count: items.length,
        latest: items.reduce((a, b) => (a.updatedAt >= b.updatedAt ? a : b)).path,
      }))
      .sort((a, b) => a.directory.localeCompare(b.directory));

    return {
      profile: state?.profile,
      turn: state?.turn,
      deliverables,
      agents: agents.sort(),
      total: entries.length,
    };
  }

  /**
   * Render the index as the delimited DATA block injected at the start of a run.
   *
   * Returned as reference material, never as authority: it is model-produced text
   * that has round-tripped through storage, so it is exactly as untrusted as
   * caller `context` and is merged there rather than into the system prompt.
   */
  async contextBlock(tenantId: string, project: string): Promise<string | undefined> {
    const index = await this.index(tenantId, project);
    if (index.total === 0) {
      return undefined;
    }
    const lines = [
      `Squad profile: ${index.profile ?? "(not yet seeded)"}; turn ${index.turn ?? 0}; ${index.total} stored artifacts.`,
      "",
      "Prior deliverables (open with squad_history read):",
      ...index.deliverables.map(
        (d) => `- ${d.directory}/ — ${d.count} file(s), most recent ${d.latest}`,
      ),
    ];
    if (index.agents.length > 0) {
      lines.push("", `Agents with recorded history: ${index.agents.join(", ")}.`);
    }
    const rendered = lines.join("\n");
    return rendered.length <= HISTORY_INDEX_MAX_CHARS
      ? rendered
      : `${rendered.slice(0, HISTORY_INDEX_MAX_CHARS)}\n…(truncated)…`;
  }

  /** The decision log, or `undefined` before the squad is seeded. */
  async decisions(tenantId: string, project: string): Promise<string | undefined> {
    return (await this.store.get(tenantId, project, DECISIONS_PATH))?.content;
  }

  private async readState(
    tenantId: string,
    project: string,
  ): Promise<SquadStateJson | undefined> {
    const entry = await this.store.get(tenantId, project, STATE_PATH);
    if (!entry) {
      return undefined;
    }
    try {
      return JSON.parse(entry.content) as SquadStateJson;
    } catch {
      return undefined;
    }
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The tracking prefixes a caller may browse, for input validation at the tool layer. */
export const BROWSABLE_PREFIXES = [TRACKING_ROOT, "docs", "outputs"];
