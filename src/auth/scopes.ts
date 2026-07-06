/**
 * Per-tool authorization scopes (SEC-2).
 *
 * Each coarse `squad_*` tool requires an explicit OAuth scope; absent the scope
 * the call is denied (default-deny). The scope model is defined now — for ALL
 * five tools — even though the thin slice only exposes the hero tools, so that
 * `squad_run` is already gated the moment its embedded wiring lands in Phase 1b
 * without revisiting the authorization model.
 *
 * Scopes are expressed as the short scope name a Copilot Studio / Entra app
 * registration grants (the resource server's exposed API scopes). The audience
 * binding (RFC 8707) is enforced separately in `entra.ts`; this map only answers
 * "which scope does THIS tool require".
 */

/** The OAuth scope a given tool requires to be invoked. */
export const TOOL_SCOPES: Readonly<Record<string, string>> = {
  squad_research: "Squad.Research",
  squad_review: "Squad.Review",
  squad_plan: "Squad.Plan",
  squad_architect: "Squad.Architect",
  // squad_run carries the gated pipeline; its scope exists now so the gate is
  // enforced as soon as the tool is wired (Phase 1b), never retrofitted.
  squad_run: "Squad.Run",
  // squad_status polls a run the caller started; it reuses the Squad.Run scope
  // (you may inspect runs you are authorized to start).
  squad_status: "Squad.Run",
  // squad_render_pptx is a deterministic file-output utility (content YAML -> a
  // .pptx download link). It carries its own least-privilege scope so a render
  // grant does not imply research/plan/run. Fail-closed like every other tool.
  squad_render_pptx: "Squad.Render",
};

/**
 * The distinct, high-privilege OPERATOR scope required to release a held run
 * through the out-of-band approval endpoint (`POST /admin/approve`). It is
 * deliberately NOT a member of {@link TOOL_SCOPES} — releasing a Human Gate is an
 * operator action, not a squad tool a caller invokes — and it is separate from
 * `Squad.Run` so a caller that may START or POLL a run (Squad.Run) still cannot
 * APPROVE one. Grant it as an Entra app role (application permission) to the
 * human/service principal that operates the deployment; the authenticator merges
 * `roles[]` into the resolved scopes, so the same check covers a delegated scope
 * or an app role. Never derivable from caller `request`/`context` or model output
 * (SEC-6): the only code path that checks it is the admin route.
 */
export const OPERATOR_APPROVAL_SCOPE = "Squad.Operate";

/**
 * The two ORIGINAL hero tools from the thin slice. Kept as a named constant for
 * legacy references; the authoritative remote-exposure set is
 * {@link REMOTE_EXPOSED_TOOLS} / {@link isRemotelyExposed}, which (since Phase 5)
 * also projects `squad_plan` and `squad_architect` into the Copilot Studio
 * connector as advisory tools.
 */
export const THIN_SLICE_HERO_TOOLS: readonly string[] = ["squad_research", "squad_review"];

/**
 * The ADVISORY tools exposed over the remote (HTTP) boundary in BOTH postures
 * (Phase 5). The original hero tools (`squad_research`, `squad_review`) plus the
 * advisory hero-style tools (`squad_plan`, `squad_architect`) that were formerly
 * delegated-only. Each runs a SINGLE-STAGE embedded advisory dispatch and lands
 * NO impactful action, so — like the hero tools — it is exposed even when the
 * gated async pipeline is disabled, and follows the same audience/scope/origin/
 * tenant rules. The gated async pipeline (`squad_run`/`squad_status`) is NOT here;
 * it is gated separately behind {@link REMOTE_EXPOSED_TOOLS} + `pipelineExposed`.
 */
export const ADVISORY_EXPOSED_TOOLS: readonly string[] = [
  "squad_research",
  "squad_review",
  "squad_plan",
  "squad_architect",
];

/**
 * The tools reachable over the remote (HTTP) boundary when the operator has
 * enabled the gated pipeline (Phase 5): the advisory surface
 * ({@link ADVISORY_EXPOSED_TOOLS}) plus the gated async pipeline `squad_run` and
 * the `squad_status` poll utility. `squad_run` is exposed but SAFE BY
 * CONSTRUCTION — it holds at the Human Gate and never auto-releases, so exposure
 * does not bypass a gate. The advisory tools carry no impactful action; `squad_run`
 * carries the full advisory pipeline behind the existing non-bypassable hold.
 */
export const REMOTE_EXPOSED_TOOLS: readonly string[] = [
  ...ADVISORY_EXPOSED_TOOLS,
  "squad_run",
  "squad_status",
];

/** Resolve the required scope for a tool id, or `undefined` if unknown. */
export function requiredScopeFor(toolId: string): string | undefined {
  return TOOL_SCOPES[toolId];
}

/** True when the tool is exposed over the remote (HTTP) boundary in the thin slice. */
export function isHeroTool(toolId: string): boolean {
  return THIN_SLICE_HERO_TOOLS.includes(toolId);
}

/**
 * True when the tool is an ADVISORY tool exposed over the remote boundary in
 * BOTH postures (Phase 5): the hero tools plus `squad_plan` / `squad_architect`.
 * These are exposed even when the gated async pipeline is disabled.
 */
export function isAdvisoryExposed(toolId: string): boolean {
  return ADVISORY_EXPOSED_TOOLS.includes(toolId);
}

/** True when the tool is reachable over the remote (HTTP) boundary (Phase 1b.4). */
export function isRemotelyExposed(toolId: string): boolean {
  return REMOTE_EXPOSED_TOOLS.includes(toolId);
}

/** The synthetic status-poll utility tool id (not a squad routing intent). */
export const SQUAD_STATUS_TOOL = "squad_status";

/**
 * The synthetic deterministic render tool id (not a squad routing intent, so it
 * is not in `tools.catalog.yml` and does not participate in the generator drift
 * check — the same posture as {@link SQUAD_STATUS_TOOL}). It is a transport-level
 * utility that renders deck content YAML to a `.pptx` and returns a short-lived
 * download link. Exposed only when the operator enables the render feature.
 */
export const SQUAD_RENDER_PPTX_TOOL = "squad_render_pptx";
