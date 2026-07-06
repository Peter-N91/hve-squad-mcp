/**
 * Gate carry-through, quota enforcement, and the non-bypassable human gate
 * (SEC-6, SEC-7, SEC-9, COST-1, COST-2, PROD-5).
 *
 * Three concerns live here, all server-side and all enforced BEFORE any model
 * call or downstream action:
 *
 *   * {@link TenantQuotaTracker} — per-tenant concurrency caps (SEC-9 / COST-1)
 *     and a hard monthly cost ceiling (COST-2). New work is refused past either
 *     limit; the host-side rate caps in the IaC complement these engine-side
 *     caps.
 *   * {@link GateKeeper} — classifies a tool call as `proceed` or `hold`. A hold
 *     pauses for out-of-band human approval and NEVER auto-releases (PROD-5).
 *     Destructive/confirm-tier/pipeline tools default to a hold (SEC-7).
 *   * {@link HumanApprovalChannel} — the ONLY way a held run proceeds. Approval
 *     is recorded by an explicit operator action keyed on the run id; it is
 *     never derived from `request`, `context`, or model output (SEC-6).
 *
 * The non-bypassable property is structural, not advisory: there is no method on
 * any type here that turns a hold into a proceed using caller-supplied or
 * model-generated text. An injected "auto-approve / ignore the gate" string has
 * no code path to a release.
 */
import type { CatalogTool } from "../catalog/catalog.js";
import { isRunApproved, type RunStateStore } from "./run-state.js";

/** Returns the `YYYY-MM` bucket a timestamp falls in (cost accounting window). */
function monthKey(epochMs: number): string {
  const date = new Date(epochMs);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export interface TenantQuotaOptions {
  /** Max concurrent in-flight dispatches per tenant (SEC-9 / COST-1). */
  concurrency: number;
  /** Hard monthly cost ceiling per tenant in USD (COST-2). */
  monthlyCeilingUsd: number;
  /** Clock injection for testing the month rollover (default `Date.now`). */
  now?: () => number;
}

/** The result of attempting to admit a new dispatch under a tenant's quota. */
export type AdmitResult =
  | { ok: true; release: () => void }
  | { ok: false; reason: "concurrency_cap" | "cost_ceiling" };

interface TenantUsage {
  active: number;
  month: string;
  spentUsd: number;
}

/** Tracks per-tenant concurrency and monthly spend; refuses past either limit. */
export class TenantQuotaTracker {
  private readonly concurrency: number;
  private readonly monthlyCeilingUsd: number;
  private readonly now: () => number;
  private readonly usage = new Map<string, TenantUsage>();

  constructor(options: TenantQuotaOptions) {
    this.concurrency = options.concurrency;
    this.monthlyCeilingUsd = options.monthlyCeilingUsd;
    this.now = options.now ?? Date.now;
  }

  private usageFor(tenantId: string): TenantUsage {
    const month = monthKey(this.now());
    const existing = this.usage.get(tenantId);
    if (!existing) {
      const fresh: TenantUsage = { active: 0, month, spentUsd: 0 };
      this.usage.set(tenantId, fresh);
      return fresh;
    }
    if (existing.month !== month) {
      // Month rollover: reset the spend window, keep in-flight count.
      existing.month = month;
      existing.spentUsd = 0;
    }
    return existing;
  }

  /**
   * Atomically check the cost ceiling and acquire a concurrency slot. Returns a
   * `release` to free the slot (call once, in a `finally`). Refuses with a reason
   * when at the cost ceiling (COST-2) or the concurrency cap (SEC-9 / COST-1).
   */
  acquire(tenantId: string): AdmitResult {
    const usage = this.usageFor(tenantId);
    if (usage.spentUsd >= this.monthlyCeilingUsd) {
      return { ok: false, reason: "cost_ceiling" };
    }
    if (usage.active >= this.concurrency) {
      return { ok: false, reason: "concurrency_cap" };
    }
    usage.active += 1;
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        usage.active = Math.max(0, usage.active - 1);
      },
    };
  }

  /** Record realized inference cost so the ceiling reflects actual spend (COST-2). */
  recordCostUsd(tenantId: string, usd: number): void {
    if (usd <= 0) {
      return;
    }
    this.usageFor(tenantId).spentUsd += usd;
  }

  /** Current month's spend for a tenant. */
  spentUsd(tenantId: string): number {
    return this.usageFor(tenantId).spentUsd;
  }

  /** Current in-flight dispatch count for a tenant. */
  activeCount(tenantId: string): number {
    return this.usageFor(tenantId).active;
  }
}

export interface RunCostLedgerOptions {
  /** Per-run cost ceiling in USD across a multi-stage advisory run (COST-2, run scope). */
  ceilingUsd: number;
}

/** The result of a pre-stage cost-ceiling check. */
export type RunCostCheck =
  | { ok: true; spentUsd: number; ceilingUsd: number }
  | { ok: false; reason: "run_cost_ceiling"; spentUsd: number; ceilingUsd: number };

/**
 * COST-2 (run scope) — a per-run cost ledger that accumulates realized stage cost
 * across a single multi-stage advisory run and refuses the NEXT stage once the
 * accumulated spend has reached the ceiling.
 *
 * This is the run-scoped sibling of {@link TenantQuotaTracker}'s monthly ceiling:
 * it reuses the exact same COST-2 accumulate-then-refuse style (accumulate
 * realized `estimatedCostUsd`; refuse when `spent >= ceiling`) rather than
 * inventing a parallel accounting system, but at a per-run granularity so a
 * single advisory pipeline cannot run away across its stages. The check is made
 * BEFORE each stage's model call, so exceeding the ceiling halts the run with a
 * clear reason and zero further model calls — the run's remaining stages are
 * never dispatched.
 */
export class RunCostLedger {
  private readonly ceilingUsd: number;
  private spent = 0;

  constructor(options: RunCostLedgerOptions) {
    this.ceilingUsd = options.ceilingUsd;
  }

  /**
   * Check BEFORE a stage: refuse (with the run-scoped reason) once accumulated
   * spend has reached the ceiling. Mirrors {@link TenantQuotaTracker.acquire}'s
   * `spentUsd >= ceiling` COST-2 test.
   */
  check(): RunCostCheck {
    if (this.spent >= this.ceilingUsd) {
      return { ok: false, reason: "run_cost_ceiling", spentUsd: this.spent, ceilingUsd: this.ceilingUsd };
    }
    return { ok: true, spentUsd: this.spent, ceilingUsd: this.ceilingUsd };
  }

  /** Record a stage's realized inference cost so the ceiling reflects actual spend. */
  record(usd: number | undefined): void {
    if (typeof usd === "number" && usd > 0) {
      this.spent += usd;
    }
  }

  /** Accumulated spend across the run so far. */
  spentUsd(): number {
    return this.spent;
  }
}

/** A gate decision: proceed immediately, or hold for out-of-band human approval. */
export type GateDecision =
  | { kind: "proceed" }
  | { kind: "hold"; reason: string; approvalRequest: string };

/**
 * The out-of-band human approval channel (SEC-6). A held run proceeds ONLY when
 * an operator records approval for its run id through {@link approve} — an action
 * outside the request/response path. Nothing in the engine calls `approve` from
 * caller input or model output.
 */
export interface HumanApprovalChannel {
  /** True when an operator has approved this run id out-of-band. */
  isApproved(runId: string): Promise<boolean>;
  /** Operator action — the only release path. Never called from caller content. */
  approve(runId: string, approver: string): Promise<void>;
  /** The audit record (approver + timestamp) for an approved run, if any. */
  approvalRecord(runId: string): Promise<ApprovalRecord | undefined>;
}

/** A tamper-evident audit record of who approved a run and when. */
export interface ApprovalRecord {
  approver: string;
  /** Epoch ms the approval was recorded. */
  at: number;
}

/** Minimal audit sink; the production logger implements this (redaction applied). */
export interface ApprovalAuditLogger {
  info(message: string, fields?: Record<string, unknown>): void;
}

/**
 * In-memory approval channel; the operator (or a test simulating one) calls
 * `approve`. It records an audit entry (approver + timestamp) for every approval
 * and, when an audit logger is supplied, emits a durable audit line — a security
 * gate must be non-bypassable AND auditable. NOTE: the in-memory map is
 * per-process; a multi-replica deployment needs the shared/durable approval
 * backend (WI-06) so an approval on one replica is visible to all.
 */
export class InMemoryApprovalChannel implements HumanApprovalChannel {
  private readonly approved = new Map<string, ApprovalRecord>();

  constructor(private readonly audit?: ApprovalAuditLogger) {}

  isApproved(runId: string): Promise<boolean> {
    return Promise.resolve(this.approved.has(runId));
  }

  approve(runId: string, approver: string): Promise<void> {
    const record: ApprovalRecord = { approver, at: Date.now() };
    this.approved.set(runId, record);
    this.audit?.info("human gate approved", { runId, approver, at: record.at });
    return Promise.resolve();
  }

  approvalRecord(runId: string): Promise<ApprovalRecord | undefined> {
    return Promise.resolve(this.approved.get(runId));
  }
}

/**
 * WI-06 — a store-backed approval channel that makes release CROSS-REPLICA.
 *
 * {@link InMemoryApprovalChannel} records an approval in a per-process map, so a
 * release recorded on the replica that received the operator's `/admin/approve`
 * is invisible to the OTHER replicas that may later poll the run — a held run
 * would never resume on those replicas. This channel instead persists the
 * approval ON the run record (`approvedBy`/`approvedAt`) through the shared
 * {@link RunStateStore}, so any replica reading the record sees the release. It
 * still records an auditable approver + timestamp and emits the audit line: a
 * security gate must be non-bypassable AND auditable. Wire this with the Azure
 * Table store for a true multi-replica deployment.
 */
export class RunStoreApprovalChannel implements HumanApprovalChannel {
  constructor(
    private readonly store: RunStateStore,
    private readonly audit?: ApprovalAuditLogger,
  ) {}

  async isApproved(runId: string): Promise<boolean> {
    const run = await this.store.get(runId);
    return run !== undefined && isRunApproved(run);
  }

  async approve(runId: string, approver: string): Promise<void> {
    const at = Date.now();
    // Persist the approval on the shared record so every replica observes it.
    await this.store.update(runId, { approvedBy: approver, approvedAt: at });
    this.audit?.info("human gate approved", { runId, approver, at });
  }

  async approvalRecord(runId: string): Promise<ApprovalRecord | undefined> {
    const run = await this.store.get(runId);
    if (!run || !isRunApproved(run)) {
      return undefined;
    }
    return { approver: run.approvedBy as string, at: run.approvedAt ?? 0 };
  }
}

export interface GateClassifyInput {
  tool: CatalogTool;
  /** Autonomy mode (`autonomous` | `autopilot`); never downgrades a hold. */
  mode?: string;
  /**
   * An optional, caller-INDEPENDENT destructive hint from the engine. It can only
   * ADD a hold (fail-safe). It is never sourced from `request`/`context` in a way
   * that could remove a hold.
   */
  destructive?: boolean;
}

/**
 * Classifies tool calls into proceed/hold. Holds are determined by tool metadata
 * and the fail-safe destructive hint only; no input can turn a hold into a
 * proceed.
 */
export class GateKeeper {
  /**
   * SEC-7 / PROD-5: a tool that carries gates, runs at a non-`auto` tier, drives
   * the full pipeline, or is flagged destructive HOLDS for human approval. The
   * `mode` is recorded but never downgrades a hold (autonomous/autopilot still
   * stop at impactful actions).
   */
  classify(input: GateClassifyInput): GateDecision {
    const { tool } = input;
    const gated = tool.gates || tool.catchAll || tool.tier === "confirm" || tool.tier === "escalate";
    if (gated || input.destructive === true) {
      const why = input.destructive
        ? "destructive operation requires explicit human approval"
        : `tool "${tool.id}" carries a Human Gate (tier=${tool.tier}${tool.gates ? ", gated" : ""})`;
      return {
        kind: "hold",
        reason: why,
        approvalRequest:
          "This action is paused for human approval and will not proceed until an " +
          "operator approves it through the out-of-band approval channel. The squad " +
          "never auto-releases a gate across the remote boundary.",
      };
    }
    return { kind: "proceed" };
  }
}
