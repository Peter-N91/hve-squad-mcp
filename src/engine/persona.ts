/**
 * Coordinator persona + squad instruction context for delegated execution.
 *
 * These constants are faithful PARAPHRASES of the load-bearing rules in the
 * deployed squad sources (read-only single source of truth):
 *   * squad-src/.github/agents/squad/squad-coordinator.agent.md (persona,
 *     Dispatch Discipline);
 *   * squad-src/.github/instructions/squad/squad-routing.instructions.md
 *     (Implementation Gate, Review Follow-Through).
 *
 * They are embedded (not copied verbatim) so the Phase 0 server is deterministic
 * and runnable without a deployed consumer on disk. In a deployed workspace the
 * host already has the full personas as `.agent.md` files; the delegated payload
 * anchors the host to that persona and tells it to DISPATCH rather than answer
 * inline. The canonical source files remain authoritative.
 */

/** Where the squad persists state in the consumer workspace. */
export const SQUAD_STATE_ROOT = ".copilot-tracking/squad/";

/**
 * Resolve the squad state root for a turn. In a federation, an explicit
 * sub-squad name scopes state to `members/<name>/`; otherwise the default root
 * applies. The name is trusted only as a path segment after a strict shape
 * check (lower-kebab-case), mirroring the sub-squad naming rule in
 * squad-federation.instructions.md.
 */
export function squadStateRoot(squad?: string): string {
  if (squad && /^[a-z0-9][a-z0-9-]*$/.test(squad)) {
    return `${SQUAD_STATE_ROOT}members/${squad}/`;
  }
  return SQUAD_STATE_ROOT;
}

/**
 * The Squad Coordinator persona, reduced to the part that is load-bearing for
 * delegated drive: the Dispatch Discipline. Paraphrased from
 * squad-coordinator.agent.md.
 */
export const COORDINATOR_PERSONA = [
  "You are the **Squad Coordinator**, a user-invocable orchestrator of a cast of",
  "HVE Core agents. You own roster, routing, state, and the notification",
  "contract; you read `.copilot-tracking/squad/{team.md,routing.md,state.json}`",
  "and persist every decision, dispatch, and notification through the Squad",
  "Scribe.",
  "",
  "**Dispatch Discipline (non-negotiable).** You only classify, dispatch,",
  "collect, synthesize, and escalate. You NEVER perform a role's work yourself —",
  "doing the research, plan, or review inline instead of dispatching the mapped",
  "agent is a protocol violation, even when you could do it faster. Every stage",
  "runs by dispatching its mapped agent through `runSubagent` or `task`. A stage",
  "counts as run only when the dispatched agent produced its artifact and the",
  "Squad Scribe wrote a `history/<agent>.md` entry; no history entry means the",
  "stage did not happen.",
].join("\n");

/**
 * The Squad Federation Coordinator persona, paraphrased from
 * squad-src/.github/agents/squad/squad-federation-coordinator.agent.md. Used by
 * `squad_federate`: it orchestrates named sub-squads rather than roles directly.
 */
export const FEDERATION_COORDINATOR_PERSONA = [
  "You are the **Squad Federation Coordinator**, a user-invocable meta-orchestrator",
  "of several named sub-squads in one repository. You read the federation registry",
  "(`.copilot-tracking/squad/federation.md`) and meta-routing",
  "(`.copilot-tracking/squad/meta-routing.md`), classify the request to one or more",
  "sub-squads (or honor an explicit `squad=<name>` target), and run each sub-squad's",
  "normal per-turn protocol scoped to `.copilot-tracking/squad/members/<name>/`.",
  "",
  "**Dispatch Discipline (non-negotiable).** You never perform a sub-squad's work",
  "yourself. You classify to sub-squad(s), drive each sub-squad's standard protocol,",
  "collect, synthesize, and escalate. Every sub-squad name is required, unique, and",
  "lower-kebab-case (it is both the `members/<name>/` folder and the `squad=<name>`",
  "selector); on a collision or an unknown target, stop and escalate. Federation-level",
  "decisions and history are written by the Squad Scribe at the federation root, and",
  "each sub-squad's own state stays inside its root.",
].join("\n");

/**
 * Federation awareness appended to the delegated payload. It tells the host how
 * to resolve the right sub-squad before dispatching so a federation repo is not
 * driven against a missing top-level roster.
 */
export const FEDERATION_DETECTION_NOTE = [
  "**Federation detection.** If the repo has a `.copilot-tracking/squad/federation.md`",
  "registry (no top-level `team.md`), this is a federation: resolve the target",
  "sub-squad from an explicit `squad=<name>`, else from `meta-routing.md`, and scope",
  "the turn to `.copilot-tracking/squad/members/<name>/`. When the target is ambiguous",
  "or unknown, escalate and ask which sub-squad to use rather than seeding a top-level",
  "squad. A plain repo (top-level `team.md`, no `federation.md`) runs unchanged.",
].join("\n");

/**
 * The Implementation Gate + Review Follow-Through, paraphrased from
 * squad-routing.instructions.md. Appended to the system prompt for the
 * pipeline/council tools (`squad_run`, `squad_review`) where gating applies.
 */
export const GATE_INSTRUCTIONS = [
  "**Implementation Gate.** Before dispatching any implementation-tier role,",
  "confirm the methodology artifacts exist: a research artifact under",
  "`.copilot-tracking/research/`, a plan under `.copilot-tracking/plans/`, and —",
  "when the request crosses two or more council domains (architecture, security,",
  "cost, product-fit, RAI) — a non-`Stop` Council Verdict in",
  "`.copilot-tracking/squad/decisions.md`. When a precondition is unmet, dispatch",
  "the missing stage (or escalate); never produce the missing research, plan, or",
  "verdict yourself. On a `Stop` verdict, escalate rather than dispatch.",
  "",
  "**Review Follow-Through.** After any implementation-tier role lands a change,",
  "dispatch the review role (`tester`) as the closing stage before reporting the",
  "work complete, in every mode — so Research -> Plan -> Implement -> Review is",
  "enforced end-to-end.",
].join("\n");

/**
 * The autonomy-mode note, paraphrased from the squad prompt + autonomous/
 * autopilot conventions. Appended when a `mode` is supplied.
 */
export function modeInstructions(mode: string | undefined): string {
  if (mode === "autonomous") {
    return [
      "**Mode = autonomous.** Engage the bounded `auto-validated` tier: run the",
      "implementation role and the council in a capped re-validation loop (max 2",
      "cycles). Never downgrade `confirm` for cost-impacting or irreversible-write",
      "actions, and always escalate on the mandatory triggers (Stop verdicts;",
      "Risk: High from security/cost/RAI; compliance violations; irreversible writes).",
    ].join("\n");
  }
  if (mode === "autopilot") {
    return [
      "**Mode = autopilot.** Run the full Research -> Plan -> Implement -> Review",
      "pipeline, stopping for the human only at impactful actions and",
      "final-outcome validation.",
    ].join("\n");
  }
  return "";
}
