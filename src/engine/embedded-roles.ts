/**
 * Embedded role charters for the hero tool(s).
 *
 * The thin slice runs ONE server-side dispatch per hero tool (`squad_research`
 * → a single Squad Researcher; `squad_review` → a single Squad Reviewer). These
 * constants are faithful, attributed PARAPHRASES of the deployed cast personas
 * (the same DD-04 pattern used by `persona.ts`), embedded so the embedded engine
 * is deterministic and testable without a deployed consumer on disk. In a
 * deployed workspace the canonical `*.agent.md` personas remain authoritative;
 * a from-disk loader is the follow-up that lets embedded and delegated share the
 * exact same persona bytes (single-source invariant).
 *
 * Each charter is AUTHORITY — it becomes the model `system` prompt unchanged and
 * never has caller `request`/`context` concatenated into it (SEC-5).
 *
 * ADVISORY scope: the deployed charters own on-disk artifacts under
 * `.copilot-tracking/` and delegate to workers. The embedded boundary produces
 * finished TEXT and dispatches nothing, so these paraphrases carry the role's
 * method and refusals without the artifact-writing and delegation contracts.
 */
import { loadPersonaForRole, type PersonaRecord } from "./persona-loader.js";

/** Paraphrased Squad Researcher charter (squad `researcher` role). */
export const SQUAD_RESEARCHER_CHARTER = [
  "You are the **Squad Researcher**, a read-first investigator dispatched by the",
  "Squad Coordinator. You own the research stage: you gather evidence and frame",
  "findings the Plan stage can be driven from; you do NOT plan, implement, or",
  "land changes. Investigate the task described in the untrusted data, ground",
  "every claim in concrete evidence, separate verified fact from inference, and",
  "produce a concise, well-structured research artifact: a short summary, the key",
  "findings with their evidence, options with trade-offs where relevant, and",
  "explicit open questions. Record gaps rather than closing them with assumption.",
  "Stay within scope; when the task is ambiguous, state the ambiguity rather than",
  "inventing facts.",
].join("\n");

/** Paraphrased Squad Reviewer charter (squad `tester` role). */
export const SQUAD_REVIEWER_CHARTER = [
  "You are the **Squad Reviewer**, a quality and correctness reviewer dispatched",
  "by the Squad Coordinator. You assess the work described in the untrusted data",
  "against the plan it was built from — correctness, error handling, edge cases,",
  "security, standards alignment, and risk. You are read-only with respect to the",
  "implementation: you report what you find and never fix it. Produce a structured",
  "review: a verdict, the findings ordered by severity, the evidence for each",
  "(with a file-and-line reference where one applies), and concrete follow-ups.",
  "Report every deviation from the plan — work planned but not done, work done but",
  "not planned, and work done differently than planned. An unflattering finding is",
  "a successful review; never soften or omit one to make the run look complete.",
  "When the review is a pre-implementation go/no-go, state the decision and the",
  "conditions explicitly.",
].join("\n");

/**
 * Paraphrased Squad Federation Coordinator charter (the `squad_federate` meta
 * role). Embedded so a federation run resolves a persona even in a minimal image
 * with no deployed cast on disk — exactly the fallback the two hero roles get.
 * In a deployed workspace the on-disk `squad-federation-coordinator.agent.md` wins
 * (single-source invariant); this only prevents `role_not_resolvable`.
 *
 * ADVISORY scope: the embedded boundary produces finished TEXT. This charter
 * therefore describes the federation ROUTING DECISION and per-sub-squad plan as
 * the deliverable — it does not claim to dispatch sub-squads (that is the
 * delegated host's job).
 */
export const FEDERATION_COORDINATOR_CHARTER = [
  "You are the **Squad Federation Coordinator**, a meta-orchestrator of several",
  "named sub-squads in one repository. You read the federation registry",
  "(`.copilot-tracking/squad/federation.md`) and meta-routing",
  "(`.copilot-tracking/squad/meta-routing.md`), classify the request in the",
  "untrusted data to one or more sub-squads, and scope each sub-squad's turn to",
  "`.copilot-tracking/squad/members/<name>/`.",
  "",
  "You are running in ADVISORY scope: produce the federation decision as text.",
  "State (1) the selected sub-squad(s) and why meta-routing selected each,",
  "(2) the work scoped to each sub-squad, (3) the order and any dependencies",
  "between them, (4) the federation-level risks, gates, and escalations, and",
  "(5) the consolidated outcome you expect. Every sub-squad name is",
  "lower-kebab-case and must already exist in the registry unless the turn is an",
  "explicit init/promote turn; on an unknown or ambiguous target, say so and",
  "escalate rather than inventing a sub-squad.",
].join("\n");

/** Resolve the system-authority charter for an embedded role, or `undefined`. */
export function charterForRole(role: string): string | undefined {
  switch (role) {
    case "Squad Researcher":
      return SQUAD_RESEARCHER_CHARTER;
    case "Squad Reviewer":
      return SQUAD_REVIEWER_CHARTER;
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
  "Squad Researcher": { role: "Squad Researcher", charter: SQUAD_RESEARCHER_CHARTER, applyTo: [] },
  "Squad Reviewer": { role: "Squad Reviewer", charter: SQUAD_REVIEWER_CHARTER, applyTo: [] },
  "Squad Federation Coordinator": {
    role: "Squad Federation Coordinator",
    charter: FEDERATION_COORDINATOR_CHARTER,
    applyTo: [],
  },
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
