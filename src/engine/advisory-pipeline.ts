/**
 * Mode-aware ADVISORY pipeline orchestrator.
 *
 * The dispatch loop runs an ordered list of persona completions; the router
 * turns a request into a routed stage plan. This orchestrator composes the two
 * into the full ADVISORY sequence and runs it as sequential model completions:
 *
 *     research (`researcher`)
 *       -> plan (`lead`)
 *       -> council (`architect`, `security`, `cost-manager`, `product-owner`,
 *                   +`rai`) — interleaved between plan and review when engaged
 *       -> review (`tester`)
 *       -> backlog-handoff (`product-owner`)
 *
 * It performs NO code execution and NO impactful action — those are the deferred
 * execution expansion. The advisory scope produces finished TEXT artifacts only,
 * so the only human gate is the existing final hold applied to the compiled
 * artifact before it is returned (modeled here by an injectable
 * {@link AdvisoryFinalHold}; in a deployed run this is the existing
 * `GateKeeper`/approval machinery, unchanged).
 *
 * Mode handling:
 *   * default / `interactive` — returns after EACH stage with a resume token so
 *     the caller advances stage-by-stage (a turn per stage).
 *   * `autopilot` / `autonomous` — advance stage-to-stage without pausing to a
 *     single compiled artifact (advisory work has no impactful action, so there
 *     is no per-stage human gate).
 *
 * SEC-5 is preserved by construction: every stage's `system` is the resolved
 * persona charter ONLY (AUTHORITY); the caller request/context and every prior
 * artifact (including the council verdict) are carried as delimited DATA via
 * `composeEmbeddedPrompt` / the council dispatch.
 *
 * A per-run cost ceiling ({@link AdvisoryPipelineDeps.costLedger}) is checked
 * BEFORE each stage; exceeding it halts the run with a clear reason and zero
 * further model calls.
 */
import { composeEmbeddedPrompt } from "./embedded-prompt.js";
import { resolvePersonaForRole, resolvePersonaForRosterRole } from "./embedded-roles.js";
import { runCouncil, resolveCouncilMembers, type CouncilDeps, type CouncilVerdict } from "./council.js";
import { loadRosterMap, route, type RoutePlan } from "./routing.js";
import type { RunCostLedger } from "./gates.js";
import type { PersonaRecord } from "./persona-loader.js";
import type { PersistedCouncilVerdict, PersistedStageArtifact } from "./run-state.js";
import type { BackendUsage, ModelBackend } from "./model-backend.js";
import type { CoordinatorRequest } from "./coordinator-engine.js";

/** The normalized advisory execution mode. */
export type AdvisoryMode = "interactive" | "autopilot" | "autonomous";

/** The roster role KEY the backlog-handoff stage resolves to. */
const BACKLOG_ROLE_KEY = "product-owner";

/** Normalize a raw `mode` string into an {@link AdvisoryMode} (default interactive). */
export function normalizeAdvisoryMode(mode?: string): AdvisoryMode {
  const m = (mode ?? "").trim().toLowerCase();
  if (m === "autopilot") {
    return "autopilot";
  }
  if (m === "autonomous") {
    return "autonomous";
  }
  return "interactive";
}

/** One resolved stage in the ordered advisory execution plan. */
export interface AdvisoryStagePlan {
  /** `persona` — a single persona completion; `council` — the parallel go/no-go. */
  kind: "persona" | "council";
  /** The section heading / role label for the stage. */
  role: string;
  /** The resolved persona (for a `persona` stage). */
  persona?: PersonaRecord;
  /** The resolved council members (for a `council` stage). */
  members?: PersonaRecord[];
  /** True when this persona stage is the appended backlog-handoff. */
  backlog?: boolean;
}

/** The result of one executed advisory stage. */
export interface AdvisoryStageResult {
  kind: "persona" | "council";
  /** The persona role, or `Council Verdict` for the council stage. */
  role: string;
  /** The fully-rendered markdown section for the stage (includes its own heading). */
  section: string;
  /** The raw stage text (persona completion, or the rendered verdict markdown). */
  text: string;
  backendId?: string;
  usage?: BackendUsage;
}

/** The non-terminal / terminal outcome of an advisory run. */
export type AdvisoryOutcome = "completed" | "paused" | "halted" | "held";

/** A resume token for an interactive advisory run (in-process; durable state is Phase 4). */
export interface AdvisoryResumeState {
  /** The fully-resolved ordered plan the run is executing. */
  plan: AdvisoryStagePlan[];
  /** The stage results accumulated so far. */
  stages: AdvisoryStageResult[];
  /** The artifact from the last executed stage (threaded forward as DATA). */
  priorArtifact?: string;
  /** The council verdict, once the council stage has run. */
  councilVerdict?: CouncilVerdict;
  /** The index of the next stage to execute. */
  nextIndex: number;
}

/**
 * The final human hold seam (advisory scope). When supplied, the compiled
 * artifact must pass this hold before it is returned. Advisory work has no
 * impactful action, so the default (no hold supplied) returns immediately; in a
 * deployed run this delegates to the existing `GateKeeper`/approval machinery.
 */
export interface AdvisoryFinalHold {
  /** True when the compiled artifact must be held for out-of-band human approval. */
  shouldHold(compiled: string): boolean | Promise<boolean>;
  /** The approval request surfaced when held. */
  approvalRequest?: string;
  /** The hold reason surfaced when held. */
  reason?: string;
}

/**
 * Phase 4 — the durable progress sink for an advisory run. The orchestrator calls
 * these as it advances; a store-backed adapter ({@link import("./advisory-run-store.js").StoreAdvisoryPersistence})
 * persists them to the {@link import("./run-state.js").RunStateStore} so a status
 * poll recompiles the artifact after a cold start / on another replica. It is
 * write-only from the pipeline's view and store-agnostic (the concrete store
 * binding lives in the adapter), so the orchestrator stays free of store types.
 */
export interface AdvisoryRunPersistence {
  /** Append a completed stage's section (and an implicit history entry). */
  recordStage(stage: PersistedStageArtifact): Promise<void>;
  /** Persist the council verdict once the council stage has synthesized it. */
  recordVerdict(verdict: PersistedCouncilVerdict): Promise<void>;
}

/**
 * Recompile the artifact from persisted stages (Phase 4). Each persisted stage's
 * `artifact` is the fully-rendered section, so recompilation is the same join the
 * in-process {@link compileArtifact} performs — a status poll and the live run
 * therefore yield the identical compiled artifact.
 */
export function compilePersistedStages(stages: readonly PersistedStageArtifact[]): string {
  return stages.map((stage) => stage.artifact).join("\n\n");
}

export interface AdvisoryPipelineDeps {
  backend: ModelBackend;
  /** Per-run cost ceiling (COST-2, run scope). Optional; when absent, no ceiling. */
  costLedger?: RunCostLedger;
  /** The existing final human hold applied to the compiled artifact before return. */
  finalHold?: AdvisoryFinalHold;
  /**
   * Phase 4 — durable progress sink. When supplied (an async/durable run), each
   * completed stage's section, the council verdict, and a history entry are
   * written through as the run advances, so a status poll can recompile the
   * artifact from the store multi-replica and after a cold start. When absent (the
   * synchronous/interactive in-process case) the run stays purely in-process.
   */
  persistence?: AdvisoryRunPersistence;
}

export interface AdvisoryPipelineOptions {
  /** Raw autonomy mode (`autopilot` | `autonomous` | default interactive). */
  mode?: string;
  /** Persona-cast roots override (tests / deployed cast); default resolver otherwise. */
  roots?: string[];
  /** Pre-parsed roster map for backlog-handoff resolution (tests); default loads from disk. */
  rosterMap?: ReadonlyMap<string, string>;
  /** Inject a pre-resolved ordered plan (tests / re-entry) instead of routing. */
  plan?: AdvisoryStagePlan[];
  /** Resume an interactive run from a prior {@link AdvisoryResumeState}. */
  resume?: AdvisoryResumeState;
}

/** The result of an advisory run. Artifact is partial on `paused` / `halted`. */
export interface AdvisoryPipelineResult {
  outcome: AdvisoryOutcome;
  /** The compiled, section-per-stage artifact (partial on a non-`completed` outcome). */
  artifact: string;
  /** Per-stage results in execution order. */
  stages: AdvisoryStageResult[];
  /** The council verdict when the council stage ran. */
  councilVerdict?: CouncilVerdict;
  /** Per-stage usage (for cost accounting). */
  usage: BackendUsage[];
  /** Accumulated realized cost across the run so far. */
  costUsd: number;
  /** Reason for a non-`completed` outcome (`run_cost_ceiling` | `council_stop` | hold reason). */
  reason?: string;
  /** The approval request surfaced when `held`. */
  approvalRequest?: string;
  /** The resume token when `paused` (interactive). */
  resume?: AdvisoryResumeState;
}

function personaStage(persona: PersonaRecord, backlog = false): AdvisoryStagePlan {
  return { kind: "persona", role: persona.role, persona, backlog };
}

/** Load the roster map, tolerating an absent deployed cast (returns undefined). */
function safeRosterMap(rosterMap?: ReadonlyMap<string, string>): ReadonlyMap<string, string> | undefined {
  if (rosterMap) {
    return rosterMap;
  }
  try {
    return loadRosterMap();
  } catch {
    return undefined;
  }
}

/** Resolve the backlog-handoff persona (`product-owner` roster role). */
function resolveBacklogPersona(
  roots?: string[],
  rosterMap?: ReadonlyMap<string, string>,
): PersonaRecord | undefined {
  const map = safeRosterMap(rosterMap);
  if (!map) {
    return undefined;
  }
  return resolvePersonaForRosterRole(BACKLOG_ROLE_KEY, map, roots);
}

/**
 * Resolve a routed {@link RoutePlan} into the ordered advisory execution plan:
 * research -> plan -> [council] -> review -> backlog-handoff. The council is
 * interleaved between plan and review only when engaged; the backlog-handoff is
 * appended only for a full advisory route (a research-only route stays a single
 * research stage). Stages whose persona cannot be resolved are dropped (never a
 * silent wrong persona).
 */
export function planAdvisoryStages(
  plan: RoutePlan,
  roots?: string[],
  rosterMap?: ReadonlyMap<string, string>,
): AdvisoryStagePlan[] {
  const ordered: AdvisoryStagePlan[] = [];

  // Research-only route: a single research stage, no council, no backlog.
  if (plan.stages.length <= 1) {
    const first = plan.stages[0];
    const persona = first ? resolvePersonaForRole(first.agentName, roots) : undefined;
    if (persona) {
      ordered.push(personaStage(persona));
    }
    return ordered;
  }

  // Full advisory route: research -> plan -> [council] -> review -> backlog.
  const [research, planStage, review] = plan.stages;

  const researchPersona = resolvePersonaForRole(research.agentName, roots);
  if (researchPersona) {
    ordered.push(personaStage(researchPersona));
  }

  const planPersona = resolvePersonaForRole(planStage.agentName, roots);
  if (planPersona) {
    ordered.push(personaStage(planPersona));
  }

  if (plan.council.engaged) {
    const members = resolveCouncilMembers(plan, roots);
    if (members.length > 0) {
      ordered.push({ kind: "council", role: "Council Verdict", members });
    }
  }

  const reviewPersona = resolvePersonaForRole(review.agentName, roots);
  if (reviewPersona) {
    ordered.push(personaStage(reviewPersona));
  }

  const backlogPersona = resolveBacklogPersona(roots, rosterMap);
  if (backlogPersona) {
    ordered.push(personaStage(backlogPersona, true));
  }

  return ordered;
}

/** Compile the accumulated stage sections into one artifact. */
function compileArtifact(stages: AdvisoryStageResult[]): string {
  return stages.map((stage) => stage.section).join("\n\n");
}

/** Collect the per-stage usage list from accumulated results. */
function collectUsage(stages: AdvisoryStageResult[]): BackendUsage[] {
  return stages.map((stage) => stage.usage).filter((u): u is BackendUsage => Boolean(u));
}

/**
 * Run (or resume) the ordered advisory pipeline. When no `plan`/`resume` is
 * injected the request is routed (`route`) and resolved (`planAdvisoryStages`)
 * from the deployed cast. Returns the compiled artifact plus the terminal or
 * resumable outcome.
 */
export async function runAdvisoryPipeline(
  request: CoordinatorRequest,
  deps: AdvisoryPipelineDeps,
  opts: AdvisoryPipelineOptions = {},
): Promise<AdvisoryPipelineResult> {
  const mode = normalizeAdvisoryMode(opts.mode ?? request.mode);

  // Resolve (or resume) the ordered plan.
  let orderedPlan: AdvisoryStagePlan[];
  const stages: AdvisoryStageResult[] = [];
  let priorArtifact: string | undefined;
  let councilVerdict: CouncilVerdict | undefined;
  let startIndex = 0;

  if (opts.resume) {
    orderedPlan = opts.resume.plan;
    stages.push(...opts.resume.stages);
    priorArtifact = opts.resume.priorArtifact;
    councilVerdict = opts.resume.councilVerdict;
    startIndex = opts.resume.nextIndex;
  } else if (opts.plan) {
    orderedPlan = opts.plan;
  } else {
    const routePlan = route(request.request, {
      profile: request.profile,
      mode: request.mode,
      tier: request.tier,
      owner: request.owner,
    });
    orderedPlan = planAdvisoryStages(routePlan, opts.roots, opts.rosterMap);
  }

  const councilDeps: CouncilDeps = { backend: deps.backend };

  for (let i = startIndex; i < orderedPlan.length; i += 1) {
    // COST-2 (run scope) — check BEFORE the stage; halt with 0 further calls.
    const check = deps.costLedger?.check();
    if (check && !check.ok) {
      return {
        outcome: "halted",
        artifact: compileArtifact(stages),
        stages,
        councilVerdict,
        usage: collectUsage(stages),
        costUsd: check.spentUsd,
        reason: check.reason,
      };
    }

    const stage = orderedPlan[i];

    if (stage.kind === "council" && stage.members) {
      const verdict = await runCouncil(stage.members, priorArtifact ?? "", request, councilDeps);
      councilVerdict = verdict;
      for (const usage of verdict.usage) {
        deps.costLedger?.record(usage.estimatedCostUsd);
      }
      const result: AdvisoryStageResult = {
        kind: "council",
        role: "Council Verdict",
        section: verdict.markdown,
        text: verdict.markdown,
        usage: verdict.usage.at(-1),
      };
      stages.push(result);
      priorArtifact = verdict.markdown;

      // Phase 4 — persist the verdict section + structured verdict as the run
      // advances (durable/async run only; a no-op in the in-process case).
      await deps.persistence?.recordStage({ role: "Council Verdict", artifact: verdict.markdown });
      await deps.persistence?.recordVerdict({
        class: verdict.verdict,
        conditions: verdict.conditions,
        rendered: verdict.markdown,
      });

      // A Stop verdict halts the advisory pipeline (no implement stage to gate).
      if (verdict.verdict === "Stop") {
        return {
          outcome: "halted",
          artifact: compileArtifact(stages),
          stages,
          councilVerdict,
          usage: collectUsage(stages),
          costUsd: deps.costLedger?.spentUsd() ?? 0,
          reason: "council_stop",
        };
      }
    } else if (stage.persona) {
      // SEC-5 — persona charter is the ONLY authority; caller input + prior artifact are DATA.
      const prompt = composeEmbeddedPrompt({
        systemAuthority: stage.persona.charter,
        request: request.request,
        context: request.context,
        priorArtifact,
      });
      const completion = await deps.backend.complete({
        system: prompt.system,
        messages: prompt.messages,
      });
      deps.costLedger?.record(completion.usage?.estimatedCostUsd);
      const result: AdvisoryStageResult = {
        kind: "persona",
        role: stage.role,
        section: `## ${stage.role}\n\n${completion.text}`,
        text: completion.text,
        backendId: completion.backendId,
        usage: completion.usage,
      };
      stages.push(result);
      priorArtifact = completion.text;

      // Phase 4 — persist the completed stage section (durable/async run only).
      await deps.persistence?.recordStage({ role: stage.role, artifact: result.section });
    }

    // Interactive mode returns after each stage with a resume token.
    if (mode === "interactive" && i < orderedPlan.length - 1) {
      return {
        outcome: "paused",
        artifact: compileArtifact(stages),
        stages,
        councilVerdict,
        usage: collectUsage(stages),
        costUsd: deps.costLedger?.spentUsd() ?? 0,
        resume: {
          plan: orderedPlan,
          stages: [...stages],
          priorArtifact,
          councilVerdict,
          nextIndex: i + 1,
        },
      };
    }
  }

  const artifact = compileArtifact(stages);

  // The only advisory human gate: the existing final hold on the compiled artifact.
  if (deps.finalHold && (await deps.finalHold.shouldHold(artifact))) {
    return {
      outcome: "held",
      artifact,
      stages,
      councilVerdict,
      usage: collectUsage(stages),
      costUsd: deps.costLedger?.spentUsd() ?? 0,
      reason: deps.finalHold.reason ?? "final_hold",
      approvalRequest: deps.finalHold.approvalRequest,
    };
  }

  return {
    outcome: "completed",
    artifact,
    stages,
    councilVerdict,
    usage: collectUsage(stages),
    costUsd: deps.costLedger?.spentUsd() ?? 0,
  };
}
