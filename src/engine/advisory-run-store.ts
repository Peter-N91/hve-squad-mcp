/**
 * Store-backed advisory persistence adapter (Phase 4).
 *
 * The advisory orchestrator ({@link import("./advisory-pipeline.js").runAdvisoryPipeline})
 * writes progress through the store-agnostic
 * {@link import("./advisory-pipeline.js").AdvisoryRunPersistence} seam. This
 * adapter binds that seam to a concrete {@link RunStateStore} + run id, so an
 * async advisory run persists its ordered per-stage artifacts, the council
 * verdict, and a lightweight history list on the durable run record. A status
 * poll then recompiles the finished artifact from the persisted stages — multi
 * replica and after a scale-to-zero cold start — reusing the SAME durable store
 * (file or Azure Table) + field cipher that already protects `request`/`context`.
 *
 * Each `record*` call is a read-modify-write append. One adapter serializes its
 * writes because direct council members may finish concurrently; the durable
 * store's cross-replica CAS still guards the run's status transitions (WI-06),
 * which is the boundary that decides which replica drives the run at all. Missing
 * runs and lost writes fail explicitly rather than reporting durable progress.
 */
import type {
  PersistedCouncilVerdict,
  PersistedStageArtifact,
  RunStateStore,
} from "./run-state.js";
import type { AdvisoryRunPersistence } from "./advisory-pipeline.js";
import {
  attributeCompletion,
  type BackendCompletionEvent,
  type CompletionContext,
  type CompletionUsageRecord,
} from "./model-backend.js";

export class StoreAdvisoryPersistence implements AdvisoryRunPersistence {
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: RunStateStore,
    private readonly runId: string,
    /** Clock injection for deterministic history timestamps in tests. */
    private readonly clock: () => number = Date.now,
  ) {}

  recordStage(stage: PersistedStageArtifact): Promise<void> {
    return this.enqueue(async () => {
      const run = await this.store.get(this.runId);
      if (!run) {
        throw new Error("Cannot persist advisory progress: run no longer exists.");
      }
      const stages = [...(run.stages ?? []), stage];
      const history = [
        ...(run.history ?? []),
        { stage: stage.role, at: new Date(this.clock()).toISOString() },
      ];
      if (!await this.store.update(this.runId, { stages, history })) {
        throw new Error("Advisory progress write was not accepted.");
      }
    });
  }

  recordVerdict(verdict: PersistedCouncilVerdict): Promise<void> {
    return this.enqueue(async () => {
      const run = await this.store.get(this.runId);
      if (!run) {
        throw new Error("Cannot persist advisory verdict: run no longer exists.");
      }
      if (!await this.store.update(this.runId, { councilVerdict: verdict })) {
        throw new Error("Advisory verdict write was not accepted.");
      }
    });
  }

  recordCompletion(
    event: BackendCompletionEvent,
    context: CompletionContext,
  ): Promise<boolean> {
    return this.recordAttributedCompletion(attributeCompletion(event, {
      runId: this.runId,
      ...context,
    }));
  }

  recordAttributedCompletion(record: CompletionUsageRecord): Promise<boolean> {
    return this.enqueue(async () => {
      if (record.runId !== this.runId) {
        throw new Error("Completion usage belongs to a different run.");
      }
      const run = await this.store.get(this.runId);
      if (!run) {
        throw new Error("Cannot persist completion usage: run no longer exists.");
      }
      if (run.completionUsage?.some((entry) => entry.eventId === record.eventId)) {
        return false;
      }
      const completionUsage = [...(run.completionUsage ?? []), record];
      if (!await this.store.update(this.runId, { completionUsage })) {
        throw new Error("Completion usage write was not accepted.");
      }
      return true;
    });
  }

  private enqueue<T>(write: () => Promise<T>): Promise<T> {
    const result = this.writes.then(write, write);
    this.writes = result.then(() => undefined, () => undefined);
    return result;
  }
}
