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
import { runPipeline } from "./dispatch-loop.js";
import { runAdvisoryPipeline, type AdvisoryStagePlan } from "./advisory-pipeline.js";
import { StoreAdvisoryPersistence } from "./advisory-run-store.js";
import type { PersonaRecord } from "./persona-loader.js";
import { EphemeralRunStateStore, type RunState, type RunStateStore, type RunStatus } from "./run-state.js";
import {
  GateKeeper,
  InMemoryApprovalChannel,
  TenantQuotaTracker,
  type ApprovalRecord,
  type HumanApprovalChannel,
} from "./gates.js";
import type { BackendUsage, ModelBackend } from "./model-backend.js";
import type { CatalogTool } from "../catalog/catalog.js";
import type { CoordinatorRequest, MatchedRouting } from "./coordinator-engine.js";
import type { AuthContext } from "../auth/entra.js";
import type { WorkspaceManager } from "./workspace.js";
import type { RedactingLogger } from "../observability/logger.js";

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
  /** Server-allocated workspace root used for the run (already torn down on return). */
  workspaceRoot?: string;
  /** Server-allocated run id. */
  runId?: string;
  /** The backend that produced the artifact. */
  backendId?: string;
  usage?: BackendUsage;
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
  /** WI-06 — TTL (ms) stamped on a newly created async run (default: none). */
  runTtlMs?: number;
  /** WI-06 — worker/poll claim lease (ms); a running run past its lease is reclaimable. */
  leaseMs?: number;
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
const SPIKE_PIPELINE_ROLES = ["Task Researcher", "Task Reviewer"] as const;

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
  private readonly runTtlMs?: number;
  private readonly leaseMs?: number;
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
    this.runTtlMs = deps.runTtlMs;
    this.leaseMs = deps.leaseMs;
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
   */
  async handle(
    tool: CatalogTool,
    request: CoordinatorRequest,
    ctx: EmbeddedContext,
  ): Promise<EmbeddedResult> {
    const matchedRouting = toMatchedRouting(tool);
    const tenantId = ctx.auth.tenantId;

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
      const gate = this.gates.classify({ tool, mode: request.mode });
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
        // SEC-5 — caller text becomes delimited DATA; the charter is the only authority.
        const prompt = composeEmbeddedPrompt({
          systemAuthority: charter,
          request: request.request,
          context: request.context,
        });

        // Single server-side dispatch (SEC-7: inference + contained file I/O only).
        const completion = await this.backend.complete({
          system: prompt.system,
          messages: prompt.messages,
        });

        // Write the artifact INSIDE the isolated workspace, then read it back.
        const artifactPath = workspace.resolve("artifact.md");
        await writeFile(artifactPath, completion.text, "utf8");
        const artifact = await readFile(artifactPath, "utf8");

        if (completion.usage?.estimatedCostUsd) {
          this.quota.recordCostUsd(tenantId, completion.usage.estimatedCostUsd);
        }
        await this.runStateStore.update(run.runId, { status: "complete" });

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
        const result = await runAdvisoryPipeline(request, { backend: this.backend }, { plan });

        // Write the artifact INSIDE the isolated workspace, then read it back.
        const artifactPath = workspace.resolve("artifact.md");
        await writeFile(artifactPath, result.artifact, "utf8");
        const artifact = await readFile(artifactPath, "utf8");

        for (const usage of result.usage) {
          if (usage.estimatedCostUsd) {
            this.quota.recordCostUsd(tenantId, usage.estimatedCostUsd);
          }
        }
        await this.runStateStore.update(run.runId, { status: "complete", artifact });

        return {
          kind: "embedded",
          outcome: "completed",
          matchedRouting,
          artifact,
          workspaceRoot: workspace.root,
          runId: run.runId,
          backendId: result.stages.at(-1)?.backendId,
          usage: result.usage.at(-1),
        };
      } catch (error) {
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
   * Execute the spike catch-all pipeline (Task Researcher -> Task Reviewer) as a
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
    const core = await this.runPipelineCore(tenantId, request, personaRoots);
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
    const core = await this.runPipelineCore(run.tenantId, request, personaRoots);
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
          "operator approves it out-of-band. The squad never auto-releases a gate.",
        runId,
      };
    }

    // Approved: transition held -> running and execute the pipeline to completion.
    await this.runStateStore.update(runId, { status: "running" });
    const core = await this.runPipelineCore(run.tenantId, request, personaRoots);
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
   * a later status poll can drive it to completion after approval. `squad_run` is
   * gated, so this returns a HELD result with a run id: no pipeline runs and no
   * model is called until an operator approves out-of-band (SEC-6 / PROD-5 carried
   * across the remote boundary). A held run does not hold a concurrency slot.
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
      const gate = this.gates.classify({ tool, mode: request.mode });
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
   * When the run is approved, behavior depends on `driveOnPoll`:
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
      return { kind: "embedded", outcome: "completed", matchedRouting: EMPTY_ROUTING, artifact: run.artifact, runId };
    }
    if (run.status === "failed") {
      return { kind: "embedded", outcome: "denied", matchedRouting: EMPTY_ROUTING, reason: "run_failed", runId };
    }
    // held / running: never auto-release; only an explicit approval proceeds.
    if (!(await this.approvals.isApproved(runId))) {
      return {
        kind: "embedded",
        outcome: "held",
        matchedRouting: EMPTY_ROUTING,
        reason: run.holdReason ?? "awaiting human approval",
        approvalRequest:
          "This run is paused for human approval and will not proceed until an " +
          "operator approves it out-of-band. The squad never auto-releases a gate.",
        runId,
      };
    }

    // Worker mode: the poll never executes; the ACA Job drives approved runs.
    if (!this.driveOnPoll) {
      return {
        kind: "embedded",
        outcome: "held",
        matchedRouting: EMPTY_ROUTING,
        reason: "queued_for_worker",
        runId,
      };
    }

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
      return {
        kind: "embedded",
        outcome: "held",
        matchedRouting: EMPTY_ROUTING,
        reason: "run_already_in_flight",
        runId,
      };
    }
    try {
      return await this.executeRunningRun(claimed);
    } finally {
      admit.release();
    }
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
    const req: CoordinatorRequest = {
      toolId: run.toolId,
      request: run.request ?? "",
      context: run.context,
    };
    const core = await this.runPipelineCore(run.tenantId, req);
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
   * yields ONE compiled artifact; the human gate is the EXISTING non-bypassable
   * hold already applied at {@link startHttpRun} (released out-of-band via
   * `/admin/approve`), so no additional final hold is injected here.
   *
   * Per-stage artifacts + the council verdict + a history list persist durably
   * through {@link StoreAdvisoryPersistence} so a status poll recompiles the
   * finished artifact multi-replica and after a cold start; the compiled artifact
   * is also stored on the run so `squad_status` returns it directly. A council
   * `Stop` verdict halts the pipeline and the run completes with the Stop artifact
   * (there is no implement stage to gate in advisory scope). All work happens
   * inside a server-allocated per-tenant workspace with guaranteed teardown (SEC-4).
   */
  private async executeAdvisoryRun(run: RunState): Promise<EmbeddedResult> {
    const req: CoordinatorRequest = {
      toolId: run.toolId,
      request: run.request ?? "",
      context: run.context,
    };
    const workspace = await this.workspaceManager.allocate(run.tenantId);
    try {
      const persistence = new StoreAdvisoryPersistence(this.runStateStore, run.runId);
      // Autopilot: advance stage-to-stage to a single compiled artifact. The human
      // gate already fired at startHttpRun; no additional finalHold is injected.
      const result = await runAdvisoryPipeline(
        req,
        { backend: this.backend, persistence },
        { mode: "autopilot" },
      );

      for (const usage of result.usage) {
        if (usage.estimatedCostUsd) {
          this.quota.recordCostUsd(run.tenantId, usage.estimatedCostUsd);
        }
      }

      // `completed` and a council `Stop` `halted` are both terminal-with-artifact;
      // persist the compiled artifact so the status poll returns it directly.
      await this.runStateStore.update(run.runId, { status: "complete", artifact: result.artifact });
      this.decrementHeld(run.tenantId);
      return {
        kind: "embedded",
        outcome: "completed",
        matchedRouting: EMPTY_ROUTING,
        artifact: result.artifact,
        workspaceRoot: workspace.root,
        runId: run.runId,
        backendId: result.stages.at(-1)?.backendId,
        usage: result.usage.at(-1),
      };
    } catch (error) {
      await this.runStateStore.update(run.runId, { status: "failed" });
      this.decrementHeld(run.tenantId);
      throw error;
    } finally {
      // SEC-4 — teardown runs even on error/timeout.
      await workspace.dispose();
    }
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
   * Release a HELD run by recording an out-of-band OPERATOR approval (SEC-6). This
   * is the ONLY production caller of the approval channel and the keystone that
   * lets a deployed held `squad_run` proceed: the operator calls it through the
   * `/admin/approve` route, never a `tools/call`, so caller `request`/`context` and
   * model output have no path to a release. Tenant-scoped: an operator may release
   * only runs owned by their own tenant/authority; an unknown or cross-tenant run
   * id is denied with no leakage (mirrors {@link pollRun}). Records approver +
   * timestamp via the auditable channel; `approver` is the operator's token subject.
   * Idempotent — re-approving an already-approved run keeps the original record.
   */
  approveRun(
    runId: string,
    ctx: EmbeddedContext,
  ): Promise<{ ok: true; record: ApprovalRecord } | { ok: false; reason: string }> {
    return this.runStateStore.get(runId).then(async (run) => {
      if (!run || run.tenantId !== ctx.auth.tenantId) {
        return { ok: false as const, reason: "run_not_found_or_cross_tenant" };
      }
      await this.approvals.approve(runId, ctx.auth.subject);
      // approvalRecord is present immediately after approve for this run id.
      const record = (await this.approvals.approvalRecord(runId)) as ApprovalRecord;
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
      const pipeline = await runPipeline(stages, request, { backend: this.backend });

      // Persist the combined artifact INSIDE the isolated workspace, then read it back.
      const artifactPath = workspace.resolve("artifact.md");
      await writeFile(artifactPath, pipeline.artifact, "utf8");
      const artifact = await readFile(artifactPath, "utf8");

      for (const usage of pipeline.usage) {
        if (usage.estimatedCostUsd) {
          this.quota.recordCostUsd(tenantId, usage.estimatedCostUsd);
        }
      }

      return {
        outcome: "completed",
        artifact,
        workspaceRoot: workspace.root,
        backendId: pipeline.stages.at(-1)?.backendId,
        usage: pipeline.usage.at(-1),
      };
    } finally {
      // SEC-4 — teardown runs even on error/timeout.
      await workspace.dispose();
    }
  }
}
