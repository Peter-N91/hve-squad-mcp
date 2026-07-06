/**
 * Background run worker (WI-1b4-WORKER — the >240s escape hatch).
 *
 * The synchronous status poll can only drive a run within the Azure Container
 * Apps 240s HTTP ingress ceiling. A multi-agent pipeline can run longer, so in a
 * worker deployment the web tier's poll is READ-ONLY (`driveOnPoll: false`) and
 * THIS worker — an ACA Job on the SAME cross-replica run-state store — drives
 * approved runs off the request path.
 *
 * Safety is inherited, not re-implemented: the worker only ever picks up runs the
 * store reports as claimable (an APPROVED held run, or a `running` run whose lease
 * lapsed), and it drives each through {@link EmbeddedCoordinator.driveClaimable},
 * which CAS-claims the run first. So the gate is still non-bypassable (only an
 * out-of-band operator approval makes a held run claimable), tenant isolation is
 * unchanged, and two workers (or a worker racing a poll) cannot double-execute a
 * run — the loser of the CAS simply moves on.
 */
import type { EmbeddedCoordinator } from "./embedded.js";
import type { RedactingLogger } from "../observability/logger.js";

export interface RunWorkerDeps {
  coordinator: EmbeddedCoordinator;
  logger?: RedactingLogger;
  /** Max runs to drive per tick (default 10). */
  batchSize?: number;
}

/** The outcome of one worker tick. */
export interface WorkerTickResult {
  /** Runs the worker claimed and drove this tick. */
  driven: number;
  /** Runs that were claimable but lost the CAS (another worker/poll won). */
  skipped: number;
  /** Expired runs swept this tick. */
  swept: number;
}

const DEFAULT_BATCH_SIZE = 10;

export class RunWorker {
  private readonly coordinator: EmbeddedCoordinator;
  private readonly logger?: RedactingLogger;
  private readonly batchSize: number;

  constructor(deps: RunWorkerDeps) {
    this.coordinator = deps.coordinator;
    this.logger = deps.logger;
    this.batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
  }

  /**
   * Run ONE drain pass: sweep expired runs, then claim-and-drive up to
   * `batchSize` claimable runs. Each drive CAS-claims first, so a run already
   * being driven by another worker/poll is skipped (no double-execution). Returns
   * per-tick counters; never throws for a single run's failure (it is logged and
   * the run is marked failed by the coordinator).
   */
  async tickOnce(now?: number): Promise<WorkerTickResult> {
    const swept = await this.coordinator.sweepExpiredRuns(now);
    const claimable = await this.coordinator.listClaimableRuns(now);
    let driven = 0;
    let skipped = 0;
    for (const run of claimable.slice(0, this.batchSize)) {
      try {
        const result = await this.coordinator.driveClaimable(run.runId);
        if (result === undefined) {
          // Lost the CAS — another worker/poll is driving it.
          skipped += 1;
          continue;
        }
        driven += 1;
        this.logger?.info("worker drove a run", { runId: run.runId, outcome: result.outcome });
      } catch (error) {
        // A single run's failure must not stop the drain; the coordinator marks
        // the run failed. Never log the error body (it could echo caller text).
        skipped += 1;
        this.logger?.error("worker run failed", { runId: run.runId, error: String(error) });
      }
    }
    return { driven, skipped, swept };
  }

  /**
   * Poll the store on an interval until `signal` aborts. Between ticks it waits
   * `intervalMs`. Intended for an ACA Job with `minReplicas: 1` (or an event-/
   * schedule-triggered Job that runs `tickOnce` and exits).
   */
  async runForever(intervalMs: number, signal?: AbortSignal): Promise<void> {
    while (!signal?.aborted) {
      await this.tickOnce();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, intervalMs);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
    }
  }
}
