/**
 * The Squad Scribe, server-side.
 *
 * Under GitHub Copilot the Scribe is the single writer of squad state: it stamps
 * the seeded roster into `team.md`, filters `routing.md` to that roster, keeps
 * `state.json` current, and appends to the three append-only logs. The MCP server
 * ran the same dispatches and wrote none of it, so a run left behind a rolling
 * digest and nothing an operator could audit.
 *
 * This module writes that ledger through the {@link SquadArtifactStore} seam, so
 * it lands in whichever backend the operator configured. It follows
 * `squad-state.instructions.md` on the two points that actually matter:
 *
 *   * `team.md`, `routing.md`, `state.json`, and the consumption files are
 *     REPLACED by the Scribe.
 *   * `decisions.md`, `notifications.md`, and `history/<agent>.md` are
 *     APPEND-ONLY — "new entries are added to the end; prior entries are never
 *     edited or removed" — so every write goes through the store's CAS append
 *     rather than a read-modify-write that could drop a concurrent role's entry.
 *
 * Seeding is idempotent and an existing `team.md` WINS over the `profile`
 * argument. A project's roster is a decision the project already made; a later
 * caller passing a different `profile` must not silently re-cast the squad.
 */
import {
  SQUAD_STATE_ROOT,
  type SquadArtifact,
  type SquadArtifactStore,
} from "./artifact-store.js";
import { deliverableRootFor, type ProfileTables, type ResolvedProfile } from "./profiles.js";

/** The `state.json` schema this server writes (matches squad-state.instructions.md). */
export const STATE_SCHEMA_VERSION = "1.3";

export const TEAM_PATH = `${SQUAD_STATE_ROOT}/team.md`;
export const ROUTING_PATH = `${SQUAD_STATE_ROOT}/routing.md`;
export const STATE_PATH = `${SQUAD_STATE_ROOT}/state.json`;
export const DECISIONS_PATH = `${SQUAD_STATE_ROOT}/decisions.md`;
export const NOTIFICATIONS_PATH = `${SQUAD_STATE_ROOT}/notifications.md`;
export const CONSUMPTION_PATH = `${SQUAD_STATE_ROOT}/consumption.md`;

/** Per-agent dispatch history; one append-only file per agent. */
export function agentHistoryPath(agentName: string): string {
  return `${SQUAD_STATE_ROOT}/history/${slugForPath(agentName)}.md`;
}

/** Per-run pipeline summary. */
export function runHistoryPath(runId: string): string {
  return `${SQUAD_STATE_ROOT}/history/autopilot-run-${slugForPath(runId)}.md`;
}

/** Reduce a display name to a safe single path segment. */
export function slugForPath(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return slug.length > 0 ? slug : "unnamed";
}

/** The machine-readable squad status persisted at {@link STATE_PATH}. */
export interface SquadStateJson {
  schemaVersion: string;
  profile: string;
  updated: string;
  turn: number;
  mode: string;
  activeRoles: string[];
  openEscalations: string[];
  currentRun: {
    id?: string;
    sessionModel: string;
    modelOverrides: Record<string, string>;
    estCostUsd: number;
    estCreditsTotal: number;
  };
  notify: {
    approvalChannel: string;
    enabled: boolean;
    email: string;
    github: { handle: string; repo: string };
  };
}

export interface SeedSquadOptions {
  /** Autonomy mode recorded in `state.json`. */
  mode?: string;
  /** Model tier preference stamped into every `team.md` row. */
  tier?: string;
  /** Federation sub-squad name; rebases deliverable roots. */
  squad?: string;
  /** ISO date used for `<date>` segments and the `updated` stamp. */
  date?: string;
}

export interface SeededSquad {
  /** True when this call created the roster; false when one already existed. */
  created: boolean;
  /** The profile the squad is actually cast under (existing roster wins). */
  profile: string;
  team: SquadArtifact;
}

/**
 * Render `team.md` from the seeded roster.
 *
 * `Member Name` is left empty on every row. Naming is a question the coordinator
 * puts to a user during Init Mode, and this server has no user in the loop — the
 * roster's own unattended rule is to fall back to the empty-name behaviour rather
 * than invent aliases ("Unattended runs never ask ... It never invents names").
 */
export function renderTeamMarkdown(
  profile: ResolvedProfile,
  tables: ProfileTables,
  opts: SeedSquadOptions = {},
): string {
  const tier = opts.tier?.trim() || "default";
  const header = [
    "| Role | Member Name | Agent Name (Primary) | Alternate Agents | Invocation | Model Tier | Deliverable Root |",
    "|------|-------------|----------------------|------------------|------------|------------|------------------|",
  ];
  const rows = profile.roles.map((role) => {
    const cast = tables.cast.get(role);
    const root =
      role === "scribe"
        ? "(squad state)"
        : (deliverableRootFor(role, tables, { squad: opts.squad, date: opts.date }) ??
          "(returns findings to the coordinator)");
    return `| ${role} |  | ${cast?.primary ?? "(unresolved)"} | ${
      cast?.alternates.join(", ") ?? ""
    } | runSubagent / task | ${tier} | ${root} |`;
  });
  return [
    "# Members",
    "",
    `Seeded from the \`${profile.name}\` profile.`,
    "",
    ...header,
    ...rows,
    "",
  ].join("\n");
}

/** Render `routing.md` filtered to the seeded roster. */
export function renderRoutingMarkdown(profile: ResolvedProfile): string {
  return [
    "# Routing",
    "",
    `Filtered to the \`${profile.name}\` profile's roster. A request that routes to a`,
    "role this squad does not carry escalates to the user rather than being",
    "reassigned to a role that cannot do the work.",
    "",
    "| Role | Seeded |",
    "|------|--------|",
    ...profile.roles.map((role) => `| ${role} | yes |`),
    "",
  ].join("\n");
}

/** Build the initial `state.json` for a freshly seeded squad. */
export function initialState(
  profile: ResolvedProfile,
  opts: SeedSquadOptions = {},
): SquadStateJson {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    profile: profile.name,
    updated: opts.date ?? new Date().toISOString().slice(0, 10),
    turn: 0,
    mode: opts.mode?.trim() || "interactive",
    activeRoles: [],
    openEscalations: [],
    currentRun: { sessionModel: "", modelOverrides: {}, estCostUsd: 0, estCreditsTotal: 0 },
    notify: {
      approvalChannel: "in-chat",
      enabled: false,
      email: "",
      github: { handle: "", repo: "" },
    },
  };
}

/** The Scribe, bound to one artifact store. */
export class SquadLedger {
  constructor(private readonly store: SquadArtifactStore) {}

  /**
   * Seed `team.md`, `routing.md`, and `state.json` for a project, once.
   *
   * An existing `team.md` short-circuits the whole call: re-casting a squad
   * because a later request passed a different `profile` would silently discard
   * the roster the project is already running under.
   */
  async seed(
    tenantId: string,
    project: string,
    profile: ResolvedProfile,
    tables: ProfileTables,
    opts: SeedSquadOptions = {},
  ): Promise<SeededSquad> {
    const existing = await this.store.get(tenantId, project, TEAM_PATH);
    if (existing) {
      return { created: false, profile: profileNameFrom(existing.content, profile.name), team: existing };
    }
    const team = await this.replace(
      tenantId,
      project,
      TEAM_PATH,
      renderTeamMarkdown(profile, tables, opts),
    );
    await this.replace(tenantId, project, ROUTING_PATH, renderRoutingMarkdown(profile));
    await this.replace(
      tenantId,
      project,
      STATE_PATH,
      `${JSON.stringify(initialState(profile, opts), null, 2)}\n`,
    );
    // Pre-create the shared append-only logs. The store seam has no
    // create-if-absent, so the FIRST write to a path cannot be arbitrated by
    // compare-and-swap; creating them here means every later append across every
    // replica holds a real CAS token.
    await this.replace(tenantId, project, DECISIONS_PATH, "# Decisions\n");
    await this.replace(tenantId, project, NOTIFICATIONS_PATH, "# Notifications\n");
    return { created: true, profile: profile.name, team };
  }

  /** Read the current `state.json`, or `undefined` before the squad is seeded. */
  async readState(tenantId: string, project: string): Promise<SquadStateJson | undefined> {
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

  /** Overwrite `state.json` with the supplied patch applied. */
  async updateState(
    tenantId: string,
    project: string,
    patch: Partial<SquadStateJson>,
  ): Promise<void> {
    const current = await this.readState(tenantId, project);
    if (!current) {
      return;
    }
    const next: SquadStateJson = {
      ...current,
      ...patch,
      currentRun: { ...current.currentRun, ...(patch.currentRun ?? {}) },
      updated: patch.updated ?? new Date().toISOString().slice(0, 10),
    };
    await this.replace(tenantId, project, STATE_PATH, `${JSON.stringify(next, null, 2)}\n`);
  }

  /** Append a block to the chronological decision log. */
  async appendDecision(tenantId: string, project: string, block: string): Promise<void> {
    await this.store.append(tenantId, project, DECISIONS_PATH, block.trim());
  }

  /** Append a block to the notification log. */
  async appendNotification(tenantId: string, project: string, block: string): Promise<void> {
    await this.store.append(tenantId, project, NOTIFICATIONS_PATH, block.trim());
  }

  /** Append a dispatch record to an agent's own history file. */
  async appendAgentHistory(
    tenantId: string,
    project: string,
    agentName: string,
    block: string,
  ): Promise<void> {
    await this.store.append(tenantId, project, agentHistoryPath(agentName), block.trim());
  }

  /** Append a stage record to the per-run pipeline summary. */
  async appendRunHistory(
    tenantId: string,
    project: string,
    runId: string,
    block: string,
  ): Promise<void> {
    await this.store.append(tenantId, project, runHistoryPath(runId), block.trim());
  }

  /** Write a role's deliverable into that role's own root, returning the path. */
  async writeDeliverable(
    tenantId: string,
    project: string,
    role: string,
    fileName: string,
    content: string,
    tables: ProfileTables,
    opts: SeedSquadOptions = {},
  ): Promise<string | undefined> {
    const root = deliverableRootFor(role, tables, { squad: opts.squad, date: opts.date });
    if (!root) {
      return undefined; // The roster gives this role no standalone artifact.
    }
    const path = `${root}/${slugForPath(fileName)}.md`;
    await this.replace(tenantId, project, path, content);
    return path;
  }

  /** Replace an artifact, retrying once against the current revision. */
  private async replace(
    tenantId: string,
    project: string,
    path: string,
    content: string,
  ): Promise<SquadArtifact> {
    const first = await this.store.put(tenantId, project, path, content);
    if (first.ok) {
      return first.artifact;
    }
    const retry = await this.store.put(tenantId, project, path, content, first.current?.etag);
    if (!retry.ok) {
      throw new Error(`Could not replace ${path}: lost the compare-and-swap twice.`);
    }
    return retry.artifact;
  }
}

/** Recover the profile a seeded `team.md` was cast under. */
function profileNameFrom(teamMarkdown: string, fallback: string): string {
  return teamMarkdown.match(/Seeded from the `([a-z0-9-]+)` profile/)?.[1] ?? fallback;
}
