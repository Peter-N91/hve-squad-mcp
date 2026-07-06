/**
 * Embedded role charters for the hero tool(s).
 *
 * The thin slice runs ONE server-side dispatch per hero tool (`squad_research`
 * → a single Task Researcher; `squad_review` → a single Task Reviewer). These
 * constants are faithful, attributed PARAPHRASES of the deployed cast personas
 * (the same DD-04 pattern used by `persona.ts`), embedded so the embedded engine
 * is deterministic and testable without a deployed consumer on disk. In a
 * deployed workspace the canonical `*.agent.md` personas remain authoritative;
 * a from-disk loader is the follow-up that lets embedded and delegated share the
 * exact same persona bytes (single-source invariant).
 *
 * Each charter is AUTHORITY — it becomes the model `system` prompt unchanged and
 * never has caller `request`/`context` concatenated into it (SEC-5).
 */
import { loadPersonaForRole, type PersonaRecord } from "./persona-loader.js";

/** Paraphrased Task Researcher charter (squad `researcher` role). */
export const TASK_RESEARCHER_CHARTER = [
  "You are the **Task Researcher**, a read-first investigator dispatched by the",
  "Squad Coordinator. You gather evidence and frame findings; you do NOT plan,",
  "implement, or land changes. Investigate the task described in the untrusted",
  "data, ground every claim in concrete evidence, name assumptions and unknowns,",
  "and produce a concise, well-structured research artifact: a short summary,",
  "the key findings with their evidence, options with trade-offs where relevant,",
  "and explicit open questions. Stay within scope; when the task is ambiguous,",
  "state the ambiguity rather than inventing facts.",
].join("\n");

/** Paraphrased Task Reviewer charter (squad `tester` role). */
export const TASK_REVIEWER_CHARTER = [
  "You are the **Task Reviewer**, a quality and correctness reviewer dispatched",
  "by the Squad Coordinator. You assess the work described in the untrusted data",
  "for correctness, quality, standards alignment, and risk; you do NOT modify it.",
  "Produce a structured review: a verdict, the findings ordered by severity, the",
  "evidence for each, and concrete follow-ups. When the review is a",
  "pre-implementation go/no-go, state the decision and the conditions explicitly.",
].join("\n");

/** Resolve the system-authority charter for an embedded role, or `undefined`. */
export function charterForRole(role: string): string | undefined {
  switch (role) {
    case "Task Researcher":
      return TASK_RESEARCHER_CHARTER;
    case "Task Reviewer":
      return TASK_REVIEWER_CHARTER;
    default:
      return undefined;
  }
}

/**
 * Paraphrased fallback records, used when the deployed cast is not on disk (CI /
 * minimal image). These carry an empty `applyTo` because the paraphrase is not a
 * real `*.agent.md` file.
 */
const PARAPHRASE_RECORDS: Record<string, PersonaRecord> = {
  "Task Researcher": { role: "Task Researcher", charter: TASK_RESEARCHER_CHARTER, applyTo: [] },
  "Task Reviewer": { role: "Task Reviewer", charter: TASK_REVIEWER_CHARTER, applyTo: [] },
};

/**
 * Resolve a role's persona for the embedded pipeline, preferring the REAL on-disk
 * `*.agent.md` bytes (single-source invariant) and falling back to the paraphrased
 * record when the deployed cast is absent. This is the from-disk entry point the
 * dispatch loop consumes; `charterForRole` is intentionally left unchanged so the
 * single hero-dispatch path stays deterministic for the SEC-5 conformance suites.
 */
export function resolvePersonaForRole(
  role: string,
  roots?: string[],
): PersonaRecord | undefined {
  const loaded = roots ? loadPersonaForRole(role, roots) : loadPersonaForRole(role);
  return loaded ?? PARAPHRASE_RECORDS[role];
}

/**
 * Resolve a persona for a squad ROLE KEY (e.g. `"architect"`) by mapping the
 * role key to the deployed agent `name:` via the injected `rosterMap`, then
 * resolving that agent name through {@link resolvePersonaForRole} (real on-disk
 * bytes first, hero paraphrase fallback only when the mapped agent is one of the
 * two deterministic hero roles and the cast is absent).
 *
 * Roster PARSING is intentionally NOT done here (that is the routing engine's
 * job); this helper only consumes an already-parsed role -> agent-name map, so
 * the loader layer stays roster-map-injectable. Returns `undefined` when the
 * role key is absent from the map or the mapped persona cannot be resolved.
 */
export function resolvePersonaForRosterRole(
  roleKey: string,
  rosterMap: ReadonlyMap<string, string>,
  roots?: string[],
): PersonaRecord | undefined {
  const agentName = rosterMap.get(roleKey);
  if (!agentName) {
    return undefined;
  }
  return resolvePersonaForRole(agentName, roots);
}
