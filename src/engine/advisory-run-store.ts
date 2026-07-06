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
 * Each `record*` call is a read-modify-write append. Advisory stages run
 * sequentially within a single run driver, so there is no intra-run write race;
 * the durable store's cross-replica CAS still guards the run's status transitions
 * (WI-06), which is the boundary that decides which replica drives the run at all.
 * An append against a run that has vanished (TTL sweep) is a silent no-op.
 */
import type {
  PersistedCouncilVerdict,
  PersistedStageArtifact,
  RunStateStore,
} from "./run-state.js";
import type { AdvisoryRunPersistence } from "./advisory-pipeline.js";

export class StoreAdvisoryPersistence implements AdvisoryRunPersistence {
  constructor(
    private readonly store: RunStateStore,
    private readonly runId: string,
    /** Clock injection for deterministic history timestamps in tests. */
    private readonly clock: () => number = Date.now,
  ) {}

  async recordStage(stage: PersistedStageArtifact): Promise<void> {
    const run = await this.store.get(this.runId);
    if (!run) {
      return;
    }
    const stages = [...(run.stages ?? []), stage];
    const history = [
      ...(run.history ?? []),
      { stage: stage.role, at: new Date(this.clock()).toISOString() },
    ];
    await this.store.update(this.runId, { stages, history });
  }

  async recordVerdict(verdict: PersistedCouncilVerdict): Promise<void> {
    const run = await this.store.get(this.runId);
    if (!run) {
      return;
    }
    await this.store.update(this.runId, { councilVerdict: verdict });
  }
}
