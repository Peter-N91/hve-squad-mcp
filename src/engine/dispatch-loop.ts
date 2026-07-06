/**
 * In-process multi-stage dispatch loop (embedded execution).
 *
 * The thin slice ran ONE server-side model dispatch per hero tool. This loop is
 * the next increment: it runs an ORDERED list of role personas as sequential
 * `ModelBackend.complete()` calls, threading each stage's output into the next as
 * DATA. For the spike the order is fixed (Task Researcher -> Task Reviewer); the
 * full routing/fan-out is a later increment (WI-04).
 *
 * It deliberately sequences plain completions rather than a native tool-calling
 * loop (research KD-3 option a; native tool-calling is WI-02). It binds only to
 * the {@link ModelBackend} seam, so the Azure OpenAI backend today and any future
 * backend run the same loop unchanged.
 *
 * SEC-5 is preserved by construction: every stage's `system` is the persona
 * charter ONLY (AUTHORITY); the caller input and the prior-stage artifact are
 * carried as delimited DATA in `messages` via `composeEmbeddedPrompt`.
 */
import { composeEmbeddedPrompt } from "./embedded-prompt.js";
import { resolvePersonaForRole } from "./embedded-roles.js";
import type { PersonaRecord } from "./persona-loader.js";
import type { RoutePlan } from "./routing.js";
import type { BackendUsage, ModelBackend } from "./model-backend.js";
import type { CoordinatorRequest } from "./coordinator-engine.js";

/** The result of one pipeline stage. */
export interface PipelineStageResult {
  role: string;
  text: string;
  backendId: string;
  usage?: BackendUsage;
}

/** The result of a full pipeline run. */
export interface PipelineResult {
  /** The combined, section-per-role artifact (the finished squad-guided output). */
  artifact: string;
  /** Per-stage results in execution order. */
  stages: PipelineStageResult[];
  /** Per-stage usage (for cost accounting). */
  usage: BackendUsage[];
}

export interface DispatchLoopDeps {
  backend: ModelBackend;
}

/**
 * Run the given persona stages in order as sequential model completions. Each
 * stage sees the caller request/context plus the PRIOR stage's artifact as DATA.
 * Returns the combined artifact and per-stage results.
 */
export async function runPipeline(
  stages: PersonaRecord[],
  request: CoordinatorRequest,
  deps: DispatchLoopDeps,
): Promise<PipelineResult> {
  const results: PipelineStageResult[] = [];
  let priorArtifact: string | undefined;

  for (const stage of stages) {
    // SEC-5 — persona charter is the ONLY authority; caller input + prior artifact are DATA.
    const prompt = composeEmbeddedPrompt({
      systemAuthority: stage.charter,
      request: request.request,
      context: request.context,
      priorArtifact,
    });
    const completion = await deps.backend.complete({
      system: prompt.system,
      messages: prompt.messages,
    });
    results.push({
      role: stage.role,
      text: completion.text,
      backendId: completion.backendId,
      usage: completion.usage,
    });
    priorArtifact = completion.text;
  }

  const artifact = results.map((stage) => `## ${stage.role}\n\n${stage.text}`).join("\n\n");
  const usage = results.map((stage) => stage.usage).filter((u): u is BackendUsage => Boolean(u));
  return { artifact, stages: results, usage };
}

/**
 * Resolve a routed {@link RoutePlan} into the ordered {@link PersonaRecord}
 * stages the pipeline runs, using the Phase 1 from-disk loader
 * (`resolvePersonaForRole`, real `*.agent.md` bytes first, hero paraphrase
 * fallback only for the two deterministic hero agents when the cast is absent).
 *
 * Each stage's `agentName` from the router is looked up against the deployed
 * cast; stages whose persona cannot be resolved are dropped (never a silent
 * wrong persona). This is the bridge that makes the routed stage list
 * consumable by {@link runPipeline} — it wires NO orchestrator or council
 * (that is Phase 3), it only turns routed `agentName`s into persona charters.
 */
export function resolveRoutedStages(plan: RoutePlan, roots?: string[]): PersonaRecord[] {
  const personas: PersonaRecord[] = [];
  for (const stage of plan.stages) {
    const persona = resolvePersonaForRole(stage.agentName, roots);
    if (persona) {
      personas.push(persona);
    }
  }
  return personas;
}

/**
 * Run the linear stages of a routed {@link RoutePlan} as sequential model
 * completions. This is the routed sibling of {@link runPipeline}: it resolves
 * the plan's `agentName`s to personas via {@link resolveRoutedStages}, then runs
 * the same SEC-5-preserving loop. The council (when engaged) is NOT dispatched
 * here — Phase 3 interleaves it between plan and review.
 */
export async function runRoutedPipeline(
  plan: RoutePlan,
  request: CoordinatorRequest,
  deps: DispatchLoopDeps,
  roots?: string[],
): Promise<PipelineResult> {
  return runPipeline(resolveRoutedStages(plan, roots), request, deps);
}
