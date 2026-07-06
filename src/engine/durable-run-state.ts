/**
 * Durable run-state store (ARCH-1 / ARCH-2 realization for the spike).
 *
 * The ephemeral store resets on process restart, which is fine for a single-stage
 * synchronous hero tool but not for the async run + status-poll pattern the full
 * pipeline needs: a run started on one request must be resolvable on a LATER
 * request, even after Azure Container Apps scales the app to zero and cold-starts
 * a fresh process (the 240s ingress ceiling means a minutes-long run cannot ride
 * one synchronous call — research KD-5 / KD-6).
 *
 * This file-backed store persists each run as a JSON document keyed by the
 * unguessable, server-allocated run id, so a second store instance (a new
 * process) resolves a run created by the first. The same {@link RunStateStore}
 * interface later targets Azure Storage / Key Vault for production (WI-06).
 *
 * SEC-4 containment: `get`/`update`/`delete` accept a caller-supplied run id
 * (via the status poll), so the id is validated to a UUID shape BEFORE it is ever
 * used to build a path — a traversal payload cannot reach the filesystem. Tenant
 * ownership is enforced by the caller (the engine's status poll compares the
 * stored `tenantId`); the id is also a CSPRNG UUID, so it is unguessable.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_LEASE_MS,
  isRunClaimable,
  isRunExpired,
  type ClaimOptions,
  type CreateRunInit,
  type PersistedCouncilVerdict,
  type PersistedStageArtifact,
  type RunState,
  type RunStateStore,
  type RunStatus,
} from "./run-state.js";
import { NullFieldCipher, decryptField, encryptField, type FieldCipher } from "./field-cipher.js";

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True only for a canonical UUID (guards path construction against traversal). */
export function isValidRunId(runId: string): boolean {
  return UUID_SHAPE.test(runId);
}

export interface DurableRunStateStoreOptions {
  /** Base directory for run documents (default: a stable OS temp subdir). */
  baseDir?: string;
  /**
   * WI-06 — field cipher for `request`/`context` at rest (default identity). Wire
   * {@link AesGcmFieldCipher} in production so the caller's prompt text is opaque
   * on disk (MEDIUM-3).
   */
  cipher?: FieldCipher;
}

/**
 * File-backed durable run-state store. Survives process restarts so an async run
 * started on one request is resolvable on a later one (cold-start resume). It is
 * SINGLE-REPLICA: `claim` is atomic within one process but not across processes,
 * so a multi-replica deployment uses the Azure Table store (cross-replica ETag
 * CAS) instead. When a {@link FieldCipher} is supplied, `request`/`context` are
 * encrypted at rest and decrypted on read (WI-06 / MEDIUM-3).
 */
export class DurableRunStateStore implements RunStateStore {
  readonly kind = "durable" as const;
  private readonly baseDir: string;
  private readonly cipher: FieldCipher;

  constructor(options: DurableRunStateStoreOptions = {}) {
    this.baseDir = options.baseDir ?? join(tmpdir(), "squad-mcp-runs");
    this.cipher = options.cipher ?? new NullFieldCipher();
    mkdirSync(this.baseDir, { recursive: true });
  }

  private pathFor(runId: string): string | undefined {
    if (!isValidRunId(runId)) {
      return undefined;
    }
    return join(this.baseDir, `${runId}.json`);
  }

  /** Encrypt the at-rest fields before writing a record to disk. */
  private seal(run: RunState): RunState {
    return {
      ...run,
      request: encryptField(this.cipher, run.request),
      context: encryptField(this.cipher, run.context),
      stages: this.sealStages(run.stages),
      councilVerdict: this.sealVerdict(run.councilVerdict),
    };
  }

  /** Decrypt the at-rest fields after reading a record from disk. */
  private open(run: RunState): RunState {
    return {
      ...run,
      request: decryptField(this.cipher, run.request),
      context: decryptField(this.cipher, run.context),
      stages: this.openStages(run.stages),
      councilVerdict: this.openVerdict(run.councilVerdict),
    };
  }

  /** Encrypt each persisted stage's `artifact` (caller/model text); role stays clear. */
  private sealStages(stages: PersistedStageArtifact[] | undefined): PersistedStageArtifact[] | undefined {
    return stages?.map((stage) => ({ ...stage, artifact: this.cipher.encrypt(stage.artifact) }));
  }

  /** Decrypt each persisted stage's `artifact` on read. */
  private openStages(stages: PersistedStageArtifact[] | undefined): PersistedStageArtifact[] | undefined {
    return stages?.map((stage) => ({ ...stage, artifact: this.cipher.decrypt(stage.artifact) }));
  }

  /** Encrypt the verdict's rendered block + conditions (model text); class stays clear. */
  private sealVerdict(verdict: PersistedCouncilVerdict | undefined): PersistedCouncilVerdict | undefined {
    if (!verdict) {
      return undefined;
    }
    return {
      ...verdict,
      rendered: this.cipher.encrypt(verdict.rendered),
      conditions: verdict.conditions?.map((condition) => this.cipher.encrypt(condition)),
    };
  }

  /** Decrypt the verdict's rendered block + conditions on read. */
  private openVerdict(verdict: PersistedCouncilVerdict | undefined): PersistedCouncilVerdict | undefined {
    if (!verdict) {
      return undefined;
    }
    return {
      ...verdict,
      rendered: this.cipher.decrypt(verdict.rendered),
      conditions: verdict.conditions?.map((condition) => this.cipher.decrypt(condition)),
    };
  }

  private writeRun(run: RunState): void {
    // runId is a validated UUID for every code path that reaches here.
    writeFileSync(this.pathFor(run.runId) as string, JSON.stringify(this.seal(run)), "utf8");
  }

  /** Sync file removal used by internal (non-async) paths like lazy expiry. */
  private removeFile(runId: string): void {
    const path = this.pathFor(runId);
    if (!path) {
      return;
    }
    try {
      rmSync(path, { force: true });
    } catch {
      // idempotent
    }
  }

  /** Read the raw (still-sealed) record, honoring lazy TTL expiry. */
  private readRaw(runId: string): RunState | undefined {
    const path = this.pathFor(runId);
    if (!path) {
      return undefined;
    }
    let run: RunState;
    try {
      run = JSON.parse(readFileSync(path, "utf8")) as RunState;
    } catch {
      return undefined;
    }
    if (isRunExpired(run, Date.now())) {
      this.removeFile(runId);
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
    this.writeRun(run);
    return Promise.resolve(run);
  }

  get(runId: string): Promise<RunState | undefined> {
    const run = this.readRaw(runId);
    return Promise.resolve(run ? this.open(run) : undefined);
  }

  update(
    runId: string,
    patch: Partial<Omit<RunState, "runId" | "tenantId" | "toolId" | "createdAt">>,
  ): Promise<RunState | undefined> {
    const existing = this.readRaw(runId);
    if (!existing) {
      return Promise.resolve(undefined);
    }
    // Merge on the DECRYPTED view so a caller patch of request/context is re-sealed.
    const next: RunState = { ...this.open(existing), ...patch, updatedAt: Date.now() };
    this.writeRun(next);
    return Promise.resolve(next);
  }

  delete(runId: string): Promise<void> {
    this.removeFile(runId);
    return Promise.resolve();
  }

  claim(runId: string, from: RunStatus[], to: RunStatus, options: ClaimOptions = {}): Promise<RunState | undefined> {
    const now = options.now ?? Date.now();
    // read+check+write with no await between: atomic within one process.
    const existing = this.readRaw(runId);
    if (!existing || !from.includes(existing.status)) {
      return Promise.resolve(undefined);
    }
    if (existing.status === "running" && (existing.leaseExpiresAt ?? 0) > now) {
      return Promise.resolve(undefined);
    }
    const next: RunState = {
      ...this.open(existing),
      status: to,
      leaseExpiresAt: now + (options.leaseMs ?? DEFAULT_LEASE_MS),
      updatedAt: now,
    };
    this.writeRun(next);
    return Promise.resolve(next);
  }

  private allRuns(): RunState[] {
    let entries: string[];
    try {
      entries = readdirSync(this.baseDir);
    } catch {
      return [];
    }
    const runs: RunState[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) {
        continue;
      }
      const runId = entry.slice(0, -".json".length);
      const run = this.readRaw(runId);
      if (run) {
        runs.push(run);
      }
    }
    return runs;
  }

  listClaimable(now: number = Date.now()): Promise<RunState[]> {
    // Claimability is decided on metadata only; request/context stay sealed.
    return Promise.resolve(this.allRuns().filter((run) => isRunClaimable(run, now)).map((run) => this.open(run)));
  }

  sweepExpired(now: number = Date.now()): Promise<number> {
    let entries: string[];
    try {
      entries = readdirSync(this.baseDir);
    } catch {
      return Promise.resolve(0);
    }
    let removed = 0;
    for (const entry of entries) {
      if (!entry.endsWith(".json")) {
        continue;
      }
      const runId = entry.slice(0, -".json".length);
      const path = this.pathFor(runId);
      if (!path) {
        continue;
      }
      try {
        const run = JSON.parse(readFileSync(path, "utf8")) as RunState;
        if (isRunExpired(run, now)) {
          this.removeFile(runId);
          removed += 1;
        }
      } catch {
        // skip unreadable
      }
    }
    return Promise.resolve(removed);
  }
}
