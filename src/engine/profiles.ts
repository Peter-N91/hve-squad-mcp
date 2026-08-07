/**
 * Squad PROFILES — the roster subset a run actually seeds.
 *
 * `profile` arrived on every tool as an input and went nowhere: the engine acted
 * on `full` alone (one comparison in `routing.ts`), so `profile=product` changed
 * nothing. Under GitHub Copilot the profile is the whole point — it decides which
 * roles land in `team.md`, which rows survive into `routing.md`, whether the
 * intake gate can fire, and whether the Implement stage is one build or a fan-out
 * across deliverable specialists.
 *
 * This module reads those decisions out of the DEPLOYED roster instead of
 * hardcoding them, exactly as `routing.ts` reads the routing table:
 *
 *   * `## Squad Profiles`   -> profile name -> seeded role KEYS
 *   * `### Deliverable Roots` -> role KEY -> the directory that role writes into
 *
 * Nothing here calls a model or touches storage; it is parsing and resolution
 * only, so the whole surface is unit-testable against the bundled cast.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { resolveSquadGithubRoot } from "../paths.js";
import { parseTables } from "./markdown-table.js";

/** The profile seeded when the caller names none, or names one that does not exist. */
export const DEFAULT_PROFILE = "default";

/** The single writer of squad state; the roster includes it in every profile. */
export const SCRIBE_ROLE = "scribe";

/** The readiness gate role; the roster seeds it into `product` and `full` only. */
export const INTAKE_VALIDATOR_ROLE = "intake-validator";

/**
 * Roles whose output is a standalone, user-facing artifact rather than a code or
 * infrastructure change owned by `developer`.
 *
 * Named in the roster's *Squad Profiles* prose rather than in a table, so this is
 * the one list that cannot be parsed. `test/profiles.test.ts` asserts every entry
 * is a real catalog role, which is what would actually break if the roster moved.
 */
export const DELIVERABLE_PRODUCING_ROLES: readonly string[] = [
  "analyst",
  "product-owner",
  "designer",
  "experimenter",
  "presenter",
  "technical-writer",
  "data-scientist",
];

/**
 * A profile carrying at least this many deliverable-producing roles is a set of
 * distinct deliverables rather than a single build, and its Implement stage fans
 * out across the owning specialists (roster: *Deliverable Fan-Out*).
 */
const FAN_OUT_THRESHOLD = 2;

/** Roots that stay at the repository root even inside a federation sub-squad. */
const REPO_ROOTED_PREFIXES = ["docs", "outputs"];

/** The federation sub-squad root every other deliverable root rebases under. */
const SQUAD_MEMBERS_ROOT = ".copilot-tracking/squad/members";

/** The roster tables a profile resolves against. */
export interface ProfileTables {
  /** Profile name -> the role KEYS that profile seeds. */
  profiles: Map<string, string[]>;
  /** Role KEY -> the deliverable root that role writes into. */
  deliverableRoots: Map<string, string>;
}

/** A resolved profile: the roles seeded and what that implies for the run. */
export interface ResolvedProfile {
  /** The profile actually seeded (`default` when the request named none/unknown). */
  name: string;
  /** Whether the caller's requested profile existed in the roster. */
  requestedFound: boolean;
  /** The seeded role KEYS, roster order, `scribe` guaranteed present. */
  roles: string[];
  /** Fast membership test over {@link roles}. */
  seeded: ReadonlySet<string>;
  /** The seeded deliverable-producing roles, roster order. */
  deliverableRoles: string[];
  /** True when the Implement stage fans out across {@link deliverableRoles}. */
  fansOut: boolean;
  /** True when the roster seeds `intake-validator`, so the intake gate can fire. */
  hasIntakeGate: boolean;
}

function normalizeRole(cell: string): string {
  return cell.replace(/`/g, "").trim().toLowerCase();
}

/** Split a cell holding a comma-separated role list into role KEYS. */
function splitRoles(cell: string): string[] {
  return cell
    .split(",")
    .map(normalizeRole)
    .filter((role) => role.length > 0);
}

/**
 * Parse the `## Squad Profiles` table into profile -> seeded role KEYS.
 *
 * Targets the table whose first header is `Profile` and whose second names the
 * members, so the *Profile or Pack* decision table further down the document —
 * which also leads with a profile column — cannot be mistaken for it.
 */
export function parseProfiles(markdown: string): Map<string, string[]> {
  const table = parseTables(markdown).find(
    (t) =>
      (t.headers[0] ?? "").trim().toLowerCase() === "profile" &&
      t.headers.some((h) => h.toLowerCase().includes("members")),
  );
  if (!table) {
    throw new Error(
      "Could not find the Squad Profiles table (Profile / Members) in squad-roster.instructions.md.",
    );
  }
  const membersIdx = table.headers.findIndex((h) => h.toLowerCase().includes("members"));
  const profiles = new Map<string, string[]>();
  for (const row of table.rows) {
    const name = normalizeRole(row[0] ?? "");
    const roles = splitRoles(row[membersIdx] ?? "");
    if (!name || roles.length === 0) {
      continue;
    }
    // The roster states scribe is in every profile; enforce rather than trust.
    if (!roles.includes(SCRIBE_ROLE)) {
      roles.push(SCRIBE_ROLE);
    }
    profiles.set(name, roles);
  }
  if (profiles.size === 0) {
    throw new Error("The Squad Profiles table yielded no profiles.");
  }
  return profiles;
}

/**
 * Parse the `### Deliverable Roots` table into role KEY -> directory.
 *
 * A row may name several roles that share one root. The `scribe` row is prose
 * ("the squad root itself"), not a path, so it is skipped — the Scribe writes
 * state, not a deliverable.
 */
export function parseDeliverableRoots(markdown: string): Map<string, string> {
  const table = parseTables(markdown).find((t) =>
    t.headers.some((h) => h.toLowerCase().includes("deliverable root")),
  );
  if (!table) {
    throw new Error(
      "Could not find the Deliverable Roots table in squad-roster.instructions.md.",
    );
  }
  const rootIdx = table.headers.findIndex((h) => h.toLowerCase().includes("deliverable root"));
  const roots = new Map<string, string>();
  for (const row of table.rows) {
    const cell = (row[rootIdx] ?? "").trim();
    // Take the first backticked path; a row may annotate alternatives in prose.
    const path = cell.match(/`([^`]+)`/)?.[1]?.trim();
    if (!path || !path.includes("/")) {
      continue;
    }
    for (const role of splitRoles(row[0] ?? "")) {
      if (!roots.has(role)) {
        roots.set(role, path.replace(/\/+$/, ""));
      }
    }
  }
  if (roots.size === 0) {
    throw new Error("The Deliverable Roots table yielded no roots.");
  }
  return roots;
}

/** Load + parse the profile and deliverable-root tables from disk (read-only). */
export function loadProfileTables(githubRoot = resolveSquadGithubRoot()): ProfileTables {
  if (!githubRoot) {
    throw new Error(
      "Could not resolve the squad .github root (squad-roster.instructions.md not found).",
    );
  }
  const rosterMd = readFileSync(
    join(githubRoot, "instructions", "squad", "squad-roster.instructions.md"),
    "utf8",
  );
  return {
    profiles: parseProfiles(rosterMd),
    deliverableRoots: parseDeliverableRoots(rosterMd),
  };
}

/**
 * Resolve a caller-supplied profile name against the roster.
 *
 * An unknown name falls back to `default` rather than throwing: `profile` is a
 * caller hint on every tool, and a typo must not fail an otherwise valid run.
 * `requestedFound` records which happened so the caller can say so.
 */
export function resolveProfile(
  requested: string | undefined,
  tables: ProfileTables,
): ResolvedProfile {
  const wanted = (requested ?? "").trim().toLowerCase();
  const found = wanted.length > 0 && tables.profiles.has(wanted);
  const name = found ? wanted : DEFAULT_PROFILE;
  const roles = tables.profiles.get(name) ?? tables.profiles.get(DEFAULT_PROFILE) ?? [SCRIBE_ROLE];
  const seeded = new Set(roles);
  const deliverableRoles = DELIVERABLE_PRODUCING_ROLES.filter((role) => seeded.has(role));
  return {
    name,
    requestedFound: found,
    roles,
    seeded,
    deliverableRoles,
    fansOut: deliverableRoles.length >= FAN_OUT_THRESHOLD,
    hasIntakeGate: seeded.has(INTAKE_VALIDATOR_ROLE),
  };
}

/** Placeholders a deliverable root may carry, filled per run. */
export interface DeliverableRootOptions {
  /** Federation sub-squad name; rebases the root under `squad/members/<name>/`. */
  squad?: string;
  /** ISO date for a `<date>` segment (defaults to today, UTC). */
  date?: string;
  /** Slug for a `<deck-slug>` segment. */
  slug?: string;
}

/**
 * Resolve the directory a role writes its deliverable into.
 *
 * Returns `undefined` for a role the roster deliberately omits — `cost-manager`,
 * `intake-validator` and friends hand a structured result back to the coordinator
 * instead of writing a standalone artifact, so having no root is correct for them
 * rather than a gap.
 */
export function deliverableRootFor(
  role: string,
  tables: ProfileTables,
  opts: DeliverableRootOptions = {},
): string | undefined {
  const template = tables.deliverableRoots.get(normalizeRole(role));
  if (!template) {
    return undefined;
  }
  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  const path = template
    .replace(/<date>/g, date)
    .replace(/<deck-slug>/g, opts.slug ?? "deck");
  if (!opts.squad) {
    return path;
  }
  // Published documentation and data-science outputs stay repository-wide.
  if (REPO_ROOTED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
    return path;
  }
  const rebased = path.replace(/^\.copilot-tracking\//, "");
  return `${SQUAD_MEMBERS_ROOT}/${opts.squad}/${rebased}`;
}

let cachedTables: ProfileTables | undefined;

/** The default profile tables, parsed from disk once and cached. */
export function defaultProfileTables(): ProfileTables {
  if (!cachedTables) {
    cachedTables = loadProfileTables();
  }
  return cachedTables;
}
