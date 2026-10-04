/**
 * EmbeddedCoordinator — Phase 1 server-side execution (thin slice).
 *
 * Runs a hero tool's squad stage server-side and returns a finished,
 * squad-guided artifact. It reuses the SAME router/catalog and the SAME persona
 * source of truth as the delegated path (no fork), and composes every council
 * condition into one execution flow:
 *
 *   * SEC-9 / COST-1 / COST-2 — admit under the per-tenant concurrency + cost
 *     ceiling BEFORE any work; refuse past either limit.
 *   * SEC-6 / SEC-7 / PROD-5 — a gated/destructive/confirm-tier tool HOLDS for
 *     out-of-band human approval and never auto-releases; no model call is made
 *     for a held run.
 *   * SEC-5 — caller `request`/`context` are composed as delimited DATA, never
 *     as authority (see `embedded-prompt.ts`). Routing, scope, and gate decisions
 *     are all made BEFORE the prompt is composed, so injection has nothing to flip.
 *   * SEC-4 — all file/memory work happens inside a server-allocated, per-tenant
 *     ephemeral workspace with GUARANTEED teardown (the `finally` below runs even
 *     on error/timeout).
 *   * SEC-3 — the caller's tenant identity is the single root; any future
 *     downstream call must authorize against it (the thin slice makes none).
 *   * ARCH-1 — run state flows through the `RunStateStore` seam so the durable
 *     resumable variant drops in later without changing this engine.
 *
 * SEC-7 is also structural: this module imports NO process/shell primitive
 * (`child_process`, `node:child_process`, `exec`, `spawn`) and never will in the
 * embedded path. The hero tool does inference plus contained file I/O only.
 */
import { readFile, writeFile } from "node:fs/promises";

import { charterForRole, resolvePersonaForRole } from "./embedded-roles.js";
import { composeEmbeddedPrompt } from "./embedded-prompt.js";
import { AutoMemory, withMemoryContext } from "./auto-memory.js";
import type { SquadRunRecorder } from "./squad-run-recorder.js";
import { isAdvisoryOnly } from "./gates.js";
import { defaultProfileTables, resolveProfile } from "./profiles.js";
import type { BusinessToolSpec } from "./business-tools.js";
import { FEDERATION_ROLE, federationPersona } from "./federation.js";
import {
  coordinatorRequestFromRun,
  decodeRunParams,
  encodeRunParams,
} from "./run-params.js";
import { runPipeline } from "./dispatch-loop.js";
import { AdvisoryStageFailure, runAdvisoryPipeline, type AdvisoryLedgerSink, type AdvisoryStagePlan } from "./advisory-pipeline.js";
import { StoreAdvisoryPersistence } from "./advisory-run-store.js";
import type { PersonaRecord } from "./persona-loader.js";
import { EphemeralRunStateStore, type HumanInputRequest, type RunState, type RunStateStore, type RunStatus } from "./run-state.js";
import {
  GateKeeper,
  InMemoryApprovalChannel,
  TenantQuotaTracker,
  type ApprovalRecord,
  type HumanApprovalChannel,
} from "./gates.js";
import {
  aggregateBackendUsage,
  attributeCompletion,
  completeWithObserver,
  assertBackendPreflight,
  prepareTaskContext,
  ModelBackendError,
  usageFromCompletionRecords,
  type AttributedCompletionObserver,
  type BackendUsage,
  type CompletionUsageRecord,
  type ModelBackend,
} from "./model-backend.js";
import { responsibleAiBlocker, type ResponsibleAiBlocker } from "./responsible-ai.js";
import { modelFailureDiagnostics, readModelFailure, type ModelFailureDiagnostics } from "./model-backend.js";
import type { CatalogTool } from "../catalog/catalog.js";
import type { CoordinatorRequest, MatchedRouting } from "./coordinator-engine.js";
import type { AuthContext } from "../auth/entra.js";
import type { WorkspaceManager } from "./workspace.js";
import type { RedactingLogger } from "../observability/logger.js";
import { parseBrdReview } from "./brd-review.js";
import type { SquadArtifactStore } from "./artifact-store.js";
import { ResearchRuntime, type ResearchRuntimeOptions, type AdvisoryStageExecutor } from "./research-runtime.js";
import { AdvisoryCheckpointPersistenceError, encodeAdvisoryCheckpoint, readAdvisoryCheckpoint } from "./advisory-checkpoint.js";
import type { Workspace } from "./workspace.js";

/** The request-scoped context the embedded engine runs under. */
export interface EmbeddedContext {
  /** The resolved caller identity — the single root for downstream authorization (SEC-3). */
  auth: AuthContext;
}

export type EmbeddedOutcome = "completed" | "held" | "denied";

/** The result of an embedded run. Mirrors the delegated result's `kind` discriminator. */
export interface EmbeddedResult {
  kind: "embedded";
  outcome: EmbeddedOutcome;
  matchedRouting: MatchedRouting;
  /** The finished squad-guided artifact (when `outcome === "completed"`). */
  artifact?: string;
  /** PROD-5: the human-approval request (when `outcome === "held"`). */
  approvalRequest?: string;
  /** Why the run is held or denied. */
  reason?: string;
  responsibleAi?: ResponsibleAiBlocker;
  modelFailure?: ModelFailureDiagnostics;
  /** Server-allocated workspace root used for the run (already torn down on return). */
  workspaceRoot?: string;
  /** Server-allocated run id. */
  runId?: string;
  /** The backend that produced the artifact. */
  backendId?: string;
  usage?: BackendUsage;
  humanInput?: HumanInputRequest;
  expiresAt?: number;
}

export interface EmbeddedCoordinatorDeps {
  backend: ModelBackend;
  workspaceManager: WorkspaceManager;
  quota: TenantQuotaTracker;
  gates?: GateKeeper;
  runStateStore?: RunStateStore;
  approvals?: HumanApprovalChannel;
  /** Per-tenant cap on outstanding held runs (MEDIUM-2 DoS guard). */
  maxHeldRunsPerTenant?: number;
  /**
   * WI-1b4-WORKER — whether a status poll DRIVES execution inline (default true,
   * the single-replica behavior). Set false in a worker deployment so the poll is
   * read-only and a background ACA Job drives runs off the request path (a run may
   * exceed the 240s HTTP ingress ceiling).
   */
  driveOnPoll?: boolean;
  /**
   * With `driveOnPoll`, how long (ms) a poll that claims a run waits for it before
   * answering `run_already_in_flight` while execution continues in this process.
   * Keeps polls under the 240s ingress ceiling. Absent, the poll drives the whole
   * run synchronously.
   */
  pollDriveWaitMs?: number;
  /** WI-06 — TTL (ms) stamped on a newly created async run (default: none). */
  runTtlMs?: number;
  /** WI-06 — worker/poll claim lease (ms); a running run past its lease is reclaimable. */
  leaseMs?: number;
  /** Trusted host budget; long budgets require off-request worker execution. */
  stageDeadlineMs?: number;
  /**
   * Deterministic server-side squad-memory continuity. When supplied, every
   * embedded dispatch is preceded by a read of the resolved project's `state` +
   * `decisions` (injected as DATA) and every completed dispatch is followed by a
   * `history/<toolId>-<runId>` write plus a `state` digest append. Absent (the
   * default), the engine behaves exactly as before — memory stays a manual tool.
   */
  autoMemory?: AutoMemory;
  /**
   * Optional squad-ledger recorder. When wired, each run seeds the roster on
   * first use, reads its own history index back as DATA, and persists stage
   * deliverables plus the append-only logs. Absent, behaviour is unchanged.
   */
  runRecorder?: SquadRunRecorder;
  /** Durable tenant/project artifacts for tool-enabled research and advisory stages. */
  researchArtifacts?: SquadArtifactStore;
  /** Trusted host adapter override; never populated from MCP caller arguments. */
  stageExecutorFactory?: (
    workspace: Workspace,
    project: string | undefined,
    runId: string,
    options?: Pick<ResearchRuntimeOptions, "allowHumanInput" | "continuation" | "deadlineMs" | "onCompletion">,
  ) => AdvisoryStageExecutor;
  logger?: RedactingLogger;
}

function toMatchedRouting(tool: CatalogTool): MatchedRouting {
  return {
    routingIntent: tool.routingIntent,
    role: tool.role,
    tier: tool.tier,
    parallelEligible: tool.parallelEligible,
    council: tool.council,
    catchAll: tool.catchAll,
    gates: tool.gates,
  };
}

/** The spike catch-all pipeline: research then review, run server-side in order. */
const SPIKE_PIPELINE_ROLES = ["Squad Researcher", "Squad Reviewer"] as const;

/** The federation meta tool id (catalog tool; gated + catch-all, like squad_run). */
const FEDERATION_TOOL_ID = "squad_federate";

/**
 * Routing summary attached to a resolved FEDERATION run. Mirrors the catalog's
 * `squad_federate` row so a `squad_status` poll reports the federation role rather
 * than the plain Squad Coordinator (the durable record carries only the run).
 */
const FEDERATION_ROUTING: MatchedRouting = {
  routingIntent: "federation meta layer",
  role: FEDERATION_ROLE,
  tier: "confirm",
  parallelEligible: false,
  council: [],
  catchAll: true,
  gates: true,
};

/** Default per-tenant cap on outstanding held runs (MEDIUM-2 resource-exhaustion guard). */
const DEFAULT_MAX_HELD_RUNS_PER_TENANT = 100;

/**
 * Routing summary attached to an async pipeline result resolved by run id, when
 * the original catalog tool is not in scope (the durable record carries only the
 * run, not the tool). Mirrors the squad_run catch-all pipeline row.
 */
const EMPTY_ROUTING: MatchedRouting = {
  routingIntent: "full classify-and-dispatch pipeline",
  role: "Squad Coordinator",
  tier: "confirm",
  parallelEligible: false,
  council: [],
  catchAll: true,
  gates: true,
};

/** Server-side embedded execution for the hero tool(s). Runs one model dispatch per call. */
export class EmbeddedCoordinator {
  readonly mode = "embedded" as const;
  private readonly backend: ModelBackend;
  private readonly workspaceManager: WorkspaceManager;
  private readonly quota: TenantQuotaTracker;
  private readonly gates: GateKeeper;
  private readonly runStateStore: RunStateStore;
  private readonly approvals: HumanApprovalChannel;
  private readonly maxHeldRunsPerTenant: number;
  private readonly driveOnPoll: boolean;
  private readonly pollDriveWaitMs?: number;
  /** Runs this process is driving in the background, so a lapsed lease cannot start a second drive. */
  private readonly backgroundRuns = new Map<string, Promise<EmbeddedResult>>();
  private readonly runTtlMs?: number;
  private readonly leaseMs?: number;
  private readonly stageDeadlineMs?: number;
  private readonly autoMemory?: AutoMemory;
  private readonly runRecorder?: SquadRunRecorder;
  private readonly researchArtifacts?: SquadArtifactStore;
  private readonly stageExecutorFactory?: EmbeddedCoordinatorDeps["stageExecutorFactory"];
  private readonly logger?: RedactingLogger;
  /** Outstanding held runs per tenant, started via startHttpRun (MEDIUM-2). */
  private readonly heldCounts = new Map<string, number>();

  constructor(deps: EmbeddedCoordinatorDeps) {
    this.backend = deps.backend;
    this.workspaceManager = deps.workspaceManager;
    this.quota = deps.quota;
    this.gates = deps.gates ?? new GateKeeper();
    this.runStateStore = deps.runStateStore ?? new EphemeralRunStateStore();
    this.approvals = deps.approvals ?? new InMemoryApprovalChannel();
    this.maxHeldRunsPerTenant = deps.maxHeldRunsPerTenant ?? DEFAULT_MAX_HELD_RUNS_PER_TENANT;
    this.driveOnPoll = deps.driveOnPoll ?? true;
    this.pollDriveWaitMs = deps.pollDriveWaitMs;
    this.runTtlMs = deps.runTtlMs;
    this.leaseMs = deps.leaseMs;
    this.stageDeadlineMs = deps.stageDeadlineMs;
    this.autoMemory = deps.autoMemory;
    this.runRecorder = deps.runRecorder;
    this.researchArtifacts = deps.researchArtifacts;
    this.stageExecutorFactory = deps.stageExecutorFactory;
    this.logger = deps.logger;
  }

  /**
   * Auto-memory pre-read: resolve the project partition and merge prior `state` +
   * `decisions` into legacy request context as DATA. Explicit task packets are
   * validated before framing and retain their selected context without history.
   */
  private async withMemory(
    tenantId: string,
    request: CoordinatorRequest,
  ): Promise<{ request: CoordinatorRequest; project?: string }> {
    parseBrdReview(request.review);
    if (request.review) assertBackendPreflight({ system: "", messages: [
      { role: "user", content: JSON.stringify(request.review.document) },
      ...request.review.sources.filter((source) => source.content !== undefined).map((source) => ({ role: "user" as const, content: source.content! })),
    ] });
    const packet = request.context !== undefined && prepareTaskContext(request.context).packet;
    const taskOnly = Boolean(request.review) || packet;
    if (!this.autoMemory) {
      return { request };
    }
    const project = this.autoMemory.resolveProject(request);
    let carried = taskOnly ? request : withMemoryContext(request, await this.autoMemory.loadContext(tenantId, project));
    if (this.runRecorder) {
      // Seeding the roster and reading the run index back are the artifact-shaped
      // twin of the digest read above, so they share this one moment.
      const opened = await this.runRecorder.open(tenantId, project, carried);
      if (!taskOnly) carried = withMemoryContext(carried, opened.historyBlock);
      // The seeded roster wins over the caller's hint for the rest of the run.
      carried = { ...carried, profile: opened.profile.name };
    }
    return { request: carried, project };
  }

  /**
   * Auto-memory post-write: persist a completed artifact to history and refresh the
   * project's `state` digest. Never throws (the helper swallows store failures), so
   * a memory outage can never fail an otherwise-successful run.
   */
  private async recordMemory(
    tenantId: string,
    project: string | undefined,
    entry: { toolId: string; runId: string; artifact: string },
  ): Promise<void> {
    if (!this.autoMemory || !project) {
      return;
    }
    await this.autoMemory.record(tenantId, project, entry);
    await this.runRecorder?.closeRun(tenantId, project, entry.runId, []);
  }

  /**
   * The ledger sink for one run, or `undefined` when the ledger is not wired.
   *
   * `project` is only defined when auto-memory resolved a partition, and there is
   * no ledger destination without one — the project IS the partition the tree is
   * written under.
   */
  private ledgerSink(
    tenantId: string,
    project: string | undefined,
    request: CoordinatorRequest,
    runId: string,
  ): AdvisoryLedgerSink | undefined {
    if (!this.runRecorder || !project) {
      return undefined;
    }

    return this.runRecorder.sinkFor(tenantId, project, request, runId);
  }

  private completionRecorder(
    tenantId: string,
    runId: string,
  ): (record: CompletionUsageRecord) => Promise<void> {
    const persistence = new StoreAdvisoryPersistence(this.runStateStore, runId);
    return async (record) => {
      const cost = record.usage?.estimatedCostUsd;
      let recorded: boolean;
      try {
        recorded = await persistence.recordAttributedCompletion(record);
      } catch (error) {
        if (typeof cost === "number" && cost > 0) {
          this.quota.recordCostUsd(tenantId, cost);
        }

        throw error;
      }
      if (!recorded) {
        return;
      }
      if (typeof cost === "number" && cost > 0) {
        this.quota.recordCostUsd(tenantId, cost);
      }
      this.logger?.info("model completion accounted", {
        eventId: record.eventId,
        runId: record.runId,
        stage: record.stage,
        actor: record.actor,
        attempt: record.attempt,
        outcome: record.outcome,
        backendId: record.backendId,
        model: record.model,
        deployment: record.deployment,
        providerResponseId: record.providerResponseId,
        toolCallCount: record.toolCallCount,
        inputTokens: record.usage?.inputTokens,
        outputTokens: record.usage?.outputTokens,
        reasoningTokens: record.usage?.reasoningTokens,
        cacheReadTokens: record.usage?.cacheReadTokens,
        cacheWriteTokens: record.usage?.cacheWriteTokens,
        estimatedCostUsd: record.usage?.estimatedCostUsd,
        costCurrency: record.usage?.costCurrency,
        costBasis: record.usage?.costBasis,
        costStatus: record.usage?.costStatus ?? "unavailable",
        "gen_ai.operation.name": "chat",
        "gen_ai.response.model": record.model,
        "gen_ai.request.model": record.deployment,
        "gen_ai.agent.name": record.actor,
        "microsoft.gen_ai.main_agent.name": record.stage,
        "gen_ai.conversation.id": record.runId,
        "gen_ai.usage.input_tokens": record.usage?.inputTokens,
        "gen_ai.usage.output_tokens": record.usage?.outputTokens,
        "gen_ai.usage.cache_read.input_tokens": record.usage?.cacheReadTokens,
        "gen_ai.usage.cache_write.input_tokens": record.usage?.cacheWriteTokens,
        "gen_ai.usage.reasoning_tokens": record.usage?.reasoningTokens,
        "gen_ai.tool.call_count": record.toolCallCount,
        "error.type": record.outcome === "completed" ? undefined : record.finishReason ?? record.outcome,
        resultCode: record.outcome,
        success: record.outcome === "completed",
      });
    };
  }

  private async localPreflightResult(
    error: unknown, runId: string, matchedRouting: MatchedRouting,
  ): Promise<EmbeddedResult | undefined> {
    const cause = error instanceof AdvisoryStageFailure ? error.cause : error;
    if (!(cause instanceof ModelBackendError) || !cause.preflight || cause.providerAttempted !== false) return undefined;
    const stage = error instanceof AdvisoryStageFailure ? error.failedStage : matchedRouting.role;
    const modelFailure = modelFailureDiagnostics(cause, stage, runId);
    const reason = `model_backend_${cause.kind}`;
    await this.runStateStore.update(runId, { status: "failed", failureReason: reason, modelFailure });
    this.logger?.info("local model preflight rejected", { runId, modelFailure });
    return { kind: "embedded", outcome: "denied", matchedRouting, runId, reason, modelFailure };
  }

  private completionObserver(
    tenantId: string,
    runId: string,
  ): AttributedCompletionObserver {
    const record = this.completionRecorder(tenantId, runId);
    return (event, context) => record(attributeCompletion(event, { runId, ...context }));
  }

  private stageExecutor(workspace: Workspace, project: string | undefined, runId: string, options?: Pick<ResearchRuntimeOptions, "allowHumanInput" | "continuation">): AdvisoryStageExecutor | undefined {
    const runtimeOptions = {
      ...options,
      deadlineMs: this.stageDeadlineMs,
      onCompletion: this.completionRecorder(workspace.tenantId, runId),
      onTiming: (event: Parameters<NonNullable<ResearchRuntimeOptions["onTiming"]>>[0]) => this.logger?.info("stage runtime timing", event),
    };
    if (this.stageExecutorFactory) return this.stageExecutorFactory(workspace, project, runId, runtimeOptions);
    if (!this.researchArtifacts || !project) return undefined;
    return new ResearchRuntime({
      backend: this.backend, workspace, store: this.researchArtifacts, project, runId,
      ...runtimeOptions,
      beforeCall: () => this.quota.checkCost(workspace.tenantId),
    });
  }

  /** Resolve the project binding persisted on an async run, tenant-scoped. */
  async projectContextForRun(
    runId: string,
    ctx: EmbeddedContext,
  ): Promise<
    (Pick<CoordinatorRequest, "project" | "projectContext"> & { createdAt: number }) | undefined
  > {
    const run = await this.runStateStore.get(runId);
    if (!run || run.tenantId !== ctx.auth.tenantId) {
      return undefined;
    }
    const params = decodeRunParams(run.params);
    return {
      project: params.project,
      projectContext: params.projectContext,
      createdAt: run.createdAt,
    };
  }

  /**
   * Whether this run's roster reaches only the tracking tree.
   *
   * Resolved from the roster the SERVER seeds for the requested profile, so the
   * only caller influence is the profile NAME, which selects among rosters the
   * operator's own deployed cast defines — a caller cannot name a roster into
   * existence, and an unknown name falls back to `default`. A resolution failure
   * returns `false`, which holds.
   */
  private resolveAdvisoryOnly(request: CoordinatorRequest): boolean {
    try {
      return isAdvisoryOnly(resolveProfile(request.profile, defaultProfileTables()).roles);
    } catch {
      return false;
    }
  }

  private decrementHeld(tenantId: string): void {
    const current = this.heldCounts.get(tenantId) ?? 0;
    if (current <= 1) {
      this.heldCounts.delete(tenantId);
    } else {
      this.heldCounts.set(tenantId, current - 1);
    }
  }

  /**
   * Execute one hero-tool call server-side. Routing/scope/gate decisions are made
   * before any model call; on a hold or a quota denial NO backend call is made.
   *
   * `request.discovery` is deliberately not read here. The discovery gate
   * interviews a human one question at a time, and this path has nobody to ask —
   * so per `squad-discovery-gate.instructions.md` (*Unattended Runs*) no offer is
   * made, an explicit depth is ignored rather than honored, and the caller's
   * payload becomes the intake gate's input instead. An unattended run is gated by
   * validation, not by ideation.
   */
  async handle(
    tool: CatalogTool,
    request: CoordinatorRequest,
    ctx: EmbeddedContext,
  ): Promise<EmbeddedResult> {
    if (this.researchArtifacts && !tool.gates && ["squad_research", "squad_review"].includes(tool.id)) {
      return this.handleAdvisory(tool, request, ctx);
    }
    const matchedRouting = toMatchedRouting(tool);
    const tenantId = ctx.auth.tenantId;
    if (request.discovery) {
      this.logger?.info("discovery_ignored_unattended", {
        toolId: tool.id,
        requested: request.discovery,
      });
    }

    // SEC-9 / COST-1 / COST-2 — admit under quota before any work.
    const admit = this.quota.acquire(tenantId);
    if (!admit.ok) {
      return {
        kind: "embedded",
        outcome: "denied",
        matchedRouting,
        reason: admit.reason,
      };
    }

    try {
      // SEC-6 / SEC-7 / PROD-5 — a gated/destructive tool holds; never auto-releases.
      const gate = this.gates.classify({
        tool,
        mode: request.mode,
        advisoryOnly: this.resolveAdvisoryOnly(request),
      });
      if (gate.kind === "hold") {
        const run = await this.runStateStore.create({ tenantId, toolId: tool.id });
        await this.runStateStore.update(run.runId, { status: "held", holdReason: gate.reason });
        return {
          kind: "embedded",
          outcome: "held",
          matchedRouting,
          approvalRequest: gate.approvalRequest,
          reason: gate.reason,
          runId: run.runId,
        };
      }

      // Thin slice: only the hero roles are embedded. Other roles stay delegated-only.
      const charter = charterForRole(tool.role);
      if (!charter) {
        return {
          kind: "embedded",
          outcome: "denied",
          matchedRouting,
          reason: "role_not_embedded_in_thin_slice",
        };
      }

      const run = await this.runStateStore.create({ tenantId, toolId: tool.id });
      // SEC-4 — server-allocated, per-tenant, isolated workspace with guaranteed teardown.
      const workspace = await this.workspaceManager.allocate(tenantId);
      try {
        // Auto-memory: prior state/decisions join the caller's context as DATA.
        const { request: framed, project } = await this.withMemory(tenantId, request);
        // SEC-5 — caller text becomes delimited DATA; the charter is the only authority.
        const prompt = composeEmbeddedPrompt({
          systemAuthority: charter,
          request: framed.request,
          context: framed.context,
        });
        const observeCompletion = this.completionObserver(tenantId, run.runId);

        // Single server-side dispatch (SEC-7: inference + contained file I/O only).
        const completion = await completeWithObserver(
          this.backend,
          {
            system: prompt.system,
            messages: prompt.messages,
          },
          (event) => observeCompletion(
            event,
            { stage: tool.role, actor: tool.role },
          ),
        );

        // Write the artifact INSIDE the isolated workspace, then read it back.
        const artifactPath = workspace.resolve("artifact.md");
        await writeFile(artifactPath, completion.text, "utf8");
        const artifact = await readFile(artifactPath, "utf8");

        await this.runStateStore.update(run.runId, { status: "complete" });
        await this.recordMemory(tenantId, project, { toolId: tool.id, runId: run.runId, artifact });

        const result: EmbeddedResult = {
          kind: "embedded",
          outcome: "completed",
          matchedRouting,
          artifact,
          workspaceRoot: workspace.root,
          runId: run.runId,
          backendId: completion.backendId,
          usage: completion.usage,
        };
        return result;
      } catch (error) {
        const localFailure = await this.localPreflightResult(error, run.runId, matchedRouting);
        if (localFailure) return localFailure;
        await this.runStateStore.update(run.runId, { status: "failed" });
        throw error;
      } finally {
        // SEC-4 — teardown runs even on error/timeout.
        await workspace.dispose();
      }
    } finally {
      // SEC-9 — always free the concurrency slot.
      admit.release();
    }
  }

  /**
   * Execute one ADVISORY tool (`squad_plan` / `squad_architect`) server-side as a
   * SINGLE-STAGE advisory dispatch through the advisory orchestrator (Phase 5).
   *
   * Unlike {@link handle} (which is bound to the two deterministic hero charters
   * via `charterForRole`), this resolves the tool's role persona from the deployed
   * cast (single-source invariant) and runs exactly one advisory stage via
   * {@link runAdvisoryPipeline}. Advisory work lands NO impactful action, so — like
   * the hero tools — it makes a single synchronous dispatch and never holds. All
   * the same contained-execution guarantees apply: quota admission (SEC-9 / COST),
   * a server-allocated per-tenant workspace with guaranteed teardown (SEC-4), and
   * SEC-5 (the persona charter is the ONLY authority; caller input is DATA — the
   * advisory orchestrator composes the prompt the same way `handle` does).
   *
   * `personaRoots` is an optional override used by tests for deterministic persona
   * resolution; production passes none and uses the resolved cast.
   */
  async handleAdvisory(
    tool: CatalogTool,
    request: CoordinatorRequest,
    ctx: EmbeddedContext,
    personaRoots?: string[],
  ): Promise<EmbeddedResult> {
    const matchedRouting = toMatchedRouting(tool);
    const tenantId = ctx.auth.tenantId;

    // SEC-9 / COST-1 / COST-2 — admit under quota before any work.
    const admit = this.quota.acquire(tenantId);
    if (!admit.ok) {
      return { kind: "embedded", outcome: "denied", matchedRouting, reason: admit.reason };
    }

    try {
      // Resolve the tool's role persona from the deployed cast (real `*.agent.md`
      // bytes; the hero paraphrase fallback covers only the 2 hero agents). An
      // unresolvable role is denied — never a silent wrong persona.
      const persona = resolvePersonaForRole(tool.role, personaRoots);
      if (!persona) {
        return { kind: "embedded", outcome: "denied", matchedRouting, reason: "role_not_resolvable" };
      }

      const run = await this.runStateStore.create({ tenantId, toolId: tool.id });
      // SEC-4 — server-allocated, per-tenant, isolated workspace with guaranteed teardown.
      const workspace = await this.workspaceManager.allocate(tenantId);
      try {
        // Single-stage advisory dispatch: one persona stage, no council/backlog.
        const plan: AdvisoryStagePlan[] = [{ kind: "persona", role: persona.role, persona }];
        const { request: framed, project } = await this.withMemory(tenantId, request);
        const result = await runAdvisoryPipeline(
          framed,
          {
            backend: this.backend,
            ledger: this.ledgerSink(tenantId, project, framed, run.runId),
            stageExecutor: this.stageExecutor(workspace, project, run.runId),
            onCompletion: this.completionObserver(tenantId, run.runId),
          },
          { plan },
        );

        // Write the artifact INSIDE the isolated workspace, then read it back.
        const artifactPath = workspace.resolve("artifact.md");
        await writeFile(artifactPath, result.artifact, "utf8");
        const artifact = await readFile(artifactPath, "utf8");

        if (result.outcome === "halted" && result.reason !== "council_stop") {
          await this.runStateStore.update(run.runId, { status: "failed", artifact, failureReason: result.reason });
          return { kind: "embedded", outcome: "denied", matchedRouting, artifact, reason: result.reason, runId: run.runId };
        }
        await this.runStateStore.update(run.runId, { status: "complete", artifact });
        await this.recordMemory(tenantId, project, { toolId: tool.id, runId: run.runId, artifact });

        return {
          kind: "embedded",
          outcome: "completed",
          matchedRouting,
          artifact,
          workspaceRoot: workspace.root,
          runId: run.runId,
          backendId: result.stages.at(-1)?.backendId,
          usage: aggregateBackendUsage(result.usage),
        };
      } catch (error) {
        const localFailure = await this.localPreflightResult(error, run.runId, matchedRouting);
        if (localFailure) return localFailure;
        await this.runStateStore.update(run.runId, { status: "failed" });
        throw error;
      } finally {
        // SEC-4 — teardown runs even on error/timeout.
        await workspace.dispose();
      }
    } finally {
      // SEC-9 — always free the concurrency slot.
      admit.release();
    }
  }

  /**
   * Execute one BUSINESS tool (`squad_business_plan` / `squad_backlog`) as a
   * single-stage embedded advisory dispatch.
   *
   * Persona composition: the deployed cast persona (real `*.agent.md` bytes) is the
   * DOMAIN authority and the tool spec's charter is appended as the OUTPUT
   * contract. Appending rather than replacing keeps the single-source invariant
   * (the cast still defines how the role thinks) while making the result shape
   * deterministic enough for a Copilot Studio agent to consume — which is the whole
   * point of the business surface. When the cast is absent, the spec charter alone
   * is the fallback, exactly like the hero roles.
   *
   * Advisory posture is identical to {@link handleAdvisory}: quota admission
   * (SEC-9 / COST), a per-tenant ephemeral workspace with guaranteed teardown
   * (SEC-4), caller text as delimited DATA (SEC-5), no gate, and no impactful
   * action. Auto-memory continuity applies here too when it is wired.
   */
  async handleBusiness(
    spec: BusinessToolSpec,
    request: CoordinatorRequest,
    ctx: EmbeddedContext,
    personaRoots?: string[],
  ): Promise<EmbeddedResult> {
    const matchedRouting: MatchedRouting = {
      routingIntent: spec.toolId,
      role: spec.role,
      tier: "auto",
      parallelEligible: false,
      council: [],
      catchAll: false,
      gates: false,
    };
    const tenantId = ctx.auth.tenantId;

    const admit = this.quota.acquire(tenantId);
    if (!admit.ok) {
      return { kind: "embedded", outcome: "denied", matchedRouting, reason: admit.reason };
    }

    try {
      const deployed = resolvePersonaForRole(spec.role, personaRoots);
      const persona: PersonaRecord = {
        role: spec.role,
        applyTo: deployed?.applyTo ?? [],
        agents: deployed?.agents,
        tools: deployed?.tools,
        charter: deployed?.charter ? `${deployed.charter}\n\n${spec.charter}` : spec.charter,
      };

      const run = await this.runStateStore.create({ tenantId, toolId: spec.toolId });
      const workspace = await this.workspaceManager.allocate(tenantId);
      try {
        const { request: framed, project } = await this.withMemory(tenantId, request);
        const result = await runAdvisoryPipeline(
          framed,
          {
            backend: this.backend,
            ledger: this.ledgerSink(tenantId, project, framed, run.runId),
            stageExecutor: this.stageExecutor(workspace, project, run.runId),
            onCompletion: this.completionObserver(tenantId, run.runId),
          },
          { plan: [{ kind: "persona", role: persona.role, persona }] },
        );

        const artifactPath = workspace.resolve("artifact.md");
        await writeFile(artifactPath, result.artifact, "utf8");
        const artifact = await readFile(artifactPath, "utf8");

        if (result.outcome === "halted" && result.reason !== "council_stop") {
          await this.runStateStore.update(run.runId, { status: "failed", artifact, failureReason: result.reason });
          return { kind: "embedded", outcome: "denied", matchedRouting, artifact, reason: result.reason, runId: run.runId };
        }
        await this.runStateStore.update(run.runId, { status: "complete", artifact });
        await this.recordMemory(tenantId, project, {
          toolId: spec.toolId,
          runId: run.runId,
          artifact,
        });

        return {
          kind: "embedded",
          outcome: "completed",
          matchedRouting,
          artifact,
          workspaceRoot: workspace.root,
          runId: run.runId,
          backendId: result.stages.at(-1)?.backendId,
          usage: aggregateBackendUsage(result.usage),
        };
      } catch (error) {
        const localFailure = await this.localPreflightResult(error, run.runId, matchedRouting);
        if (localFailure) return localFailure;
        await this.runStateStore.update(run.runId, { status: "failed" });
        throw error;
      } finally {
        await workspace.dispose();
      }
    } finally {
      admit.release();
    }
  }

  /**
   * Execute the spike catch-all pipeline (Squad Researcher -> Squad Reviewer) as a
   * sequential in-process dispatch loop, inside one server-allocated ephemeral
   * workspace with guaranteed teardown (SEC-4). Personas are resolved from disk
   * (single-source invariant) with the paraphrase fallback. This is the pipeline
   * primitive the async run + gate-resume paths (Phases 3-4) drive; it does not
   * itself acquire a quota slot (the caller owns admit/gate ordering).
   *
   * `personaRoots` is an optional override used by tests for deterministic
   * persona resolution; production passes none and uses the resolved cast.
   */
  async executePipeline(
    tool: CatalogTool,
    request: CoordinatorRequest,
    ctx: EmbeddedContext,
    personaRoots?: string[],
  ): Promise<EmbeddedResult> {
    const matchedRouting = toMatchedRouting(tool);
    const tenantId = ctx.auth.tenantId;
    const run = await this.runStateStore.create({ tenantId, toolId: tool.id });
    const core = await this.runPipelineCore(tenantId, run.runId, request, personaRoots);
    if (core.outcome === "denied") {
      await this.runStateStore.update(run.runId, { status: "failed" });
      return { kind: "embedded", outcome: "denied", matchedRouting, reason: core.reason };
    }
    await this.runStateStore.update(run.runId, { status: "complete", artifact: core.artifact });
    return {
      kind: "embedded",
      outcome: "completed",
      matchedRouting,
      artifact: core.artifact,
      workspaceRoot: core.workspaceRoot,
      runId: run.runId,
      backendId: core.backendId,
      usage: core.usage,
    };
  }

  /**
   * Async run start (KD-5 / KD-6): persist a durable "running" record and return
   * the run id IMMEDIATELY, without awaiting the pipeline. The caller polls
   * {@link getRunStatus} and drives the work via {@link runToCompletion}. Returning
   * the id first is what lets a minutes-long run clear the 240s ingress ceiling.
   */
  startRun(tool: CatalogTool, ctx: EmbeddedContext): Promise<{ runId: string }> {
    return this.runStateStore
      .create({ tenantId: ctx.auth.tenantId, toolId: tool.id })
      .then((run) => ({ runId: run.runId }));
  }

  /**
   * Execute a previously-started run to completion and persist the artifact to the
   * durable store. Enforces tenant ownership: a run id owned by another tenant is
   * denied (no cross-tenant execution). Survives a cold start when the store is
   * durable (the run is re-resolved by id).
   */
  async runToCompletion(
    runId: string,
    request: CoordinatorRequest,
    ctx: EmbeddedContext,
    personaRoots?: string[],
  ): Promise<EmbeddedResult> {
    const run = await this.runStateStore.get(runId);
    if (!run || run.tenantId !== ctx.auth.tenantId) {
      return {
        kind: "embedded",
        outcome: "denied",
        matchedRouting: EMPTY_ROUTING,
        reason: "run_not_found_or_cross_tenant",
        runId,
      };
    }
    if (run.humanInput || run.advisoryCheckpoint) return this.pollRun(runId, ctx);
    const core = await this.runPipelineCore(run.tenantId, runId, request, personaRoots);
    if (core.outcome === "denied") {
      await this.runStateStore.update(runId, { status: "failed" });
      return { kind: "embedded", outcome: "denied", matchedRouting: EMPTY_ROUTING, reason: core.reason, runId };
    }
    await this.runStateStore.update(runId, { status: "complete", artifact: core.artifact });
    return {
      kind: "embedded",
      outcome: "completed",
      matchedRouting: EMPTY_ROUTING,
      artifact: core.artifact,
      workspaceRoot: core.workspaceRoot,
      runId,
      backendId: core.backendId,
      usage: core.usage,
    };
  }

  /**
   * Poll a run's status and (when complete) its artifact, scoped to the caller's
   * tenant. A run id owned by another tenant returns `undefined` (no leakage);
   * combined with the unguessable, path-validated run id (durable store), this is
   * the tenant-isolation boundary for the async poll.
   */
  async getRunStatus(
    runId: string,
    ctx: EmbeddedContext,
  ): Promise<{ status: RunStatus; artifact?: string } | undefined> {
    const run = await this.runStateStore.get(runId);
    if (!run || run.tenantId !== ctx.auth.tenantId) {
      return undefined;
    }
    return { status: run.status, artifact: run.artifact };
  }

  /**
   * Gate carry-through across the async boundary (PROD-5 / SEC-6). A HELD run
   * resumes ONLY when an operator has approved its run id out-of-band through the
   * approval channel; there is no code path here that releases a hold from caller
   * `request`/`context` or model output. When the run is not yet approved this
   * returns the run STILL held and makes NO model call (no auto-release). The held
   * record is durable, so a hold survives a scale-to-zero cold start; approval is
   * checked again on the next resume call.
   */
  async resumeRun(
    runId: string,
    request: CoordinatorRequest,
    ctx: EmbeddedContext,
    personaRoots?: string[],
  ): Promise<EmbeddedResult> {
    const run = await this.runStateStore.get(runId);
    if (!run || run.tenantId !== ctx.auth.tenantId) {
      return {
        kind: "embedded",
        outcome: "denied",
        matchedRouting: EMPTY_ROUTING,
        reason: "run_not_found_or_cross_tenant",
        runId,
      };
    }

    if (run.humanInput || run.advisoryCheckpoint) return this.pollRun(runId, ctx);
    // The ONLY release path: an explicit, out-of-band operator approval keyed on
    // the run id. Never derived from caller input or model output (SEC-6).
    if (!(await this.approvals.isApproved(runId))) {
      return {
        kind: "embedded",
        outcome: "held",
        matchedRouting: EMPTY_ROUTING,
        reason: run.holdReason ?? "awaiting human approval",
        approvalRequest:
          "This run is paused for human approval and will not proceed until an " +
          "operator submits explicit human approval through squad_approve (Squad.Operate) " +
          "or /admin/approve. Then poll the same run. The squad never auto-releases a gate.",
        runId,
        backendId: run.completionUsage?.at(-1)?.backendId,
        usage: usageFromCompletionRecords(run.completionUsage),
      };
    }

    // Approved: transition held -> running and execute the pipeline to completion.
    await this.runStateStore.update(runId, { status: "running" });
    const core = await this.runPipelineCore(run.tenantId, runId, request, personaRoots);
    if (core.outcome === "denied") {
      await this.runStateStore.update(runId, { status: "failed" });
      return { kind: "embedded", outcome: "denied", matchedRouting: EMPTY_ROUTING, reason: core.reason, runId };
    }
    await this.runStateStore.update(runId, { status: "complete", artifact: core.artifact });
    return {
      kind: "embedded",
      outcome: "completed",
      matchedRouting: EMPTY_ROUTING,
      artifact: core.artifact,
      workspaceRoot: core.workspaceRoot,
      runId,
      backendId: core.backendId,
      usage: core.usage,
    };
  }

  /**
   * Start an async run over the remote (HTTP) boundary. Admits under quota,
   * classifies the gate, and persists a DURABLE run carrying the caller request so
   * a later status poll can drive it to completion. A gated run waits for explicit
   * operator approval. A run admitted by server policy (including opted-in
   * advisory autopilot) is queued without requiring an approval. Neither branch
   * calls the model here or holds a concurrency slot.
   */
  async startHttpRun(
    tool: CatalogTool,
    request: CoordinatorRequest,
    ctx: EmbeddedContext,
  ): Promise<EmbeddedResult> {
    const matchedRouting = toMatchedRouting(tool);
    const tenantId = ctx.auth.tenantId;

    const admit = this.quota.acquire(tenantId);
    if (!admit.ok) {
      return { kind: "embedded", outcome: "denied", matchedRouting, reason: admit.reason };
    }
    try {
      const gate = this.gates.classify({
        tool,
        mode: request.mode,
        advisoryOnly: this.resolveAdvisoryOnly(request),
      });
      if (gate.kind === "hold") {
        // MEDIUM-2: cap outstanding held runs per tenant (held runs release the
        // concurrency slot, so neither SEC-9 nor COST-2 throttles their creation).
        const held = this.heldCounts.get(tenantId) ?? 0;
        if (held >= this.maxHeldRunsPerTenant) {
          return { kind: "embedded", outcome: "denied", matchedRouting, reason: "held_run_cap" };
        }
        const run = await this.runStateStore.create({ tenantId, toolId: tool.id, ttlMs: this.runTtlMs });
        await this.runStateStore.update(run.runId, {
          status: "held",
          holdReason: gate.reason,
          request: request.request,
          context: request.context,
          params: encodeRunParams(request),
        });
        this.heldCounts.set(tenantId, held + 1);
        return {
          kind: "embedded",
          outcome: "held",
          matchedRouting,
          approvalRequest: gate.approvalRequest,
          reason: gate.reason,
          runId: run.runId,
        };
      }
      // Non-gated remote tool: persist running; execution driven by the poll.
      const run = await this.runStateStore.create({ tenantId, toolId: tool.id, ttlMs: this.runTtlMs });
      await this.runStateStore.update(run.runId, {
        status: "running",
        request: request.request,
        context: request.context,
        params: encodeRunParams(request),
      });
      return {
        kind: "embedded",
        outcome: "held",
        matchedRouting,
        reason: "queued",
        runId: run.runId,
      };
    } finally {
      // A held/queued run is not an in-flight dispatch; free the slot immediately.
      admit.release();
    }
  }

  /**
   * Poll a run over the remote boundary (tenant-scoped). A completed run returns
   * its stored artifact; failed is denied; an unknown or cross-tenant run id is
   * denied (no leakage). A held-but-unapproved run stays held (never auto-release).
   *
   * For an approved hold or a running queue entry, behavior depends on `driveOnPoll`:
   *   * `driveOnPoll` true (single-replica default) — the poll DRIVES execution:
   *     it CAS-claims held/running(lease-expired) -> running (so exactly one poll
   *     or replica drives; MEDIUM-1 across replicas via WI-06 CAS), runs the
   *     pipeline under quota using the persisted request, and returns the artifact.
   *   * `driveOnPoll` false (worker deployment) — the poll is READ-ONLY: it reports
   *     the run as still running and a background ACA Job drives it off the request
   *     path, so a run may exceed the 240s ingress ceiling (WI-1b4-WORKER).
   */
  async pollRun(runId: string, ctx: EmbeddedContext): Promise<EmbeddedResult> {
    const run = await this.runStateStore.get(runId);
    if (!run || run.tenantId !== ctx.auth.tenantId) {
      return {
        kind: "embedded",
        outcome: "denied",
        matchedRouting: EMPTY_ROUTING,
        reason: "run_not_found_or_cross_tenant",
        runId,
      };
    }
    if (run.status === "complete") {
      return {
        kind: "embedded",
        outcome: "completed",
        matchedRouting: EMPTY_ROUTING,
        artifact: run.artifact,
        runId,
        backendId: run.completionUsage?.at(-1)?.backendId,
        usage: usageFromCompletionRecords(run.completionUsage),
      };
    }
    if (run.status === "failed") {
      return {
        kind: "embedded",
        outcome: "denied",
        matchedRouting: EMPTY_ROUTING,
        reason: run.failureReason ?? "run_failed",
        artifact: run.artifact,
        runId,
        backendId: run.completionUsage?.at(-1)?.backendId,
        usage: usageFromCompletionRecords(run.completionUsage),
        ...(run.responsibleAi ? { responsibleAi: run.responsibleAi } : {}),
        ...(run.modelFailure ? { modelFailure: readModelFailure(run.modelFailure) } : {}),
      };
    }
    if (run.humanInput && !run.humanInput.response) return this.awaitingInput(run);
    // A queued running record has already passed server gate classification.
    // Only an actual held record requires an operator's approval.
    if (run.status === "held" && !(await this.approvals.isApproved(runId))) {
      return {
        kind: "embedded",
        outcome: "held",
        matchedRouting: EMPTY_ROUTING,
        reason: run.holdReason ?? "awaiting human approval",
        approvalRequest:
          "This run is paused for human approval and will not proceed until an " +
          "operator submits explicit human approval through squad_approve (Squad.Operate) " +
          "or /admin/approve. Then poll the same run. The squad never auto-releases a gate.",
        runId,
      };
    }

    // Worker mode: the poll never executes; the ACA Job drives approved runs.
    if (!this.driveOnPoll) {
      return {
        kind: "embedded",
        outcome: "held",
        matchedRouting: EMPTY_ROUTING,
        reason: run.leaseExpiresAt !== undefined && run.leaseExpiresAt > Date.now()
          ? "run_already_in_flight" : "queued_for_worker",
        runId,
        backendId: run.completionUsage?.at(-1)?.backendId,
        usage: usageFromCompletionRecords(run.completionUsage),
      };
    }

    if (this.backgroundRuns.has(runId)) return this.inFlight(run);

    // Acquire a concurrency slot, then CAS-claim the run. The claim replaces the
    // in-process in-flight guard with a cross-replica compare-and-swap: exactly one
    // poll/replica wins held/running(lease-expired) -> running; a lost claim is
    // deferred (another is already driving it).
    const admit = this.quota.acquire(run.tenantId);
    if (!admit.ok) {
      return { kind: "embedded", outcome: "denied", matchedRouting: EMPTY_ROUTING, reason: admit.reason, runId };
    }
    const claimed = await this.runStateStore.claim(runId, ["held", "running"], "running", { leaseMs: this.leaseMs });
    if (!claimed) {
      admit.release();
      return this.inFlight(run);
    }
    if (this.pollDriveWaitMs === undefined) {
      try {
        return await this.executeRunningRun(claimed);
      } finally {
        admit.release();
      }
    }

    const drive = this.executeRunningRun(claimed).finally(() => {
      admit.release();
      this.backgroundRuns.delete(runId);
    });
    this.backgroundRuns.set(runId, drive);
    // Execution already persisted the failure; this only keeps a late rejection observed.
    drive.catch((error: unknown) => this.logger?.error("background run failed", { runId, error: String(error) }));
    let timer: NodeJS.Timeout | undefined;
    const waited = await Promise.race([
      drive.then((result) => ({ done: true as const, result })),
      new Promise<{ done: false }>((resolve) => { timer = setTimeout(() => resolve({ done: false }), this.pollDriveWaitMs); }),
    ]).finally(() => clearTimeout(timer));
    if (waited.done) return waited.result;
    return this.inFlight((await this.runStateStore.get(runId)) ?? claimed);
  }

  private inFlight(run: RunState): EmbeddedResult {
    return {
      kind: "embedded",
      outcome: "held",
      matchedRouting: EMPTY_ROUTING,
      reason: "run_already_in_flight",
      runId: run.runId,
      backendId: run.completionUsage?.at(-1)?.backendId,
      usage: usageFromCompletionRecords(run.completionUsage),
    };
  }

  /**
   * Drive a run that is ALREADY claimed (status `running`, lease held by the
   * caller) to completion: run the pipeline under the persisted request, persist
   * the artifact, and decrement the held-run count. Shared by the poll-drives path
   * and the background worker so both produce identical results. Assumes the CAS
   * claim already succeeded — it does not re-check approval (the claim path did).
   *
   * The catch-all `squad_run` runs the FULL advisory pipeline (Phase 5): routing
   * -> research -> plan -> [council] -> review -> backlog-handoff, persisting each
   * stage + the council verdict durably (so a status poll recompiles the finished
   * artifact multi-replica / after a cold start). Any other tool id keeps the
   * spike two-stage pipeline. Both persist the compiled artifact + `complete`.
   */
  private async executeRunningRun(run: RunState): Promise<EmbeddedResult> {
    if (run.toolId === "squad_run") {
      return this.executeAdvisoryRun(run);
    }
    if (run.toolId === FEDERATION_TOOL_ID) {
      return this.executeFederationRun(run);
    }
    const req: CoordinatorRequest = coordinatorRequestFromRun(run);
    const core = await this.runPipelineCore(run.tenantId, run.runId, req);
    if (core.outcome === "denied") {
      await this.runStateStore.update(run.runId, { status: "failed" });
      this.decrementHeld(run.tenantId);
      return { kind: "embedded", outcome: "denied", matchedRouting: EMPTY_ROUTING, reason: core.reason, runId: run.runId };
    }
    await this.runStateStore.update(run.runId, { status: "complete", artifact: core.artifact });
    this.decrementHeld(run.tenantId);
    return {
      kind: "embedded",
      outcome: "completed",
      matchedRouting: EMPTY_ROUTING,
      artifact: core.artifact,
      workspaceRoot: core.workspaceRoot,
      runId: run.runId,
      backendId: core.backendId,
      usage: core.usage,
    };
  }

  /**
   * Drive an approved/claimed `squad_run` through the FULL advisory pipeline
   * (Phase 5). The advisory orchestrator routes the persisted request across the
   * full cast (research -> plan -> [council] -> review -> backlog-handoff) as
   * sequential model completions, threading each stage's artifact forward as DATA
   * (SEC-5 preserved by the orchestrator). It runs in autopilot so the async drive
   * yields ONE compiled artifact. Any required human gate was applied at
   * {@link startHttpRun} and must be approved before the claim; server-admitted
   * advisory runs have no such hold. No additional final hold is injected here.
   *
   * Per-stage artifacts + the council verdict + a history list persist durably
   * through {@link StoreAdvisoryPersistence} so a status poll recompiles the
   * finished artifact multi-replica and after a cold start; the compiled artifact
   * is also stored on the run so `squad_status` returns it directly. A council
   * `Stop` verdict halts the pipeline and the run completes with the Stop artifact
   * (there is no implement stage to gate in advisory scope). All work happens
   * inside a server-allocated per-tenant workspace with guaranteed teardown (SEC-4).
   */
  private async executeAdvisoryRun(run: RunState, plan?: AdvisoryStagePlan[]): Promise<EmbeddedResult> {
    const req: CoordinatorRequest = coordinatorRequestFromRun(run);
    const matchedRouting = run.toolId === FEDERATION_TOOL_ID ? FEDERATION_ROUTING : EMPTY_ROUTING;
    const workspace = await this.workspaceManager.allocate(run.tenantId);
    try {
      const persistence = new StoreAdvisoryPersistence(this.runStateStore, run.runId);
      const recalled = await this.withMemory(run.tenantId, req);
      const checkpoint = run.advisoryCheckpoint ? readAdvisoryCheckpoint(run.advisoryCheckpoint) : undefined;
      const framed = checkpoint?.request ?? recalled.request;
      const project = recalled.project;
      if (checkpoint && (!run.humanInput?.response || checkpoint.stage.questionId !== run.humanInput.questionId)) {
        throw new Error("Cannot resume advisory stage without its matching persisted human response.");
      }
      // Gate classification and any required approval precede this execution.
      const result = await runAdvisoryPipeline(
        framed,
        {
          backend: this.backend,
          persistence,
          ledger: this.ledgerSink(run.tenantId, project, framed, run.runId),
          stageExecutor: this.stageExecutor(workspace, project, run.runId, {
            allowHumanInput: true,
            continuation: checkpoint && run.humanInput?.response
              ? { checkpoint: checkpoint.stage, response: run.humanInput.response } : undefined,
          }),
          onCompletion: this.completionObserver(run.tenantId, run.runId),
        },
        { mode: "autopilot", plan, resume: checkpoint?.resume },
      );

      if (result.humanInput && result.checkpoint && result.resume) {
        try {
          const saved = await this.runStateStore.update(run.runId, {
            status: "held", holdReason: "awaiting human input", humanInput: result.humanInput,
            advisoryCheckpoint: encodeAdvisoryCheckpoint({ version: 1, request: framed, resume: result.resume, stage: result.checkpoint }),
            artifact: result.artifact, leaseExpiresAt: undefined,
          });
          if (!saved) throw new Error("Human handoff checkpoint was not persisted.");
          const verified = await this.runStateStore.get(run.runId);
          if (!verified || verified.humanInput?.questionId !== result.humanInput.questionId ||
              verified.advisoryCheckpoint !== saved.advisoryCheckpoint || verified.status !== "held") {
            throw new Error("Human handoff read-back failed.");
          }
          return this.awaitingInput(verified);
        } catch (error) {
          throw new AdvisoryCheckpointPersistenceError(error);
        }
      }
      if (result.outcome === "halted" && result.reason !== "council_stop") {
        if (!await this.runStateStore.update(run.runId, { status: "failed", artifact: result.artifact, failureReason: result.reason })) {
          throw new Error("Failed-stage result was not persisted.");
        }
        this.decrementHeld(run.tenantId);
        return {
          kind: "embedded", outcome: "denied", matchedRouting,
          reason: result.reason, artifact: result.artifact, runId: run.runId,
        };
      }
      // `completed` and a council `Stop` `halted` are both terminal-with-artifact;
      // persist the compiled artifact so the status poll returns it directly.
      const completedRun = await this.runStateStore.update(run.runId, {
        status: "complete",
        artifact: result.artifact,
        advisoryCheckpoint: undefined,
      });
      if (!completedRun) {
        throw new Error("Completed advisory result was not persisted.");
      }
      await this.recordMemory(run.tenantId, project, {
        toolId: run.toolId,
        runId: run.runId,
        artifact: result.artifact,
      });
      this.decrementHeld(run.tenantId);
      return {
        kind: "embedded",
        outcome: "completed",
        matchedRouting,
        artifact: result.artifact,
        workspaceRoot: workspace.root,
        runId: run.runId,
        backendId: completedRun.completionUsage?.at(-1)?.backendId ??
          result.stages.at(-1)?.backendId,
        usage: usageFromCompletionRecords(completedRun.completionUsage) ??
          aggregateBackendUsage(result.usage),
      };
    } catch (error) {
      const cause = error instanceof AdvisoryStageFailure ? error.cause : error;
      const responsibleAi = cause instanceof ModelBackendError && cause.kind === "content_policy"
        ? responsibleAiBlocker(cause, error instanceof AdvisoryStageFailure ? error.failedStage : "unknown", run.runId)
        : undefined;
      const modelFailure = cause instanceof ModelBackendError
        ? modelFailureDiagnostics(cause, error instanceof AdvisoryStageFailure ? error.failedStage : "unknown", run.runId)
        : undefined;
      if (error instanceof AdvisoryStageFailure) error.runId = run.runId;
      if (modelFailure) this.logger?.error("Advisory model failure", { runId: run.runId, modelFailure });
      await this.runStateStore.update(run.runId, {
        status: "failed",
        ...(responsibleAi ? { responsibleAi } : {}),
        ...(modelFailure ? { modelFailure } : {}),
        ...(error instanceof AdvisoryStageFailure
          ? { failureReason: error.reason, artifact: error.artifact }
          : error instanceof AdvisoryCheckpointPersistenceError
            ? { failureReason: "checkpoint_persistence_failed" }
            : { failureReason: responsibleAi ? "model_backend_content_policy" : modelFailure ? `model_backend_${modelFailure.kind}` : "advisory_run_failed" }),
      });
      this.decrementHeld(run.tenantId);
      throw error;
    } finally {
      // SEC-4 — teardown runs even on error/timeout.
      await workspace.dispose();
    }

  }

  private awaitingInput(run: RunState): EmbeddedResult {
    if (!run.humanInput) throw new Error("Missing human input request.");
    const { response: _response, ...humanInput } = run.humanInput;
    return {
      kind: "embedded", outcome: "held", matchedRouting: EMPTY_ROUTING,
      reason: "awaiting human input", humanInput, runId: run.runId, artifact: run.artifact,
      backendId: run.completionUsage?.at(-1)?.backendId,
      usage: usageFromCompletionRecords(run.completionUsage),
      expiresAt: run.expiresAt,
    };
  }

  async respondToHumanInput(
    runId: string, questionId: string, answer: string, ctx: EmbeddedContext, binding?: { projectId?: string },
  ): Promise<{ accepted: boolean; runId: string; questionId: string; reason?: string; respondedBy?: string; respondedAt?: number }> {
    const denied = (reason: string) => ({ accepted: false, runId, questionId, reason });
    if (!answer.trim() || answer.length > 16_000 || !ctx.auth.subject) return denied("invalid_human_response");
    const run = await this.runStateStore.get(runId);
    if (!run || run.tenantId !== ctx.auth.tenantId) return denied("run_not_found_or_cross_tenant");
    const projectId = decodeRunParams(run.params).projectContext?.projectId;
    if (binding && projectId?.toLowerCase() !== binding.projectId?.toLowerCase()) return denied("project_identity_conflict");
    if (!run.humanInput || run.humanInput.questionId !== questionId) return denied("human_question_not_current");
    const updated = await this.runStateStore.answerInput(runId, questionId, {
      answer, respondedBy: ctx.auth.subject, respondedAt: Date.now(),
    });
    if (!updated) return denied("human_response_conflict");
    const receipt = updated.humanInput?.response;
    if (updated.humanInput?.questionId !== questionId || receipt?.answer !== answer || receipt.respondedBy !== ctx.auth.subject) {
      throw new Error("The atomic response write returned an invalid receipt.");
    }
    const verified = await this.runStateStore.get(runId);
    if (!verified || (verified.humanInput?.questionId === questionId &&
        (verified.humanInput.response?.answer !== answer || verified.humanInput.response.respondedBy !== ctx.auth.subject))) {
      throw new Error("Human response receipt read-back failed.");
    }
    return { accepted: true, runId, questionId, respondedBy: receipt.respondedBy, respondedAt: receipt.respondedAt };
  }

  /**
   * Drive an approved/claimed `squad_federate` run through the FEDERATION meta
   * layer. This is the embedded counterpart of the delegated federation path: the
   * run executes as a single Federation Coordinator advisory stage whose charter is
   * the resolved federation persona PLUS a server-composed directive derived only
   * from validated inputs (`squad` / `init` / `promote` / `mode`) — see
   * `federation.ts`. The caller's free text stays delimited DATA (SEC-5).
   *
   * The federation inputs are recovered from the run's persisted `params`, so a
   * pinned sub-squad or an init/promote turn survives the approve → poll cycle
   * instead of degrading into a plain pipeline run.
   *
   * The Human Gate already fired at {@link startHttpRun} (`squad_federate` is
   * `gates: true`), so no additional hold is injected here — identical to the
   * `squad_run` path. All work happens inside a per-tenant ephemeral workspace with
   * guaranteed teardown (SEC-4).
   */
  private async executeFederationRun(run: RunState): Promise<EmbeddedResult> {
    const req: CoordinatorRequest = coordinatorRequestFromRun(run);
    const persona = federationPersona(req, resolvePersonaForRole(FEDERATION_ROLE));
    return this.executeAdvisoryRun(run, [{ kind: "persona", role: persona.role, persona }]);
  }

  /**
   * WI-1b4-WORKER — the background-worker entry point. CAS-claim a single
   * claimable run (an approved held run, or a running run whose lease lapsed) and
   * drive it to completion under quota. Returns the result, or `undefined` when the
   * claim was lost to another worker/replica (no double-execution). The worker
   * enumerates claimable runs via the store and calls this per run id.
   */
  async driveClaimable(runId: string): Promise<EmbeddedResult | undefined> {
    const claimed = await this.runStateStore.claim(runId, ["held", "running"], "running", { leaseMs: this.leaseMs });
    if (!claimed) {
      return undefined;
    }
    const admit = this.quota.acquire(claimed.tenantId);
    if (!admit.ok) {
      // Leave the run running with its lease; it becomes reclaimable after the
      // lease lapses, so a transient quota denial does not strand it.
      return { kind: "embedded", outcome: "denied", matchedRouting: EMPTY_ROUTING, reason: admit.reason, runId };
    }
    try {
      return await this.executeRunningRun(claimed);
    } finally {
      admit.release();
    }
  }

  /** List the runs a worker may claim right now (tenant-agnostic; server-internal). */
  listClaimableRuns(now?: number): Promise<RunState[]> {
    return this.runStateStore.listClaimable(now);
  }

  /** Delete expired runs (TTL janitor); returns the count removed (worker/janitor). */
  sweepExpiredRuns(now?: number): Promise<number> {
    return this.runStateStore.sweepExpired(now);
  }

  /**
   * Release a HELD run through an explicitly authorized operator action:
   * `squad_approve` or `/admin/approve`. Ordinary request/context and model
   * output never grant approval authority. Tenant-scoped: an operator may release
   * only runs owned by their own tenant/authority; an unknown or cross-tenant run
   * id is denied with no leakage (mirrors {@link pollRun}). Records approver +
   * timestamp via the auditable channel; `approver` is the operator's token subject.
   * Idempotent — re-approving an already-approved run keeps the original record.
   */
  approveRun(
    runId: string,
    ctx: EmbeddedContext,
    binding?: { projectId?: string },
  ): Promise<{ ok: true; record: ApprovalRecord } | { ok: false; reason: string }> {
    return this.runStateStore.get(runId).then(async (run) => {
      if (!run || run.tenantId !== ctx.auth.tenantId) {
        return { ok: false as const, reason: "run_not_found_or_cross_tenant" };
      }
      const projectId = decodeRunParams(run.params).projectContext?.projectId;
      if (binding && projectId?.toLowerCase() !== binding.projectId?.toLowerCase()) {
        return { ok: false as const, reason: "project_identity_conflict" };
      }
      if (run.humanInput && !run.humanInput.response) {
        return { ok: false as const, reason: "human_input_required_not_operator_approval" };
      }
      const prior = await this.approvals.approvalRecord(runId);
      if (prior) {
        return { ok: true as const, record: prior };
      }
      if (run.status !== "held") {
        return { ok: false as const, reason: "run_not_held" };
      }
      await this.approvals.approve(runId, ctx.auth.subject);
      const record = await this.approvals.approvalRecord(runId);
      if (!record) {
        throw new Error("Approval receipt was not persisted.");
      }
      return { ok: true as const, record };
    });
  }

  /**
   * Shared pipeline core: resolve the spike stages from disk (paraphrase
   * fallback), run the sequential dispatch loop inside one server-allocated
   * ephemeral workspace with guaranteed teardown (SEC-4), record cost, and return
   * the combined artifact. Run-record lifecycle is the CALLER's concern so the
   * sync (`executePipeline`) and async (`runToCompletion`) paths share this body.
   */
  private async runPipelineCore(
    tenantId: string,
    runId: string,
    request: CoordinatorRequest,
    personaRoots?: string[],
  ): Promise<
    | { outcome: "completed"; artifact: string; workspaceRoot: string; backendId?: string; usage?: BackendUsage }
    | { outcome: "denied"; reason: string }
  > {
    const stages: PersonaRecord[] = [];
    for (const role of SPIKE_PIPELINE_ROLES) {
      const persona = resolvePersonaForRole(role, personaRoots);
      if (!persona) {
        return { outcome: "denied", reason: "role_not_embedded_in_thin_slice" };
      }
      stages.push(persona);
    }

    // SEC-4 — server-allocated, per-tenant, isolated workspace with guaranteed teardown.
    const workspace = await this.workspaceManager.allocate(tenantId);
    try {
      const pipeline = await runPipeline(stages, request, {
        backend: this.backend,
        onCompletion: this.completionObserver(tenantId, runId),
      });

      // Persist the combined artifact INSIDE the isolated workspace, then read it back.
      const artifactPath = workspace.resolve("artifact.md");
      await writeFile(artifactPath, pipeline.artifact, "utf8");
      const artifact = await readFile(artifactPath, "utf8");

      return {
        outcome: "completed",
        artifact,
        workspaceRoot: workspace.root,
        backendId: pipeline.stages.at(-1)?.backendId,
        usage: aggregateBackendUsage(pipeline.usage),
      };
    } finally {
      // SEC-4 — teardown runs even on error/timeout.
      await workspace.dispose();
    }
  }
}
