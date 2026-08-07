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
  // squad_federate is the federation meta layer (routes across named sub-squads).
  // It is the SAME safety class as squad_run (catch-all + gates), so it carries a
  // dedicated scope rather than reusing Squad.Run: a caller authorized to run one
  // squad is not thereby authorized to drive a whole federation.
  squad_federate: "Squad.Federate",
  // squad_status polls a run the caller started; it reuses the Squad.Run scope
  // (you may inspect runs you are authorized to start).
  squad_status: "Squad.Run",
  // squad_render_pptx is a deterministic file-output utility (content YAML -> a
  // .pptx download link). It carries its own least-privilege scope so a render
  // grant does not imply research/plan/run. Fail-closed like every other tool.
  squad_render_pptx: "Squad.Render",
  // squad_memory_read exposes the project's own `.copilot-tracking/squad/` memory
  // + history over the MCP resource read surface. It carries a dedicated,
  // least-privilege READ scope so a memory grant never implies research/plan/run
  // (and never the write scope below). Fail-closed like every other tool.
  squad_memory_read: "Squad.Memory",
  // squad_memory_write is the compare-and-swap write-back tool for the same
  // memory. Its scope is SEPARATE from the read scope so a caller that may read
  // memory (Squad.Memory) still cannot mutate it without Squad.MemoryWrite.
  squad_memory_write: "Squad.MemoryWrite",
  // squad_memory_sync is the BATCH compare-and-swap write-back tool (WI-02): it
  // flushes several memory entries in one call, each under its own CAS. It reuses
  // the SAME Squad.MemoryWrite scope as squad_memory_write (a batch write is still
  // a write — no new scope), so a caller that may write one entry may flush many.
  squad_memory_sync: "Squad.MemoryWrite",
  // squad_history browses the persisted `.copilot-tracking` tree a run produced
  // — the artifact side of the same project the memory tools expose. Reading a
  // run's own output is a READ of that project, so it reuses Squad.Memory rather
  // than minting a scope an operator would have to grant twice for one capability.
  squad_history: "Squad.Memory",
  // squad_business_plan is the business-facing advisory tool (a single embedded
  // dispatch producing a sectioned business plan). Least-privilege: a business
  // grant never implies research/plan/run.
  squad_business_plan: "Squad.Business",
  // squad_backlog produces the STRUCTURED (JSON) backlog contract a Copilot Studio
  // agent loops into the native ADO/Jira connector. Separate scope from
  // Squad.Business so a backlog grant is independently revocable.
  squad_backlog: "Squad.Backlog",
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
  // squad_federate is the federation meta layer. It is deliberately here (the
  // pipeline-gated set) and NOT in ADVISORY_EXPOSED_TOOLS: like squad_run it is a
  // catch-all with `gates: true`, so it must inherit the same non-bypassable Human
  // Gate + durable run-state prerequisites rather than run as a synchronous
  // advisory call. Exposing it in the advisory-only posture would create a gated
  // tool with no durable approval channel behind it (HIGH-1).
  "squad_federate",
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

/**
 * The synthetic memory READ tool id (not a squad routing intent, so it is not in
 * `tools.catalog.yml` and does not participate in the generator drift check — the
 * same posture as {@link SQUAD_STATUS_TOOL} / {@link SQUAD_RENDER_PPTX_TOOL}). It
 * backs the shared-state broker's read surface; exposed only when the operator
 * enables the memory feature (`SQUAD_MCP_ENABLE_MEMORY`).
 */
export const SQUAD_MEMORY_READ_TOOL = "squad_memory_read";

/**
 * The synthetic HISTORY tool id — list and read the `.copilot-tracking` tree a
 * run wrote. Same synthetic posture as the memory tools above: it is not a squad
 * routing intent, so it is not in the catalog and is exempt from the drift check.
 */
export const SQUAD_HISTORY_TOOL = "squad_history";

/**
 * The synthetic memory WRITE tool id — the compare-and-swap write-back tool for
 * the shared-state broker. Same synthetic posture as the read tool above; exposed
 * only when the operator enables the memory feature.
 */
export const SQUAD_MEMORY_WRITE_TOOL = "squad_memory_write";

/**
 * The synthetic memory SYNC tool id — the BATCH compare-and-swap write-back tool
 * (WI-02). It flushes an array of `.copilot-tracking/squad/` entries in one call,
 * each applied under its own CAS token, so a delegated host can persist a whole
 * run's artifacts after the fact. Same synthetic posture and feature-gating as
 * the read/write tools above, and it reuses the existing {@link SQUAD_MEMORY_WRITE_TOOL}
 * scope (Squad.MemoryWrite) — a batch write is still a write, so no new scope.
 */
export const SQUAD_MEMORY_SYNC_TOOL = "squad_memory_sync";

/**
 * The memory broker tools exposed over the remote (HTTP) boundary WHEN the
 * operator enables the memory feature. Unlike {@link ADVISORY_EXPOSED_TOOLS},
 * membership here does NOT imply exposure by construction: the feature is
 * off-by-default and gated at runtime by the `enableMemory` operator flag, so a
 * caller reaches these tools only when the broker is explicitly turned on AND a
 * backing store is configured. Kept out of the advisory/remote sets so the
 * default posture (advisory-only) is unchanged.
 */
export const MEMORY_EXPOSED_TOOLS: ReadonlySet<string> = new Set([
  SQUAD_MEMORY_READ_TOOL,
  SQUAD_MEMORY_WRITE_TOOL,
  SQUAD_MEMORY_SYNC_TOOL,
  SQUAD_HISTORY_TOOL,
]);

/**
 * True when the tool is a memory broker tool. This is a CLASSIFICATION predicate
 * only — it says the tool belongs to the memory feature, not that it is currently
 * reachable. The caller gates actual exposure on the operator flag
 * (`enableMemory`), mirroring how the render tool is gated on `enableRenderPptx`.
 */
export function isMemoryExposed(toolId: string): boolean {
  return MEMORY_EXPOSED_TOOLS.has(toolId);
}

/** The federation meta tool id (a catalog tool, unlike the synthetic ids above). */
export const SQUAD_FEDERATE_TOOL = "squad_federate";

/**
 * The synthetic BUSINESS-PLAN tool id. Like {@link SQUAD_RENDER_PPTX_TOOL} it is a
 * transport-level tool rather than a squad routing intent, so it is NOT in
 * `tools.catalog.yml` and does not participate in the generator drift check. It
 * runs ONE embedded advisory dispatch against a real cast persona and returns a
 * sectioned business plan — advisory text only, no impactful action.
 */
export const SQUAD_BUSINESS_PLAN_TOOL = "squad_business_plan";

/**
 * The synthetic STRUCTURED-BACKLOG tool id. Same synthetic posture as
 * {@link SQUAD_BUSINESS_PLAN_TOOL}, but its result is a VALIDATED JSON backlog
 * contract (epics → stories → tasks plus a flattened `workItems[]`) that a Copilot
 * Studio agent loops one-per-item into the NATIVE Azure DevOps / Jira connector.
 * This server still performs no ADO/Jira write of its own (ADR-0001 trust
 * boundary); it only produces the plan the certified connector executes.
 */
export const SQUAD_BACKLOG_TOOL = "squad_backlog";

/**
 * The business-facing tools exposed over the remote boundary WHEN the operator
 * enables the business feature. Like {@link MEMORY_EXPOSED_TOOLS}, membership is a
 * CLASSIFICATION only — actual exposure is gated at runtime on the
 * `enableBusinessTools` operator flag, so the default posture is unchanged.
 */
export const BUSINESS_EXPOSED_TOOLS: ReadonlySet<string> = new Set([
  SQUAD_BUSINESS_PLAN_TOOL,
  SQUAD_BACKLOG_TOOL,
]);

/**
 * True when the tool belongs to the business-user feature. CLASSIFICATION only —
 * the caller gates reachability on the operator flag (`enableBusinessTools`).
 */
export function isBusinessExposed(toolId: string): boolean {
  return BUSINESS_EXPOSED_TOOLS.has(toolId);
}
