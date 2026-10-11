import { createHash } from "node:crypto";
import type { CoordinatorRequest } from "../coordinator-engine.js";
import { aggregateBackendUsage, usageFromCompletionRecords, type BackendUsage, type CompletionUsageRecord } from "../model-backend.js";
import { StoreAdvisoryPersistence } from "../advisory-run-store.js";
import { StageInputRequired } from "../research-runtime.js";
import { isRunExpired, type HumanInputRequest, type RunState, type RunStateStore } from "../run-state.js";
import type { Workspace } from "../workspace.js";
import { installedUpstreamBundle } from "./upstream-bundle.js";
import { inspectProjectRuntime } from "./upstream-project-state.js";
import {
  executeRun, type UpstreamContinuationCheckpoint, type UpstreamContinuationResponse,
  type UpstreamExecuteRunResult, type UpstreamInitConfirmation, type UpstreamRuntimeOptions,
} from "./upstream-runtime.js";
import { parseUpstreamRouting } from "./upstream-coordinator.js";

export interface UpstreamRunCheckpointEnvelope {
  kind: "upstream";
  version: 2;
  checkpoint: UpstreamContinuationCheckpoint;
  /** Parent's successful atomic worker claim is the authority, not caller/model text. */
  consumedByLease?: { operationId: string; responseId: string; leaseExpiresAt: number };
}
export interface UpstreamRunServiceOptions {
  store: RunStateStore;
  runtimeOptions: (context: { run: RunState; workspace: Workspace; request: CoordinatorRequest }) =>
    UpstreamRuntimeOptions | Promise<UpstreamRuntimeOptions>;
  /** Structural test port; production uses the real executeRun entry by default. */
  executor?: typeof executeRun;
  now?: () => number;
}
export type UpstreamRunServiceResult =
  | {
    status: "held"; ownsLedger: true; runId: string; humanInput: HumanInputRequest;
    checkpoint: UpstreamContinuationCheckpoint; resumable: boolean; blocker?: string;
    artifact?: string; usage?: BackendUsage;
  }
  | {
    status: "complete"; ownsLedger: true; runId: string; artifact: string; usage?: BackendUsage;
    result: Extract<UpstreamExecuteRunResult, { status: "complete" }>["result"];
  }
  | {
    status: "failed"; ownsLedger: true; runId: string; reason: string; artifact: string;
    usage?: BackendUsage; committedPaths: readonly string[];
  };

const digest = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const INIT_CHOICES = [
  '{"confirmed":true,"profile":"default","naming":"skip","routing":{"mode":"ranked"},"routingAccepted":true,"approvalChannel":"in-chat"}',
  '{"confirmed":true,"profile":"default","naming":"skip","routing":{"mode":"economy"},"routingAccepted":true,"approvalChannel":"in-chat"}',
  'For manual fixed-model routing, use routing: {"mode":"manual","model":"<exact offered model ID>"} with routingAccepted:true and the same explicit confirmation fields.',
  'Use the same explicit JSON fields with another offered pinned profile; "yes" alone is not an Init confirmation.',
];
const activeStores = new WeakMap<RunStateStore, Set<string>>();
function envelope(text: string | undefined): UpstreamRunCheckpointEnvelope | undefined {
  if (!text) return undefined;
  if (Buffer.byteLength(text) > 4000000) throw new Error("Upstream held checkpoint exceeds its bounded payload.");
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || !("kind" in parsed) || parsed.kind !== "upstream" ||
      !("version" in parsed) || parsed.version !== 2 || !("checkpoint" in parsed)) {
    throw new Error("Run carries a non-upstream or malformed checkpoint; no implicit migration is allowed.");
  }
  const result = parsed as UpstreamRunCheckpointEnvelope;
  if (result.checkpoint.version !== 2 || !result.checkpoint.pendingOperation?.operationId) throw new Error("Upstream checkpoint lacks its exact pending operation.");
  return result;
}
function initialized(answer: string, respondedBy: string): UpstreamInitConfirmation {
  let parsed: unknown;
  try { parsed = JSON.parse(answer); } catch { throw new Error("Init requires explicit structured JSON confirmation; a broad yes is not consent."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Init confirmation must be a JSON object.");
  const a = parsed as Record<string, unknown>;
  const keys = ["confirmed", "profile", "naming", "economyAccepted", "routing", "routingAccepted", "approvalChannel"];
  if (Object.keys(a).some(k => !keys.includes(k)) ||
      a.confirmed !== true || typeof a.profile !== "string" || !a.profile.trim() ||
      a.naming !== "skip" || a.approvalChannel !== "in-chat") {
    throw new Error("Init must explicitly confirm profile, routing, naming:'skip' and approvalChannel:'in-chat'.");
  }
  if (a.routing !== undefined && a.routingAccepted === true && a.economyAccepted === undefined) {
    return { confirmed: true, profile: a.profile, naming: "skip", routing: parseUpstreamRouting(a.routing),
      routingAccepted: true, approvalChannel: "in-chat", actor: respondedBy };
  }
  if (a.economyAccepted === true && a.routing === undefined && a.routingAccepted === undefined) {
    return { confirmed: true, profile: a.profile, naming: "skip", economyAccepted: true, approvalChannel: "in-chat", actor: respondedBy };
  }
  throw new Error("Init requires routingAccepted:true and an explicit routing choice; a broad yes is not consent.");
}
function responseFor(run: RunState, held: UpstreamContinuationCheckpoint): UpstreamContinuationResponse | undefined {
  if (!run.humanInput?.response) return undefined;
  if (run.humanInput.questionId !== held.pendingOperation.operationId) throw new Error("Persisted answer does not identify the exact held upstream operation.");
  const response = run.humanInput.response;
  if (!response.respondedBy?.trim() || !Number.isFinite(response.respondedAt) || !response.answer.trim() || response.answer.length > 8000) throw new Error("Human response has no valid persisted principal, timestamp or bounded answer.");
  const responseId = digest(JSON.stringify([run.runId, run.humanInput.questionId, response.respondedAt, response.respondedBy, response.answer]));
  return {
    operationId: run.humanInput.questionId, responseId, ...response,
    ...(held.pendingOperation.kind === "initialization" ? { initialization: initialized(response.answer, response.respondedBy) } : {}),
  };
}

/**
 * Adapter onto the existing held-run store, not a second approval or storage backend.
 * A running run with an active lease must be the exact snapshot returned to the parent
 * by RunStateStore.claim. This service cannot steal/reclaim an active worker's lease.
 * Parent callers must not broadcast that claim snapshot to multiple workers. Locally,
 * concurrent duplicate calls are refused; across replicas the existing store claim is
 * the exclusive worker-admission primitive.
 */
export class UpstreamRunService {
  private readonly active: Set<string>;
  constructor(private readonly options: UpstreamRunServiceOptions) {
    const active = activeStores.get(options.store) ?? new Set<string>();
    activeStores.set(options.store, active);
    this.active = active;
  }

  async run(
    run: RunState, workspace: Workspace, request: CoordinatorRequest,
    onCompletion?: (record: CompletionUsageRecord) => Promise<void>,
  ): Promise<UpstreamRunServiceResult | undefined> {
    const key = `${run.tenantId}\0${run.runId}`;
    if (this.active.has(key)) throw new Error("This upstream run already has an active service worker.");
    this.active.add(key);
    const now = this.options.now ?? Date.now;
    const store = this.options.store;
    let lease: number | undefined;
    const current = async (): Promise<RunState> => {
      const saved = await store.get(run.runId);
      if (!saved || saved.tenantId !== run.tenantId || saved.toolId !== run.toolId || isRunExpired(saved, now())) throw new Error("Run is missing, expired or belongs to another tenant/tool.");
      return saved;
    };
    const owned = async (): Promise<RunState> => {
      const saved = await current();
      if (saved.status !== "running" || saved.leaseExpiresAt !== lease || !lease || lease <= now()) throw new Error("Upstream worker no longer owns the existing run-store lease.");
      return saved;
    };
    try {
      if (workspace.tenantId !== run.tenantId || request.toolId !== run.toolId) throw new Error("Workspace/request does not match the run's validated tenant/tool.");
      const runtime = await this.options.runtimeOptions({ run, workspace, request });
      // Preserve parent native selection before taking a worker lease or writing run state.
      if (!runtime.enabled) return undefined;
      if (runtime.tenantId !== run.tenantId || runtime.runId !== run.runId || runtime.workspace.tenantId !== workspace.tenantId ||
          (request.project !== undefined && runtime.project !== request.project)) throw new Error("Runtime factory changed the authenticated run/project/workspace identity.");
      const projectRuntime = await inspectProjectRuntime(runtime.store, run.tenantId, runtime.project, runtime.bundle ?? installedUpstreamBundle());
      if (projectRuntime !== "uninitialized" && projectRuntime.runtime === "native") return undefined;
      if (request.squad) {
        throw new Error("Full upstream sub-squad execution is not wired; refusing to substitute the project's root scope.");
      }
      let persisted = await current();
      if (persisted.status === "complete" || persisted.status === "failed") throw new Error("Terminal runs cannot be replayed through the upstream service.");
      if (persisted.request !== undefined && persisted.request !== request.request) throw new Error("Continuation must preserve the persisted original request.");
      if (persisted.status === "held" && !persisted.humanInput?.response) {
        const held = envelope(persisted.advisoryCheckpoint);
        if (!held) throw new Error("Held run lacks a tagged upstream continuation.");
        return { status: "held", ownsLedger: true, runId: run.runId, humanInput: persisted.humanInput!,
          checkpoint: held.checkpoint, resumable: held.checkpoint.resumable, blocker: held.checkpoint.blocker };
      }
      if (persisted.leaseExpiresAt && persisted.leaseExpiresAt > now()) {
        if (run.status !== "running" || run.leaseExpiresAt !== persisted.leaseExpiresAt) throw new Error("Run belongs to another active worker; the exact parent claim snapshot is required.");
      } else {
        const claimed = await store.claim(run.runId, ["running", "held"], "running", { now: now() });
        if (!claimed) throw new Error("Atomic upstream worker claim conflicted.");
        persisted = claimed;
      }
      lease = persisted.leaseExpiresAt;
      if (!lease || lease - now() < 1000) throw new Error("Worker lease has insufficient time for a bounded upstream operation.");
      const original = envelope(persisted.advisoryCheckpoint);
      if (original?.consumedByLease?.leaseExpiresAt === lease) throw new Error("This upstream response is already owned by the active worker lease; duplicate service execution is refused.");
      const response = original && responseFor(persisted, original.checkpoint);
      let latestEnvelope = original;
      const save = async (checkpoint: UpstreamContinuationCheckpoint) => {
        const saved = await owned();
        if (checkpoint.tenantId !== saved.tenantId || checkpoint.runId !== saved.runId || checkpoint.project !== runtime.project) throw new Error("Checkpoint crossed its validated tenant/project/run boundary.");
        const serialized = JSON.stringify({
          kind: "upstream", version: 2, checkpoint,
          ...(latestEnvelope?.consumedByLease && checkpoint.pendingOperation.operationId === latestEnvelope.consumedByLease.operationId
            ? { consumedByLease: latestEnvelope.consumedByLease } : {}),
        } satisfies UpstreamRunCheckpointEnvelope);
        if (Buffer.byteLength(serialized) > 4000000) throw new Error("Tagged upstream checkpoint exceeds its bounded payload.");
        const write = await store.update(saved.runId, { advisoryCheckpoint: serialized });
        const verified = await owned();
        if (!write || verified.advisoryCheckpoint !== serialized) throw new Error("Durable upstream checkpoint read-back failed; no human hold is reported.");
        latestEnvelope = envelope(serialized);
      };
      const acceptResponse = async (checkpointId: string, answer: UpstreamContinuationResponse): Promise<boolean> => {
        const saved = await owned();
        const held = envelope(saved.advisoryCheckpoint);
        if (!held || held.checkpoint.checkpointId !== checkpointId || !saved.humanInput?.response) return false;
        const actual = responseFor(saved, held.checkpoint);
        if (!actual || JSON.stringify(actual) !== JSON.stringify(answer)) return false;
        const prior = held.consumedByLease;
        if (prior && (prior.operationId !== answer.operationId || prior.responseId !== answer.responseId || prior.leaseExpiresAt === lease)) return false;
        const accepted: UpstreamRunCheckpointEnvelope = {
          ...held, consumedByLease: { operationId: answer.operationId, responseId: answer.responseId, leaseExpiresAt: lease! },
        };
        const text = JSON.stringify(accepted);
        await store.update(saved.runId, { advisoryCheckpoint: text });
        if ((await owned()).advisoryCheckpoint !== text) return false;
        latestEnvelope = accepted;
        return true;
      };
      const persistence = new StoreAdvisoryPersistence(store, run.runId);
      const completionWrites: Promise<void>[] = [];
      const options: UpstreamRuntimeOptions = {
        ...runtime, workspace, tenantId: run.tenantId, runId: run.runId,
        onCompletion: record => {
          // Child SDK sessions use invocation IDs; the durable ledger belongs to the parent run.
          const attributed = { ...record, runId: run.runId };
          const write = Promise.resolve().then(async () => {
            if (onCompletion) await onCompletion(attributed);
            else await persistence.recordAttributedCompletion(attributed);
          });
          void write.catch(() => undefined);
          completionWrites.push(write);
          return write;
        },
        readCompletionUsage: async () => {
          await Promise.all(completionWrites);
          return structuredClone((await owned()).completionUsage ?? []);
        },
        profile: request.profile ?? runtime.profile,
        mode: request.mode === "autonomous" || request.mode === "autopilot" ? request.mode : runtime.mode,
        initialRequest: request.request,
        context: persisted.context ?? request.context,
        // A server enabling upstream is not project-specific Init approval.
        confirmInitialization: undefined,
        // This adapter is advisory only. run.approvedBy is deliberately not used
        // as authorization for live/cloud/tracker or other impactful actions.
        isActionablePipelineApproved: async () => false,
        deadlineMs: Math.min(runtime.deadlineMs ?? 120000, lease - now() - 500),
        continuation: { save, checkpoint: original?.checkpoint, response, acceptResponse },
        requestHumanInput: async input => {
          const held = latestEnvelope?.checkpoint;
          if (!held || held.pendingOperation.operationId !== input.operationId) throw new Error("Human question has no verified saved upstream checkpoint.");
          const human: HumanInputRequest = {
            questionId: input.operationId, question: input.question, purpose: "confirmation",
            notice: input.reason,
            ...(held.pendingOperation.kind === "initialization" ? { choices: [
              INIT_CHOICES[0].replace('"default"', JSON.stringify(held.proposal.profile)), INIT_CHOICES[1],
            ] } : {}),
          };
          // Native ResearchCheckpoint is not fabricated: executeRun returns the
          // actual saved tagged upstream checkpoint and consumes only error.input.
          throw Reflect.construct(StageInputRequired, [human, undefined]) as StageInputRequired;
        },
      };
      const outcome = await (this.options.executor ?? executeRun)(options, request.request);
      if (outcome.status === "native" || outcome.status === "not-selected") return undefined;
      const accounted = await owned();
      const usage = usageFromCompletionRecords(accounted.completionUsage);
      if (outcome.status === "held") {
        if (!latestEnvelope || latestEnvelope.checkpoint.checkpointId !== outcome.checkpoint.checkpointId) throw new Error("Held outcome lacks the last durably verified checkpoint.");
        const patch = {
          status: "held" as const, humanInput: outcome.input, holdReason: "upstream_human_input",
          leaseExpiresAt: undefined,
          stages: outcome.stages.map(s => ({ role: s.request.role, agentName: s.request.agent, artifact: s.result.text })),
        };
        await store.update(run.runId, patch);
        const verified = await current();
        if (verified.status !== "held" || verified.humanInput?.questionId !== outcome.input.questionId ||
            verified.advisoryCheckpoint !== JSON.stringify(latestEnvelope)) throw new Error("Held-run read-back failed.");
        return { status: "held", ownsLedger: true, runId: run.runId, humanInput: outcome.input,
          checkpoint: outcome.checkpoint, resumable: outcome.resumable, blocker: outcome.blocker,
          artifact: outcome.stages.map(s => s.result.text).join("\n\n") || undefined,
          usage: usage ?? aggregateBackendUsage([...(outcome.checkpoint.coordinator?.coordinatorUsage ?? []),
            ...outcome.stages.flatMap(s => s.result.usage ? [s.result.usage] : [])]) };
      }
      if (outcome.status === "complete") {
        const reportSections: string[] = [];
        for (const receipt of outcome.result.metadata.reports) {
          const stored = await runtime.store.get(run.tenantId, runtime.project, receipt.path);
          if (!stored || digest(stored.content) !== receipt.sha256) throw new Error("Completed report changed before service publication; acceptance is refused.");
          reportSections.push(`### ${receipt.path}\n\n${stored.content}`);
        }
        const artifact = [outcome.result.text, ...reportSections].join("\n\n");
        await store.update(run.runId, {
          status: "complete", artifact, failureReason: undefined,
          humanInput: undefined, advisoryCheckpoint: undefined, leaseExpiresAt: undefined,
          stages: outcome.result.stages.map(s => ({ role: s.request.role, agentName: s.request.agent, artifact: s.result.text })),
        });
        const verified = await current();
        if (verified.status !== "complete" || verified.artifact !== artifact) throw new Error("Completed upstream run did not persist.");
        return { status: "complete", ownsLedger: true, runId: run.runId, artifact,
          usage: usage ?? outcome.result.usage, result: outcome.result };
      }
      if (outcome.status !== "failed") throw new Error("Unexpected upstream execution status.");
      const artifact = `Upstream run blocked: ${outcome.detail}`;
      await store.update(run.runId, { status: "failed", failureReason: outcome.reason, artifact, leaseExpiresAt: undefined });
      const failed = await current();
      if (failed.status !== "failed" || failed.failureReason !== outcome.reason || failed.artifact !== artifact) throw new Error("Failed upstream outcome could not be persisted.");
      return { status: "failed", ownsLedger: true, runId: run.runId, reason: outcome.reason,
        artifact, usage, committedPaths: outcome.committedPaths };
    } finally {
      this.active.delete(key);
    }
  }
}
