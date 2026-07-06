/**
 * Run-state seam (ARCH-1 — resumable-ready).
 *
 * The thin slice runs a single-stage hero tool (`squad_research`) whose state is
 * **ephemeral per request** — no resumability is needed. But the Gate B ADR
 * (docs/planning/adrs/0001) commits to a tenant-isolated *resumable* run-state
 * model for the long-running tools that land in Phase 1b / Phase 2. To avoid an
 * ephemeral-only lock-in (architect condition 1), the engine writes and reads
 * run state through THIS interface now, so a `DurableRunStateStore` can be
 * dropped in later (persisting to Storage/Key Vault and rehydrating after a
 * scale-to-zero cold start) without touching the embedded engine.
 *
 * No durable behavior is implemented here; only the seam plus the ephemeral
 * realization the thin slice uses.
 */
import { randomUUID } from "node:crypto";

import type { CouncilVerdictClass } from "./council.js";

export type RunStatus = "running" | "held" | "complete" | "failed";

/** Default worker lease (ms): a `running` run past its lease is reclaimable. */
export const DEFAULT_LEASE_MS = 10 * 60 * 1000;

/**
 * One persisted advisory stage artifact (Phase 4). The ordered list of these on
 * the run record mirrors the advisory pipeline's per-stage sections, so a status
 * poll can recompile the artifact from the store after a scale-to-zero cold start
 * or on a replica that did not run the stage. `artifact` holds the fully-rendered
 * section (heading included) so recompilation is a plain join. It is
 * caller/model-influenced text, so the durable stores encrypt it at rest with the
 * same {@link FieldCipher} that protects `request`/`context` (MEDIUM-3).
 */
export interface PersistedStageArtifact {
  /** The stage section heading / role label (e.g. `Task Researcher`, `Council Verdict`). */
  role: string;
  /** The resolved agent name when it differs from the role label (optional). */
  agentName?: string;
  /** The fully-rendered stage section (heading + body). Encrypted at rest. */
  artifact: string;
}

/**
 * The persisted, lightweight projection of the Phase 3 council verdict (Phase 4).
 * Reuses {@link CouncilVerdictClass} for the verdict class rather than redefining
 * the union; only the fields a status poll needs are stored (`class`,
 * `conditions`, and the rendered block). The rendered text and conditions are
 * model-influenced, so the durable stores encrypt them at rest.
 */
export interface PersistedCouncilVerdict {
  /** The most-restrictive-wins verdict class. */
  class: CouncilVerdictClass;
  /** The aggregated, role-attributed conditions (empty/absent for a `Go`). */
  conditions?: string[];
  /** The rendered `## Council Verdict` markdown block. Encrypted at rest. */
  rendered: string;
}

/** One lightweight audit entry recording when an advisory stage completed. */
export interface RunHistoryEntry {
  /** The stage label that completed (role or `Council Verdict`). */
  stage: string;
  /** ISO-8601 timestamp of completion. */
  at: string;
}

export interface RunState {
  /** Server-allocated, unguessable run id (never caller-influenced). */
  readonly runId: string;
  /** The owning tenant — the isolation key. */
  readonly tenantId: string;
  /** The tool this run is executing. */
  readonly toolId: string;
  status: RunStatus;
  /** Epoch ms the run was created. */
  readonly createdAt: number;
  /** When `status === "held"`, why the gate is held (no secret content). */
  holdReason?: string;
  /** The finished artifact, persisted on completion (durable store; async poll). */
  artifact?: string;
  /** Epoch ms of the last status transition (durable store bookkeeping / TTL). */
  updatedAt?: number;
  /**
   * The caller request/context persisted with the run so a later status poll can
   * drive the pipeline to completion after an out-of-band approval (async HTTP
   * pattern). This is the caller's own data in their tenant-partitioned record.
   * Encrypted at rest by the durable store when a {@link FieldCipher} is wired
   * (WI-06 / MEDIUM-3).
   */
  request?: string;
  context?: string;
  /**
   * WI-06 — the out-of-band OPERATOR approval, persisted ON the run record so it
   * is visible to EVERY replica (a store-backed {@link HumanApprovalChannel} reads
   * these). The in-process approval map only released a hold on the replica that
   * received the approval; storing it here is what makes release cross-replica.
   */
  approvedBy?: string;
  approvedAt?: number;
  /**
   * WI-06 — TTL: epoch ms after which the run is treated as gone (lazy expiry on
   * read; swept by {@link RunStateStore.sweepExpired}). Bounds held-run
   * accumulation cross-replica (MEDIUM-2, full form).
   */
  expiresAt?: number;
  /**
   * WI-06 — worker lease: epoch ms a claim on a `running` run is valid until. A
   * `running` run past its lease is reclaimable, so a run whose worker crashed
   * mid-execution is picked up again instead of stranding forever.
   */
  leaseExpiresAt?: number;
  /**
   * Phase 4 — the ordered per-stage advisory artifacts persisted as an async run
   * progresses. A status poll recompiles the artifact from these, so a run that
   * cleared the 240s ingress ceiling (or resumed on another replica) still returns
   * its finished sections. Each `artifact` is encrypted at rest by the durable
   * store (MEDIUM-3), exactly as `request`/`context` are.
   */
  stages?: PersistedStageArtifact[];
  /**
   * Phase 4 — the persisted council verdict for the run (when the council stage
   * ran). Its rendered text/conditions are encrypted at rest with the same cipher.
   */
  councilVerdict?: PersistedCouncilVerdict;
  /**
   * Phase 4 — a lightweight, append-only audit list of completed advisory stages
   * (metadata only: stage label + timestamp), left in the clear for auditability.
   */
  history?: RunHistoryEntry[];
}

export interface CreateRunInit {
  tenantId: string;
  toolId: string;
  /** WI-06 — optional TTL (ms from creation) after which the run expires. */
  ttlMs?: number;
}

/** Options for an atomic {@link RunStateStore.claim} compare-and-transition. */
export interface ClaimOptions {
  /** Lease length (ms) stamped on the claimed run (default {@link DEFAULT_LEASE_MS}). */
  leaseMs?: number;
  /** Clock injection for deterministic tests (default `Date.now`). */
  now?: number;
}

/**
 * Stores run state keyed by run id, partitioned by tenant. The `kind` marks
 * whether resumability survives a process restart AND whether transitions are
 * atomic ACROSS replicas: `ephemeral`/file are single-replica; the Azure Table
 * store is `durable` with cross-replica compare-and-swap (WI-06).
 *
 * Every method is async: a network-backed store (Azure Table) cannot do sync I/O,
 * so the contract is Promise-based and the engine awaits every call.
 */
export interface RunStateStore {
  readonly kind: "ephemeral" | "durable";
  create(init: CreateRunInit): Promise<RunState>;
  get(runId: string): Promise<RunState | undefined>;
  update(runId: string, patch: Partial<Omit<RunState, "runId" | "tenantId" | "toolId" | "createdAt">>): Promise<RunState | undefined>;
  delete(runId: string): Promise<void>;
  /**
   * WI-06 — atomically transition a run from one of `from` to `to`, stamping a
   * fresh lease. Succeeds only when the run exists, is not expired, its current
   * status is in `from`, AND (for a `running` run) its prior lease has expired —
   * so exactly ONE replica wins a claim (compare-and-swap). Returns the updated
   * run on success, or `undefined` when the CAS is lost / the run is gone. This
   * replaces the in-process in-flight guard with a cross-replica primitive.
   */
  claim(runId: string, from: RunStatus[], to: RunStatus, options?: ClaimOptions): Promise<RunState | undefined>;
  /**
   * WI-06 — runs a worker may pick up: an APPROVED held run, or a `running` run
   * whose lease expired (queued-but-unstarted, or crashed mid-run). Excludes
   * complete/failed/expired runs. The worker claims each via {@link claim}.
   */
  listClaimable(now?: number): Promise<RunState[]>;
  /** WI-06 — delete expired runs (TTL janitor); returns the count removed. */
  sweepExpired(now?: number): Promise<number>;
}

/** True when a run is approved for release (operator approval recorded on the record). */
export function isRunApproved(run: RunState): boolean {
  return typeof run.approvedBy === "string" && run.approvedBy.length > 0;
}

/** True when a run has passed its TTL. */
export function isRunExpired(run: RunState, now: number): boolean {
  return typeof run.expiresAt === "number" && run.expiresAt <= now;
}

/**
 * Whether a run is claimable by a worker at `now`: an approved held run, or a
 * `running` run whose lease has expired (never-started queue entry, or a crash).
 * Shared by every store so `listClaimable` semantics are identical everywhere.
 */
export function isRunClaimable(run: RunState, now: number): boolean {
  if (run.status === "complete" || run.status === "failed" || isRunExpired(run, now)) {
    return false;
  }
  if (run.status === "held") {
    return isRunApproved(run);
  }
  // running: claimable only when its lease has lapsed.
  return (run.leaseExpiresAt ?? 0) <= now;
}

/**
 * In-memory, per-process run-state store. Resets on restart (acceptable for the
 * thin slice's stateless single-stage tools). A future durable store implements
 * the same interface for the long-run/resumable path (ARCH-1 / ARCH-2).
 */
export class EphemeralRunStateStore implements RunStateStore {
  readonly kind = "ephemeral" as const;
  private readonly runs = new Map<string, RunState>();

  /** Sync, TTL-aware read used internally so `claim` stays atomic (no await gap). */
  private peek(runId: string): RunState | undefined {
    const run = this.runs.get(runId);
    if (!run) {
      return undefined;
    }
    if (isRunExpired(run, Date.now())) {
      this.runs.delete(runId);
      return undefined;
    }
    return run;
  }

  create(init: CreateRunInit): Promise<RunState> {
    const now = Date.now();
    const run: RunState = {
      runId: randomUUID(),
      tenantId: init.tenantId,
      toolId: init.toolId,
      status: "running",
      createdAt: now,
      updatedAt: now,
      expiresAt: init.ttlMs !== undefined ? now + init.ttlMs : undefined,
    };
    this.runs.set(run.runId, run);
    return Promise.resolve(run);
  }

  get(runId: string): Promise<RunState | undefined> {
    return Promise.resolve(this.peek(runId));
  }

  update(
    runId: string,
    patch: Partial<Omit<RunState, "runId" | "tenantId" | "toolId" | "createdAt">>,
  ): Promise<RunState | undefined> {
    const existing = this.peek(runId);
    if (!existing) {
      return Promise.resolve(undefined);
    }
    const next: RunState = { ...existing, ...patch, updatedAt: Date.now() };
    this.runs.set(runId, next);
    return Promise.resolve(next);
  }

  delete(runId: string): Promise<void> {
    this.runs.delete(runId);
    return Promise.resolve();
  }

  claim(runId: string, from: RunStatus[], to: RunStatus, options: ClaimOptions = {}): Promise<RunState | undefined> {
    const now = options.now ?? Date.now();
    // Read+check+write with NO await between them: atomic within one process, so
    // two concurrent claims cannot both win (in-process CAS; cross-replica CAS is
    // the Azure Table store's ETag If-Match).
    const existing = this.peek(runId);
    if (!existing || !from.includes(existing.status)) {
      return Promise.resolve(undefined);
    }
    if (existing.status === "running" && (existing.leaseExpiresAt ?? 0) > now) {
      return Promise.resolve(undefined);
    }
    const next: RunState = {
      ...existing,
      status: to,
      leaseExpiresAt: now + (options.leaseMs ?? DEFAULT_LEASE_MS),
      updatedAt: now,
    };
    this.runs.set(runId, next);
    return Promise.resolve(next);
  }

  listClaimable(now: number = Date.now()): Promise<RunState[]> {
    const claimable: RunState[] = [];
    for (const run of this.runs.values()) {
      if (!isRunExpired(run, now) && isRunClaimable(run, now)) {
        claimable.push(run);
      }
    }
    return Promise.resolve(claimable);
  }

  sweepExpired(now: number = Date.now()): Promise<number> {
    let removed = 0;
    for (const [runId, run] of this.runs) {
      if (isRunExpired(run, now)) {
        this.runs.delete(runId);
        removed += 1;
      }
    }
    return Promise.resolve(removed);
  }
}
