/**
 * Server-side routing engine (advisory stage planning).
 *
 * The dispatch loop shipped a FIXED order (Squad Researcher -> Squad Reviewer).
 * This module replaces that hard-coded pair with a data-driven `route()` that
 * turns a caller request into an ordered advisory stage plan, reading the
 * deployed squad conventions READ-ONLY:
 *
 *   * squad-src/.github/instructions/squad/squad-routing.instructions.md
 *       — the "Default Routing Rules" table (intent keyword -> role, autonomy
 *         tier, parallel-eligibility) used for classification and per-stage
 *         tier/parallel resolution.
 *   * squad-src/.github/instructions/squad/squad-roster.instructions.md
 *       — the "Cast Catalog" table (role KEY -> Primary Agent `name:`) used as
 *         the role -> agentName resolver. This is exactly the injectable map the
 *         Phase 1 persona loader helpers (`loadPersonaForRosterRole` /
 *         `resolvePersonaForRosterRole`) consume.
 *
 * The markdown-table parsing MIRRORS the read-only parser already used by
 * `generators/build-manifests.ts` (fence-skipping table reader + keyword split),
 * so the routing engine and the drift generator read these same files the same
 * way — no new parser is invented.
 *
 * Advisory stage order (VF-08) — the explicit, documented order this router
 * plans and Phase 3 will execute:
 *
 *     research (`researcher`)
 *       -> plan (`lead`)
 *       -> council (`architect`, `security`, `cost-manager`, `product-owner`,
 *                   +`rai` when the request touches the RAI domain)
 *       -> review (`tester`)
 *       -> backlog-handoff
 *
 * The linear pipeline stages returned in {@link RoutePlan.stages} are
 * research -> plan -> review; the council is surfaced separately in
 * {@link RoutePlan.council} (engaged only when the request crosses two or more
 * council domains) so Phase 3 can interleave it between plan and review without
 * this Phase re-planning. A single research-type request routes to the single
 * `researcher` stage only.
 *
 * This module is PARSING + CLASSIFICATION only. It calls no model and wires no
 * orchestrator or council dispatch (that is Phase 3); it only makes the stage
 * list ROUTED and consumable by the dispatch loop.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { resolveSquadGithubRoot } from "../paths.js";
import {
  defaultProfileTables,
  INTAKE_VALIDATOR_ROLE,
  resolveProfile,
  type ProfileTables,
} from "./profiles.js";

// ---------------------------------------------------------------------------
// Markdown table parsing lives in `markdown-table.ts` so the router, the profile
// resolver, and the drift generator all read these instruction files the same
// way — no parser is invented per consumer.
// ---------------------------------------------------------------------------

export { parseTables } from "./markdown-table.js";
import { parseTables } from "./markdown-table.js";

function splitKeywords(cell: string): string[] {
  return cell
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0);
}

function cleanAgentCell(cell: string | undefined): string {
  return (cell ?? "").replace(/`/g, "").trim();
}

// ---------------------------------------------------------------------------
// Parsed read-only inputs.
// ---------------------------------------------------------------------------

/** One row of the Default Routing Rules table. */
export interface RoutingIntentRow {
  /** The intent keywords / phrases that trigger this row (lowercased). */
  patterns: string[];
  /** The role(s) dispatched (as written in the routing table). */
  roles: string[];
  /** The autonomy tier (`auto` | `confirm` | `escalate`). */
  tier: string;
  /** Whether the role may run concurrently with other independent roles. */
  parallelEligible: boolean;
}

/** The parsed routing + roster tables the router plans against. */
export interface RoutingTables {
  /** The Default Routing Rules rows (intent -> role/tier/parallel). */
  intents: RoutingIntentRow[];
  /** The roster Cast Catalog role KEY -> Primary Agent `name:` map. */
  rosterMap: Map<string, string>;
}

/** Parse the "Default Routing Rules" table into intent rows. */
export function parseRoutingIntents(markdown: string): RoutingIntentRow[] {
  const table = parseTables(markdown).find((t) =>
    (t.headers[0] ?? "").toLowerCase().includes("pattern"),
  );
  if (!table) {
    throw new Error(
      "Could not find the routing table (Pattern / Keyword) in squad-routing.instructions.md.",
    );
  }
  const roleIdx = table.headers.findIndex((h) => h.toLowerCase().includes("role"));
  const tierIdx = table.headers.findIndex((h) => h.toLowerCase().includes("tier"));
  const parallelIdx = table.headers.findIndex((h) => h.toLowerCase().includes("parallel"));
  return table.rows
    .filter((row) => row.length > 0 && (row[0] ?? "").length > 0)
    .map((row) => ({
      patterns: splitKeywords(row[0]),
      roles: roleIdx >= 0 ? splitKeywords(row[roleIdx]).map((r) => cleanAgentCell(r)) : [],
      tier: (tierIdx >= 0 ? row[tierIdx] : "").trim().toLowerCase(),
      parallelEligible: parallelIdx >= 0 && (row[parallelIdx] ?? "").trim().toLowerCase() === "yes",
    }));
}

/**
 * Parse the roster "Cast Catalog" table into a role KEY -> Primary Agent `name:`
 * map. Thin-charter roles (Primary is `—`/`-`/empty) are skipped so the map only
 * ever holds installable agents.
 */
export function parseRosterMap(markdown: string): Map<string, string> {
  const table = parseTables(markdown).find((t) =>
    t.headers.some((h) => h.toLowerCase().includes("primary agent")),
  );
  if (!table) {
    throw new Error(
      "Could not find the roster cast catalog (Primary Agent) in squad-roster.instructions.md.",
    );
  }
  const roleIdx = table.headers.findIndex((h) => h.trim().toLowerCase() === "role");
  const primaryIdx = table.headers.findIndex((h) => h.toLowerCase().includes("primary agent"));
  const map = new Map<string, string>();
  for (const row of table.rows) {
    const roleKey = cleanAgentCell(row[roleIdx >= 0 ? roleIdx : 0]).toLowerCase();
    const primary = cleanAgentCell(row[primaryIdx]);
    if (!roleKey || !primary || primary === "—" || primary === "-" || /thin charter/i.test(primary)) {
      continue;
    }
    if (!map.has(roleKey)) {
      map.set(roleKey, primary);
    }
  }
  return map;
}

/** Load + parse the routing and roster instructions from disk (read-only). */
export function loadRoutingTables(githubRoot = resolveSquadGithubRoot()): RoutingTables {
  if (!githubRoot) {
    throw new Error(
      "Could not resolve the squad .github root (squad-routing.instructions.md not found).",
    );
  }
  const routingMd = readFileSync(
    join(githubRoot, "instructions", "squad", "squad-routing.instructions.md"),
    "utf8",
  );
  const rosterMd = readFileSync(
    join(githubRoot, "instructions", "squad", "squad-roster.instructions.md"),
    "utf8",
  );
  return {
    intents: parseRoutingIntents(routingMd),
    rosterMap: parseRosterMap(rosterMd),
  };
}

/**
 * Convenience: the role KEY -> Primary Agent `name:` resolver from the roster
 * Cast Catalog. This is the injectable map consumed by the Phase 1 loader
 * helpers `loadPersonaForRosterRole` / `resolvePersonaForRosterRole`.
 */
export function loadRosterMap(githubRoot = resolveSquadGithubRoot()): Map<string, string> {
  return loadRoutingTables(githubRoot).rosterMap;
}

// ---------------------------------------------------------------------------
// Route planning.
// ---------------------------------------------------------------------------

/** A single planned advisory stage. */
export interface RouteStage {
  /** The squad role KEY for the stage (e.g. `researcher`, `lead`, `tester`). */
  role: string;
  /** The deployed agent `name:` the role resolves to via the roster. */
  agentName: string;
  /** The autonomy tier from the matching routing row. */
  tier: string;
  /** Whether the stage may run concurrently with other independent roles. */
  parallelEligible: boolean;
}

/** The council decision for a route. */
export interface RouteCouncil {
  /** True when the request crosses two or more council domains AND quorum is seated. */
  engaged: boolean;
  /** The council member agent `name:` values (resolved via the roster). */
  members: string[];
  /**
   * Quorum roles the seeded profile does not carry.
   *
   * `squad-council.instructions.md` makes quorum the FULL default membership and
   * forbids dispatching a partial council or synthesizing a verdict to cover a
   * missing role: "a verdict assembled without the full quorum's dispatched
   * findings is invalid and must not gate implementation". A non-empty list is
   * therefore an escalation, not a smaller council.
   */
  missingQuorum: string[];
}

/** The ordered advisory stage plan produced by {@link route}. */
export interface RoutePlan {
  /** The linear pipeline stages in execution order (research -> plan -> review). */
  stages: RouteStage[];
  /** The council decision; Phase 3 interleaves an engaged council between plan and review. */
  council: RouteCouncil;
  /** The profile actually seeded for this run (`default` when none was named). */
  profile: string;
  /** The readiness gate, present only when the seeded roster carries `intake-validator`. */
  intake?: RouteStage;
  /**
   * The deliverable specialists the Implement stage fans out across. Non-empty
   * only for a profile carrying two or more of them (`product`, `full`); every
   * other profile keeps the unchanged single build.
   */
  fanOut: RouteStage[];
}

/** Options mirroring the `/squad` prompt arguments that influence routing. */
export interface RouteOptions {
  /** Optional squad profile hint; decides which roles are seeded and dispatchable. */
  profile?: string;
  /** Optional autonomy mode (`autonomous` | `autopilot`) — forces the full advisory pipeline. */
  mode?: string;
  /** Optional model-tier hint (`fast` | `default`) — accepted; does not change the autonomy tier. */
  tier?: string;
  /** Optional Member Name hint — accepted for forward-compat; does not change the stage plan. */
  owner?: string;
}

/** The advisory role KEYS, in the fixed advisory stage order (VF-08). */
const RESEARCH_ROLE = "researcher";
const PLAN_ROLE = "lead";
const REVIEW_ROLE = "tester";

/** Council member role KEYS (base four + optional `rai`). */
const COUNCIL_BASE_ROLES = ["architect", "security", "cost-manager", "product-owner"] as const;
const RAI_ROLE = "rai";
/**
 * Council DOMAINS and their trigger keywords. The router engages the council
 * when a request crosses two or more of these domains (mirrors the routing
 * council row + Implementation Gate domains: architecture, security, cost,
 * product-fit, RAI).
 */
const COUNCIL_DOMAINS: Record<string, string[]> = {
  architecture: ["architecture", "architectural", "system design", "component", "design tradeoff"],
  security: ["security", "secure", "threat", "vulnerability", "stride"],
  cost: ["cost", "budget", "pricing", "finops", "spend"],
  product: ["product", "requirement", "backlog", "prd", "brd", "user story", "roadmap", "epic"],
  rai: ["responsible ai", "rai", "fairness", "harm", "bias"],
};

/** Keywords that identify the research intent (research-only detection). */
const RESEARCH_KEYWORDS = ["research", "investigate", "explore", "find out"];

/**
 * Whole-word-ish keyword presence: matches at a word start so short keywords
 * like `plan` match `plan`/`planning`/`plans` but not `explanation`.
 */
function keywordPresent(haystack: string, keyword: string): boolean {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}`, "i").test(haystack);
}

/** Find the routing row that owns a canonical keyword (e.g. `research`, `plan`, `review`). */
function findIntentRow(tables: RoutingTables, keyword: string): RoutingIntentRow | undefined {
  return tables.intents.find((row) => row.patterns.includes(keyword));
}

/** Resolve a role KEY to its Primary agent `name:`, falling back to the key when absent. */
function resolveAgent(tables: RoutingTables, roleKey: string): string {
  return tables.rosterMap.get(roleKey) ?? roleKey;
}

/** Build one advisory stage from a role key and the routing row that owns `keyword`. */
function buildStage(
  tables: RoutingTables,
  roleKey: string,
  keyword: string,
  fallbackTier: string,
  fallbackParallel: boolean,
): RouteStage {
  const row = findIntentRow(tables, keyword);
  return {
    role: roleKey,
    agentName: resolveAgent(tables, roleKey),
    tier: row?.tier || fallbackTier,
    parallelEligible: row ? row.parallelEligible : fallbackParallel,
  };
}

/** The council domains a request crosses. */
function crossedCouncilDomains(request: string): string[] {
  const lower = request.toLowerCase();
  const domains: string[] = [];
  for (const [domain, keywords] of Object.entries(COUNCIL_DOMAINS)) {
    if (keywords.some((keyword) => keywordPresent(lower, keyword))) {
      domains.push(domain);
    }
  }
  return domains;
}

/**
 * Compute an advisory {@link RoutePlan} from a request against already-parsed
 * {@link RoutingTables}. This is the pure, injectable classifier (no disk I/O)
 * behind {@link route}.
 *
 * Classification (deterministic, data-driven):
 *   * A request that triggers ONLY the research intent (and no other routing row,
 *     no council domain, no mode/full-profile override) routes to the single
 *     `researcher` stage.
 *   * Any other request is a full advisory request and routes to
 *     research -> plan -> review, with the council engaged when the request
 *     crosses two or more council domains.
 */
export function computeRoutePlan(
  request: string,
  opts: RouteOptions = {},
  tables: RoutingTables,
  profileTables?: ProfileTables,
): RoutePlan {
  const lower = request.toLowerCase();
  const profile = resolveProfile(opts.profile, profileTables ?? defaultProfileTables());

  const researchMatched = RESEARCH_KEYWORDS.some((keyword) => keywordPresent(lower, keyword));
  const councilDomains = crossedCouncilDomains(lower);

  // Any NON-research routing row keyword present -> a broader (advisory) request.
  const nonResearchRowMatched = tables.intents.some(
    (row) =>
      !row.patterns.includes("research") &&
      row.patterns.some((pattern) => keywordPresent(lower, pattern)),
  );

  // A profile whose Implement stage fans out is never a single-stage run: the
  // deliverables it seeds are the point of choosing it.
  const advisoryOverride = Boolean(opts.mode) || profile.fansOut;
  const otherMatched = nonResearchRowMatched || councilDomains.length > 0 || advisoryOverride;

  // A role the profile did not seed cannot be dispatched this run.
  const seeded = (stage: RouteStage): boolean => profile.seeded.has(stage.role);
  const intake = profile.hasIntakeGate
    ? buildStage(tables, INTAKE_VALIDATOR_ROLE, "intake", "confirm", false)
    : undefined;
  const fanOut = profile.fansOut
    ? profile.deliverableRoles.map((role) => buildStage(tables, role, role, "confirm", true))
    : [];

  const researchStage = buildStage(tables, RESEARCH_ROLE, "research", "auto", true);

  // Research-only: a single research intent, nothing broader.
  if (researchMatched && !otherMatched) {
    return {
      stages: [researchStage].filter(seeded),
      council: { engaged: false, members: [], missingQuorum: [] },
      profile: profile.name,
      intake,
      fanOut,
    };
  }

  // Full advisory pipeline: research -> plan -> review (council interleaved by Phase 3).
  const stages: RouteStage[] = [
    researchStage,
    buildStage(tables, PLAN_ROLE, "plan", "confirm", false),
    buildStage(tables, REVIEW_ROLE, "review", "auto", true),
  ].filter(seeded);

  const councilCrossed = councilDomains.length >= 2;
  const missingQuorum = councilCrossed
    ? COUNCIL_BASE_ROLES.filter((role) => !profile.seeded.has(role))
    : [];
  const memberRoles =
    councilCrossed && missingQuorum.length === 0
      ? [
          ...COUNCIL_BASE_ROLES,
          ...(councilDomains.includes(RAI_ROLE) && profile.seeded.has(RAI_ROLE) ? [RAI_ROLE] : []),
        ]
      : [];
  const members = memberRoles.map((roleKey) => resolveAgent(tables, roleKey));

  return {
    stages,
    council: { engaged: members.length > 0, members, missingQuorum: [...missingQuorum] },
    profile: profile.name,
    intake,
    fanOut,
  };
}

let cachedTables: RoutingTables | undefined;

/** The default routing tables, parsed from disk once and cached. */
function defaultTables(): RoutingTables {
  if (!cachedTables) {
    cachedTables = loadRoutingTables();
  }
  return cachedTables;
}

/**
 * Route a request into an ordered advisory {@link RoutePlan}, reading the
 * deployed routing + roster instructions from disk (parsed once, cached).
 *
 * Each returned stage's `agentName` is the roster Primary for the stage role and
 * can be passed directly to the Phase 1 persona loader
 * (`resolvePersonaForRole` / `loadPersonaForRole`) or, via the roster map from
 * {@link loadRosterMap}, to `resolvePersonaForRosterRole`.
 */
export function route(request: string, opts: RouteOptions = {}): RoutePlan {
  return computeRoutePlan(request, opts, defaultTables(), defaultProfileTables());
}
