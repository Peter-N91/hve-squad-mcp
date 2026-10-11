import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { SquadArtifact, SquadArtifactStore } from "../src/engine/artifact-store.js";
import type { CoordinatorRequest } from "../src/engine/coordinator-engine.js";
import { EphemeralRunStateStore, type RunState, type RunStateStore } from "../src/engine/run-state.js";
import { DurableRunStateStore } from "../src/engine/durable-run-state.js";
import type { Workspace } from "../src/engine/workspace.js";
import { attributeCompletion, usageFromCompletionRecords } from "../src/engine/model-backend.js";
import { copilotUsageFor } from "../src/engine/copilot/copilot-usage.js";
import { StoreAdvisoryPersistence } from "../src/engine/advisory-run-store.js";
import { installedUpstreamBundle } from "../src/engine/copilot/upstream-bundle.js";
import { InMemoryCopilotSessionStateStore } from "../src/engine/copilot/session-state-store.js";
import { executeRun, UPSTREAM_RUNTIME_EVIDENCE_MATRIX, type UpstreamRuntimeOptions } from "../src/engine/copilot/upstream-runtime.js";
import {
  UpstreamRunService, type UpstreamRunCheckpointEnvelope, type UpstreamRunServiceOptions,
} from "../src/engine/copilot/upstream-run-service.js";

const bundle = installedUpstreamBundle();
const answer = '{"confirmed":true,"profile":"default","naming":"skip","economyAccepted":true,"approvalChannel":"in-chat"}';
class Artifacts implements SquadArtifactStore {
  files = new Map<string, SquadArtifact>();
  writes = 0;
  async get(tenant: string, project: string, path: string) { return this.files.get(`${tenant}/${project}/${path}`); }
  async list(tenant: string, project: string) {
    return [...this.files.values()].filter(a => a.tenantId === tenant && a.project === project).map(a => ({ path: a.path, size: a.content.length, updatedAt: a.updatedAt }));
  }
  async put(tenantId: string, project: string, path: string, content: string) {
    const artifact = { tenantId, project, path, content, etag: String(++this.writes), updatedAt: Date.now() };
    this.files.set(`${tenantId}/${project}/${path}`, artifact);
    return { ok: true as const, artifact };
  }
  async append(tenant: string, project: string, path: string, content: string) {
    return (await this.put(tenant, project, path, ((await this.get(tenant, project, path))?.content ?? "") + content)).artifact;
  }
}
async function fixture() {
  const runs = new EphemeralRunStateStore(), artifacts = new Artifacts();
  const created = await runs.create({ tenantId: "tenant", toolId: "squad_run" });
  const req: CoordinatorRequest = { toolId: "squad_run", project: "project-a", request: "Make an advisory report.", context: "The original brief requires weekly refresh." };
  const run = (await runs.update(created.runId, { request: req.request, approvedBy: "outer-operator", approvedAt: 100 }))!;
  const workspace: Workspace = { id: "workspace", tenantId: "tenant", root: process.cwd(), resolve: p => p, dispose: async () => undefined };
  let seededConfirmations = 0;
  const options: UpstreamRunServiceOptions = {
    store: runs,
    runtimeOptions: ({ run: current, workspace: w }): UpstreamRuntimeOptions => ({
      enabled: true, tenantId: current.tenantId, project: "project-a", runId: current.runId,
      workspace: w, store: artifacts, bundle, sessionState: new InMemoryCopilotSessionStateStore(),
      client: { createSession: async () => { throw new Error("No runtime should open before Init confirmation."); } },
      modelIds: ["gpt-5.4", "gpt-5.4-mini", "gpt-5.6-sol"], coordinatorModel: "gpt-5.6-sol",
      gitHubToken: "test-only-operator-credential",
      confirmInitialization: async () => {
        seededConfirmations++;
        return { confirmed: true, profile: "default", naming: "skip", economyAccepted: true, approvalChannel: "in-chat", actor: "synthetic-operator" };
      },
      continuation: { save: async () => { throw new Error("Must bind existing run-store checkpoint seam."); } },
      requestHumanInput: async () => { throw new Error("Must bind real service human-input seam."); },
      isActionablePipelineApproved: async () => true,
    }),
  };
  return { runs, artifacts, run, req, workspace, options, syntheticCalls: () => seededConfirmations };
}
function parseCheckpoint(run: RunState): UpstreamRunCheckpointEnvelope {
  return JSON.parse(run.advisoryCheckpoint!);
}

test("real executeRun Init binds the existing run store and holds without synthetic operator consent", async () => {
  const f = await fixture();
  const result = await new UpstreamRunService(f.options).run(f.run, f.workspace, f.req);
  assert.equal(result?.status, "held");
  if (result?.status !== "held") throw new Error("held");
  const saved = (await f.runs.get(f.run.runId))!;
  assert.equal(saved.status, "held");
  assert.equal(saved.humanInput?.questionId, result.checkpoint.pendingOperation.operationId);
  assert.equal(saved.humanInput?.purpose, "confirmation");
  assert.match(saved.humanInput!.choices![0], /routingAccepted/);
  assert.equal(saved.approvedBy, "outer-operator", "existing auth/approval fields preserved");
  assert.equal(saved.approvedAt, 100);
  assert.equal(f.syntheticCalls(), 0, "factory's synthetic Init confirmation was never trusted");
  assert.equal(f.artifacts.writes, 0, "new project untouched until actual Init response");
  assert.equal(result.resumable, true);
  const tagged = parseCheckpoint(saved);
  assert.equal(tagged.kind, "upstream");
  assert.equal(tagged.version, 2);
  assert.equal(tagged.checkpoint.request, f.req.request);
  const repeated = await new UpstreamRunService(f.options).run(saved, f.workspace, f.req);
  assert.equal(repeated?.status, "held");
  assert.equal(f.artifacts.writes, 0);
});

test("persisted explicit Init response is mapped to actual subject and consumed only under the parent atomic worker lease", async () => {
  const f = await fixture();
  const service = new UpstreamRunService(f.options);
  const held = await service.run(f.run, f.workspace, f.req);
  if (held?.status !== "held") throw new Error("held");
  const respondedAt = 1760000000123;
  const answered = await f.runs.answerInput(f.run.runId, held.humanInput.questionId, {
    answer, respondedBy: "validated-tenant-subject", respondedAt,
  });
  assert.ok(answered);
  const claimed = await f.runs.claim(f.run.runId, ["running"], "running");
  assert.ok(claimed?.leaseExpiresAt);
  let actualResponseId = "";
  const completion: NonNullable<UpstreamRunServiceOptions["executor"]> = async (options, request) => {
    assert.equal(request, f.req.request);
    assert.equal(options.context, f.req.context);
    assert.equal(options.gitHubToken, "test-only-operator-credential");
    assert.equal(await options.isActionablePipelineApproved(), false, "outer approvedBy is not business/cloud authorization");
    const response = options.continuation.response!;
    assert.equal(response.respondedBy, "validated-tenant-subject");
    assert.equal(response.respondedAt, respondedAt);
    assert.equal(response.initialization?.actor, "validated-tenant-subject");
    assert.equal(response.initialization?.profile, "default");
    actualResponseId = response.responseId;
    const checkpoint = options.continuation.checkpoint!;
    assert.equal(await options.continuation.acceptResponse!(checkpoint.checkpointId, response), true);
    assert.equal(await options.continuation.acceptResponse!(checkpoint.checkpointId, response), false, "same-lease response cannot be consumed twice");
    await options.continuation.save({ ...checkpoint, phase: "accepted", acceptedAnswers: [response], confirmation: response.initialization });
    const accepted = parseCheckpoint((await f.runs.get(f.run.runId))!);
    assert.equal(accepted.consumedByLease?.responseId, response.responseId);
    return {
      status: "complete", ownsLedger: true, evidenceMatrix: UPSTREAM_RUNTIME_EVIDENCE_MATRIX,
      result: {
        backendId: "copilot-sdk", text: "Verified advisory report.", finishReason: "stop", stages: [],
        usage: { inputTokens: 12, outputTokens: 4, costStatus: "unavailable" },
        metadata: { upstreamCommit: bundle.identity.sourceCommit, upstreamVersion: bundle.identity.declaredVersion,
          rolloutVersion: "0.19.0-pre", routing: "economy", outcome: "accepted", gaps: [], reports: [],
          verification: { verdict: "Pass", reviewerStageId: "review", ownerStageId: "owner", readHashes: [],
            reviewReceipt: { path: "docs/review.md", sha256: "0".repeat(64) }, findings: [], approvedActionablePipeline: false },
          events: [], productionSmokeVerified: false, ownsLedger: true },
      },
    };
  };
  const result = await new UpstreamRunService({ ...f.options, executor: completion }).run(claimed!, f.workspace, f.req);
  assert.equal(result?.status, "complete");
  assert.ok(/^[a-f0-9]{64}$/.test(actualResponseId));
  const saved = (await f.runs.get(f.run.runId))!;
  assert.equal(saved.status, "complete");
  assert.equal(saved.artifact, "Verified advisory report.");
  assert.equal(saved.advisoryCheckpoint, undefined);
  assert.equal(saved.humanInput, undefined);
  assert.equal(saved.approvedBy, "outer-operator");
  assert.equal(saved.completionUsage, undefined, "service never overwrites parent's provider-attempt accounting");
  await assert.rejects(new UpstreamRunService({ ...f.options, executor: completion }).run(claimed!, f.workspace, f.req), /Terminal runs/);
});

test("broad yes and caller-supplied actor fields cannot become project Init confirmation", async () => {
  for (const response of ["yes", '{"confirmed":true,"profile":"default","naming":"skip","economyAccepted":true,"approvalChannel":"in-chat","actor":"spoofed"}']) {
    const f = await fixture();
    const held = await new UpstreamRunService(f.options).run(f.run, f.workspace, f.req);
    if (held?.status !== "held") throw new Error("held");
    await f.runs.answerInput(f.run.runId, held.humanInput.questionId, { answer: response, respondedBy: "real-subject", respondedAt: 100 });
    const claimed = (await f.runs.claim(f.run.runId, ["running"], "running"))!;
    await assert.rejects(new UpstreamRunService(f.options).run(claimed, f.workspace, f.req), /explicit|structured/);
    assert.equal(f.artifacts.writes, 0);
  }
});

for (const routing of [{ mode: "ranked" }, { mode: "economy" }, { mode: "manual", model: "gpt-5.4" }]) {
  test(`durable Init response preserves the actual user's ${routing.mode} routing choice`, async () => {
    const f = await fixture();
    const held = await new UpstreamRunService(f.options).run(f.run, f.workspace, f.req);
    if (held?.status !== "held") throw new Error("held");
    await f.runs.answerInput(f.run.runId, held.humanInput.questionId, {
      answer: JSON.stringify({ confirmed: true, profile: "default", naming: "skip", routing, routingAccepted: true, approvalChannel: "in-chat" }),
      respondedBy: "verified-user", respondedAt: Date.now(),
    });
    const claimed = await f.runs.claim(f.run.runId, ["running"], "running");
    assert.ok(claimed);
    let observed = false;
    await assert.rejects(new UpstreamRunService({
      ...f.options, executor: async options => {
        const confirmation = options.continuation.response?.initialization;
        assert.deepEqual(confirmation?.routing, routing);
        assert.equal(confirmation?.routingAccepted, true);
        assert.equal(confirmation?.actor, "verified-user");
        observed = true;
        throw new Error("Probe stopped after validating the routing response.");
      },
    }).run(claimed, f.workspace, f.req), /Probe stopped/);
    assert.equal(observed, true);
    assert.equal(f.artifacts.writes, 0);
  });
}
test("native projects return undefined before claims/mutations and retain native schema", async () => {
  const f = await fixture();
  await f.artifacts.put("tenant", "project-a", ".copilot-tracking/squad/state.json", '{"schemaVersion":"native"}');
  const before = structuredClone(await f.runs.get(f.run.runId));
  assert.equal(await new UpstreamRunService(f.options).run(f.run, f.workspace, f.req), undefined);
  assert.deepEqual(await f.runs.get(f.run.runId), before);
  assert.equal(f.artifacts.writes, 1);
});

test("an upstream request cannot silently substitute the root project for a sub-squad scope", async () => {
  const f = await fixture();
  await assert.rejects(new UpstreamRunService(f.options).run(f.run, f.workspace, { ...f.req, squad: "child" }),
    /refusing to substitute the project's root scope/);
  assert.equal(f.artifacts.writes, 0);
});
test("checkpoint save read-back must succeed before the service reports held", async () => {
  const f = await fixture();
  const store: RunStateStore = {
    ...f.runs,
    kind: f.runs.kind, create: f.runs.create.bind(f.runs), get: f.runs.get.bind(f.runs), delete: f.runs.delete.bind(f.runs),
    answerInput: f.runs.answerInput.bind(f.runs), claim: f.runs.claim.bind(f.runs),
    listClaimable: f.runs.listClaimable.bind(f.runs), sweepExpired: f.runs.sweepExpired.bind(f.runs),
    update: async (id, patch) => patch.advisoryCheckpoint ? f.runs.get(id) : f.runs.update(id, patch),
  };
  const result = await new UpstreamRunService({ ...f.options, store }).run(f.run, f.workspace, f.req);
  assert.equal(result?.status, "failed");
  assert.equal((await f.runs.get(f.run.runId))!.humanInput, undefined);
});

test("wrong tenant, stale worker lease and concurrent calls are refused", async () => {
  const f = await fixture();
  const claimed = (await f.runs.claim(f.run.runId, ["running"], "running"))!;
  await assert.rejects(new UpstreamRunService(f.options).run(f.run, f.workspace, f.req), /another active worker/);
  await assert.rejects(new UpstreamRunService(f.options).run(claimed, { ...f.workspace, tenantId: "other" }, f.req), /validated tenant/);
  let unblock!: () => void;
  const pending = new Promise<void>(resolve => { unblock = resolve; });
  const service = new UpstreamRunService({ ...f.options, runtimeOptions: async context => { await pending; return f.options.runtimeOptions(context); } });
  const first = service.run(claimed, f.workspace, f.req);
  await assert.rejects(service.run(claimed, f.workspace, f.req), /active service worker/);
  await assert.rejects(new UpstreamRunService(f.options).run(claimed, f.workspace, f.req), /active service worker/);
  unblock();
  assert.equal((await first)?.status, "held");
});

test("subsequent human responses retain real operation IDs without applying Init JSON rules", async () => {
  const f = await fixture();
  const initial = await new UpstreamRunService(f.options).run(f.run, f.workspace, f.req);
  if (initial?.status !== "held") throw new Error("held");
  const saved = (await f.runs.get(f.run.runId))!;
  const tagged = parseCheckpoint(saved);
  tagged.checkpoint.pendingOperation = { operationId: "scoped-action", kind: "coordinator-human", question: "Clarify scope?", reason: "Scoped clarification." };
  await f.runs.update(f.run.runId, { advisoryCheckpoint: JSON.stringify(tagged),
    humanInput: { questionId: "scoped-action", question: "Clarify scope?", purpose: "clarification" } });
  await f.runs.answerInput(f.run.runId, "scoped-action", { answer: "Report only; no live changes.", respondedBy: "real-subject", respondedAt: 456 });
  const claimed = (await f.runs.claim(f.run.runId, ["running"], "running"))!;
  const executor: typeof executeRun = async options => {
    assert.equal(options.continuation.response?.operationId, "scoped-action");
    assert.equal(options.continuation.response?.initialization, undefined);
    assert.equal(options.continuation.response?.respondedBy, "real-subject");
    assert.equal(await options.continuation.acceptResponse!(tagged.checkpoint.checkpointId, options.continuation.response!), true);
    return { status: "failed", ownsLedger: true, reason: "missing_connector",
      detail: "The required connector is unavailable; no action was invented.", stages: [], committedPaths: [],
      evidenceMatrix: UPSTREAM_RUNTIME_EVIDENCE_MATRIX };
  };
  const result = await new UpstreamRunService({ ...f.options, executor }).run(claimed, f.workspace, f.req);
  assert.equal(result?.status, "failed");
  if (result?.status === "failed") assert.equal(result.reason, "missing_connector");
  assert.equal((await f.runs.get(f.run.runId))!.approvedBy, "outer-operator");
});

test("upstream failed runs retain coordinator, child and helper credits on the root run across fresh services", async () => {
  const f = await fixture();
  const executor: typeof executeRun = async options => {
    assert.equal((await options.readCompletionUsage!()).length, 0);
    for (const [actor, invocation] of [
      ["Squad Coordinator", f.run.runId],
      ["Squad Implementor", `${f.run.runId}-child`],
      ["RPI Researcher", `${f.run.runId}-helper`],
    ]) {
      const record = attributeCompletion({
        eventId: actor, attempt: 1, outcome: "completed", backendId: "copilot-sdk",
        usage: copilotUsageFor({ inputTokens: 100, outputTokens: 20, copilotUsage: { totalNanoAiu: 500_000_000 } }),
      }, { runId: invocation, stage: actor, actor });
      await options.onCompletion!(record);
      await options.onCompletion!(record);
    }
    assert.equal((await options.readCompletionUsage!()).length, 3);
    return { status: "failed", ownsLedger: true, reason: "upstream_execution_failed",
      detail: "Coordinator stopped without verified finish.", stages: [], committedPaths: [],
      evidenceMatrix: UPSTREAM_RUNTIME_EVIDENCE_MATRIX };
  };
  const result = await new UpstreamRunService({ ...f.options, executor }).run(f.run, f.workspace, f.req);
  assert.equal(result?.status, "failed");
  assert.equal(result?.usage?.inputTokens, 300);
  assert.equal(result?.usage?.hostBilledCredits, 1.5);
  assert.equal(result?.usage?.billingStatus, "complete");
  const saved = (await f.runs.get(f.run.runId))!;
  assert.equal(saved.completionUsage?.length, 3, "replayed provider events count once");
  assert.ok(saved.completionUsage?.every(record => record.runId === f.run.runId));
  assert.deepEqual(saved.completionUsage?.map(record => record.actor), ["Squad Coordinator", "Squad Implementor", "RPI Researcher"]);
  assert.deepEqual(usageFromCompletionRecords(saved.completionUsage), result?.usage);
});

test("upstream service forwards root-attributed usage to the parent's existing accounting observer", async () => {
  const f = await fixture();
  const persistence = new StoreAdvisoryPersistence(f.runs, f.run.runId);
  const observed: string[] = [];
  const executor: typeof executeRun = async options => {
    await options.onCompletion!(attributeCompletion({
      eventId: "child-event", attempt: 1, outcome: "completed", backendId: "copilot-sdk",
      usage: copilotUsageFor({ inputTokens: 7, outputTokens: 3 }),
    }, { runId: "child-invocation", stage: "Squad Implementor", actor: "Squad Implementor" }));
    return { status: "failed", ownsLedger: true, reason: "stage_failed", detail: "Blocked stage.",
      stages: [], committedPaths: [], evidenceMatrix: UPSTREAM_RUNTIME_EVIDENCE_MATRIX };
  };
  const result = await new UpstreamRunService({ ...f.options, executor }).run(f.run, f.workspace, f.req, async record => {
    observed.push(record.runId);
    await persistence.recordAttributedCompletion(record);
  });

  assert.deepEqual(observed, [f.run.runId]);
  assert.equal(result?.usage?.inputTokens, 7);
  assert.equal(result?.usage?.billingStatus, "unavailable");
});

test("a held run's previous completion records survive a fresh service and subsequent failed continuation", async () => {
  const f = await fixture();
  const initial = await new UpstreamRunService(f.options).run(f.run, f.workspace, f.req);
  if (initial?.status !== "held") throw new Error("held");
  const persistence = new StoreAdvisoryPersistence(f.runs, f.run.runId);
  const prior = attributeCompletion({
    eventId: "before-hold", attempt: 1, outcome: "completed", backendId: "copilot-sdk",
    usage: copilotUsageFor({ inputTokens: 100, outputTokens: 20, copilotUsage: { totalNanoAiu: 500_000_000 } }),
  }, { runId: f.run.runId, stage: "Squad Coordinator", actor: "Squad Coordinator" });
  await persistence.recordAttributedCompletion(prior);
  await f.runs.answerInput(f.run.runId, initial.humanInput.questionId, { answer, respondedBy: "subject", respondedAt: 100 });
  const claimed = (await f.runs.claim(f.run.runId, ["running"], "running"))!;
  const executor: typeof executeRun = async options => {
    assert.equal((await options.readCompletionUsage!()).length, 1, "durable snapshot includes prior held usage");
    await options.onCompletion!(prior);
    const pending = options.onCompletion!({ ...prior, eventId: "after-hold" });
    assert.equal((await options.readCompletionUsage!()).length, 2, "snapshot drains pending accounting writes");
    await pending;
    return { status: "failed", ownsLedger: true, reason: "stage_failed", detail: "Blocked continuation.",
      stages: [], committedPaths: [], evidenceMatrix: UPSTREAM_RUNTIME_EVIDENCE_MATRIX };
  };
  const result = await new UpstreamRunService({ ...f.options, executor }).run(claimed, f.workspace, f.req);
  assert.equal(result?.usage?.inputTokens, 200);
  assert.equal(result?.usage?.hostBilledCredits, 1);
  assert.equal((await f.runs.get(f.run.runId))!.completionUsage?.length, 2);
});

test("tagged upstream checkpoint and real Init response survive a fresh durable run-store instance", async () => {
  const path = join(process.cwd(), ".upstream-run-service-tests-" + randomUUID());
  mkdirSync(path);
  try {
    const f = await fixture();
    const durable = new DurableRunStateStore({ baseDir: path });
    const run = await durable.create({ tenantId: "tenant", toolId: "squad_run" });
    await durable.update(run.runId, { request: f.req.request, approvedBy: "outer-operator", approvedAt: 100 });
    const service = new UpstreamRunService({ ...f.options, store: durable });
    const result = await service.run(run, f.workspace, f.req);
    if (result?.status !== "held") throw new Error("held");
    const reloaded = new DurableRunStateStore({ baseDir: path });
    const held = (await reloaded.get(run.runId))!;
    assert.equal(parseCheckpoint(held).kind, "upstream");
    assert.equal(held.humanInput?.questionId, result.checkpoint.pendingOperation.operationId);
    await reloaded.answerInput(run.runId, held.humanInput!.questionId, { answer, respondedBy: "validated-subject", respondedAt: 1234 });
    const later = new DurableRunStateStore({ baseDir: path });
    const answered = (await later.get(run.runId))!;
    assert.equal(answered.humanInput?.response?.respondedBy, "validated-subject");
    assert.equal(answered.humanInput?.response?.respondedAt, 1234);
    assert.equal(parseCheckpoint(answered).checkpoint.request, f.req.request);
    assert.equal(answered.approvedBy, "outer-operator");
    assert.equal(f.artifacts.writes, 0);
  } finally { rmSync(path, { recursive: true, force: true }); }
});
