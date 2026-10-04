import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";

import { loadCatalog } from "../src/catalog/catalog.js";
import { encodeAdvisoryCheckpoint, decodeAdvisoryCheckpoint, readAdvisoryCheckpoint } from "../src/engine/advisory-checkpoint.js";
import { runAdvisoryPipeline } from "../src/engine/advisory-pipeline.js";
import { MemoryBackedArtifactStore } from "../src/engine/artifact-store.js";
import { FileSquadMemoryStore } from "../src/engine/backends/file-squad-memory.js";
import { AutoMemory } from "../src/engine/auto-memory.js";
import { DurableRunStateStore } from "../src/engine/durable-run-state.js";
import { EmbeddedCoordinator } from "../src/engine/embedded.js";
import { RunStoreApprovalChannel, TenantQuotaTracker } from "../src/engine/gates.js";
import type { BackendRequest, BackendResult, ModelBackend } from "../src/engine/model-backend.js";
import { ModelBackendError } from "../src/engine/model-backend.js";
import { ResearchRuntime, StageBlockedError, StageInputRequired, type ResearchCheckpoint } from "../src/engine/research-runtime.js";
import { EphemeralWorkspaceManager } from "../src/engine/workspace.js";
import { renderEmbeddedResult } from "../src/engine/render-embedded.js";

const persona = { role: "Test Adviser", charter: "Read pinned guidance and ask the user before writing advice.", applyTo: [] };
const request = { toolId: "squad_run", request: "Prepare advice", context: "Refresh frequency is unresolved." };
const ctx = { auth: { tenantId: "tenant-a", subject: "human-a", scopes: ["Squad.Run"], audience: "test" } };
const call = (name: string, args: Record<string, unknown>): BackendResult => ({
  text: "", backendId: "scripted", finishReason: "tool_calls", usage: { estimatedCostUsd: 0.01 },
  toolCalls: [{ id: `${name}-id`, name, arguments: JSON.stringify(args) }],
});
const ask = () => call("request_human_input", {
  question: "Should the dashboard refresh weekly or live?", purpose: "clarification",
  choices: ["Weekly", "Live"], notice: "This is draft advice; stakeholder signoff is still required.",
});

class ScriptedBackend implements ModelBackend {
  readonly id = "scripted";
  readonly supportsTools = true;
  readonly seen: BackendRequest[] = [];
  constructor(private readonly script: ((input: BackendRequest) => BackendResult)[]) {}
  async complete(input: BackendRequest): Promise<BackendResult> {
    this.seen.push(structuredClone({ ...input, signal: undefined }));
    const next = this.script.shift();
    assert.ok(next, "Unexpected model call");
    return next(input);
  }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "human-handoff-"));
  const githubRoot = join(root, "cast");
  await mkdir(join(githubRoot, "instructions"), { recursive: true });
  await writeFile(join(githubRoot, "instructions", "notice.instructions.md"), "Pinned authority: ask before phase work.");
  const manager = new EphemeralWorkspaceManager({ baseDir: join(root, "workspaces") });
  const memory = new FileSquadMemoryStore({ baseDir: join(root, "memory") });
  const store = new MemoryBackedArtifactStore(memory);
  return { root, githubRoot, manager, memory, store, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("native question pauses before downstream work and restores exact actor/tool history on a new workspace", async () => {
  const f = await setup();
  const first = await f.manager.allocate("tenant-a");
  const primary = ".copilot-tracking/reviews/test-adviser/run-a/artifact.md";
  let downstream = 0;
  let previous = 0;
  const backend = new ScriptedBackend([
    () => call("load_instruction", { path: "notice.instructions.md" }),
    () => call("write_artifact", { path: primary, content: "# Draft\n\nRefresh unresolved." }),
    () => ask(),
    (input) => {
      assert.match(input.system, /Pinned authority: ask before phase work/);
      assert.equal(input.messages.at(-1)?.role, "tool");
      assert.equal(input.messages.at(-1)?.toolCallId, "request_human_input-id");
      assert.match(input.messages.at(-1)?.content ?? "", /Weekly/);
      assert.match(input.messages.at(-1)?.content ?? "", /"authority":false/);
      return call("write_artifact", { path: primary, content: "# Advice\n\nUse weekly refresh; no stakeholder signoff inferred." });
    },
    () => call("finish_stage", { status: "complete", readiness: "ready-with-gaps", summary: "Draft advice", artifactPaths: [primary], evidenceIds: [] }),
  ]);
  try {
    const runtime = new ResearchRuntime({ backend, workspace: first, store: f.store, project: "project-a", runId: "run-a", githubRoot: f.githubRoot, allowHumanInput: true });
    const plan = [
      { kind: "persona" as const, role: "Before", persona: { role: "Before", charter: "Initial advice", applyTo: [] } },
      { kind: "persona" as const, role: persona.role, persona },
      { kind: "persona" as const, role: "Next", persona: { role: "Next", charter: "Review", applyTo: [] } },
    ];
    const result = await runAdvisoryPipeline(request, { backend, stageExecutor: {
      execute: (p, req, prior, key, ledger) => {
        if (p.role === "Before") { previous++; return Promise.resolve({ text: "Initial advice", backendId: "scripted", finishReason: "stop" }); }
        if (p.role === "Next") { downstream++; return Promise.resolve({ text: "Reviewed", backendId: "scripted", finishReason: "stop" }); }
        return runtime.execute(p, req, prior, key, ledger);
      },
    } }, { mode: "autopilot", plan });
    assert.equal(result.outcome, "held");
    assert.equal(result.reason, "awaiting human input");
    assert.equal(downstream, 0);
    assert.equal(result.stages.length, 1);
    assert.ok(result.humanInput && result.checkpoint && result.resume);
    const saved = readAdvisoryCheckpoint(encodeAdvisoryCheckpoint({ version: 1, request, resume: result.resume, stage: result.checkpoint }));
    assert.equal(saved.stage.stageCalls, 3);
    assert.equal(saved.stage.stageTools, 3);
    await first.dispose();
    const second = await f.manager.allocate("tenant-a");
    try {
      const resumed = new ResearchRuntime({ backend, workspace: second, store: f.store, project: "project-a", runId: "run-a", githubRoot: f.githubRoot, allowHumanInput: true,
        continuation: { checkpoint: saved.stage, response: { answer: "Weekly", respondedBy: "human-a", respondedAt: Date.now() } } });
      const completed = await runAdvisoryPipeline(request, { backend, stageExecutor: {
        execute: (p, req, prior, key, ledger) => {
          if (p.role === "Before") { previous++; return Promise.resolve({ text: "Initial advice", backendId: "scripted", finishReason: "stop" }); }
          if (p.role === "Next") { downstream++; return Promise.resolve({ text: "Reviewed", backendId: "scripted", finishReason: "stop" }); }
          return resumed.execute(p, req, prior, key, ledger);
        },
      } }, { mode: "autopilot", resume: saved.resume });
      assert.equal(completed.outcome, "completed");
      assert.equal(downstream, 1);
      assert.equal(previous, 1, "The completed stage must not be repeated after the handoff.");
      assert.equal(backend.seen.length, 5);
      assert.match((await f.store.get("tenant-a", "project-a", primary))?.content ?? "", /weekly refresh/);
    } finally { await second.dispose(); }
  } finally { await first.dispose(); await f.cleanup(); }
});

test("durable coordinator handoff survives restart, blocks operator bypass and resumes the same run", async () => {
  const f = await setup();
  const sourceContext = `${request.context}\n${randomBytes(180_000).toString("base64")}`;
  let primary = "";
  const backend = new ScriptedBackend([
    () => ask(),
    (input) => {
      assert.match(input.messages.at(-1)?.content ?? "", /Weekly/);
      return call("write_artifact", { path: primary, content: "# Advice\n\nWeekly refresh." });
    },
    () => call("finish_stage", { status: "complete", readiness: "ready", summary: "Advice completed", artifactPaths: [primary], evidenceIds: [] }),
  ]);
  const make = () => {
    const runs = new DurableRunStateStore({ baseDir: join(f.root, "runs") });
    const coordinator = new EmbeddedCoordinator({
      backend, workspaceManager: f.manager, runStateStore: runs, approvals: new RunStoreApprovalChannel(runs),
      quota: new TenantQuotaTracker({ concurrency: 2, monthlyCeilingUsd: 1 }),
      runTtlMs: 7 * 24 * 60 * 60 * 1000,
      autoMemory: new AutoMemory({ store: f.memory, defaultProject: "project-a" }),
      stageExecutorFactory: (workspace, project, runId, options) => {
        assert.equal(project, "project-a");
        primary = `.copilot-tracking/reviews/test-adviser/${runId}/artifact.md`;
        const runtime = new ResearchRuntime({ backend, workspace, store: f.store, project: "project-a", runId, githubRoot: f.githubRoot, ...options });
        return { execute: (_p, req, prior, _key, ledger) => runtime.execute(persona, req, prior, undefined, ledger) };
      },
    });
    return { runs, coordinator };
  };
  try {
    const one = make();
    const tool = loadCatalog().tools.find((entry) => entry.id === "squad_federate");
    assert.ok(tool);
    const started = await one.coordinator.startHttpRun(tool, { ...request, context: sourceContext, toolId: tool.id, project: "project-a", squad: "demo" }, ctx);
    assert.ok(started.runId);
    assert.equal((await one.coordinator.approveRun(started.runId, ctx)).ok, true);
    const paused = await one.coordinator.pollRun(started.runId, ctx);
    assert.equal(paused.reason, "awaiting human input");
    assert.ok(paused.humanInput);
    assert.ok(Buffer.from((await one.runs.get(started.runId))!.advisoryCheckpoint!, "base64").length > 96_000);
    assert.ok(paused.expiresAt && paused.expiresAt > Date.now());
    const questionId = paused.humanInput.questionId;
    const two = make();
    assert.equal((await two.coordinator.pollRun(started.runId, ctx)).humanInput?.questionId, questionId);
    assert.equal((await two.coordinator.runToCompletion(started.runId, request, ctx)).humanInput?.questionId, questionId);
    assert.equal((await two.coordinator.resumeRun(started.runId, request, ctx)).humanInput?.questionId, questionId);
    assert.equal(backend.seen.length, 1);
    assert.equal((await two.coordinator.approveRun(started.runId, ctx)).ok, false);
    assert.equal((await two.coordinator.listClaimableRuns()).length, 0);
    const wrongTenant = { auth: { ...ctx.auth, tenantId: "tenant-b" } };
    assert.equal((await two.coordinator.respondToHumanInput(started.runId, questionId, "Weekly", wrongTenant)).accepted, false);
    assert.equal((await two.coordinator.respondToHumanInput(started.runId, "wrong", "Weekly", ctx)).accepted, false);
    const rendered = renderEmbeddedResult(paused);
    assert.match(rendered.content[0].text, /stakeholder signoff is still required/);
    assert.match(rendered.content[0].text, /squad_respond/);
    assert.match(rendered.content[0].text, /leave the decision pending/);
    assert.match(rendered.content[0].text, /Run retention expires at/);
    assert.doesNotMatch(rendered.content[0].text, /squad_approve|advisoryCheckpoint|toolCallId/);
    assert.deepEqual(rendered.structuredContent?.humanInput, paused.humanInput);
    const collaborator = { auth: { ...ctx.auth, subject: "human-collaborator" } };
    const receipt = await two.coordinator.respondToHumanInput(started.runId, questionId, "Weekly", collaborator);
    assert.equal(receipt.accepted, true);
    assert.equal(receipt.respondedBy, "human-collaborator");
    assert.deepEqual(await two.coordinator.respondToHumanInput(started.runId, questionId, "Weekly", collaborator), receipt);
    assert.equal((await two.coordinator.respondToHumanInput(started.runId, questionId, "Live", ctx)).accepted, false);
    const three = make();
    const completed = await three.coordinator.pollRun(started.runId, ctx);
    assert.equal(completed.runId, started.runId);
    assert.equal(completed.outcome, "completed");
    assert.equal((await three.runs.get(started.runId))?.advisoryCheckpoint, undefined);
    assert.equal((await three.runs.get(started.runId))?.history?.length, 1);
    assert.equal(backend.seen.length, 3);
    assert.deepEqual(await three.coordinator.respondToHumanInput(started.runId, questionId, "Weekly", collaborator), receipt);
  } finally { await f.cleanup(); }
});

for (const kind of ["input_too_large", "content_policy", "upstream", "invalid_request"] as const) {
  test(`post-confirmation ${kind} failure remains diagnosable after restart without replaying the run`, async () => {
    const f = await setup();
    let primary = "";
    const backend = new ScriptedBackend([
      () => ask(),
      () => call("write_artifact", { path: primary, content: "# Persisted draft\n\nIndependent review pending." }),
      () => { throw new ModelBackendError(kind, {
        status: kind === "upstream" ? 500 : 400,
        providerCode: kind === "upstream" ? "InternalServerError" : "sensitive-provider-payload",
        providerRequestId: "request_12345678",
        ...(kind === "content_policy" ? { contentPolicy: {
          direction: "prompt" as const,
          categories: [{ name: "violence", filtered: true, severity: "low" as const }],
          providerRequestId: "request_12345678",
        } } : {}),
      }); },
    ]);
    const make = () => {
      const runs = new DurableRunStateStore({ baseDir: join(f.root, "runs") });
      const coordinator = new EmbeddedCoordinator({
        backend, workspaceManager: f.manager, runStateStore: runs, approvals: new RunStoreApprovalChannel(runs),
        quota: new TenantQuotaTracker({ concurrency: 2, monthlyCeilingUsd: 1 }),
        autoMemory: new AutoMemory({ store: f.memory, defaultProject: "project-a" }),
        stageExecutorFactory: (workspace, _project, runId, options) => {
          primary = `.copilot-tracking/reviews/test-adviser/${runId}/artifact.md`;
          const runtime = new ResearchRuntime({ backend, workspace, store: f.store, project: "project-a", runId, githubRoot: f.githubRoot, ...options });
          return { execute: (_p, req, prior, _key, ledger) => runtime.execute(persona, req, prior, undefined, ledger) };
        },
      });
      return { runs, coordinator };
    };
    try {
      const one = make();
      const tool = loadCatalog().tools.find((entry) => entry.id === "squad_federate")!;
      const started = await one.coordinator.startHttpRun(tool, { ...request, toolId: tool.id, project: "project-a", squad: "demo" }, ctx);
      assert.ok(started.runId);
      await one.coordinator.approveRun(started.runId, ctx);
      const paused = await one.coordinator.pollRun(started.runId, ctx);
      assert.ok(paused.humanInput);
      const receipt = await one.coordinator.respondToHumanInput(started.runId, paused.humanInput.questionId, "Weekly", ctx);
      assert.equal(receipt.accepted, true);
      await assert.rejects(one.coordinator.pollRun(started.runId, ctx));
      const two = make();
      const failed = await two.coordinator.pollRun(started.runId, ctx);
      assert.equal(failed.outcome, "denied");
      assert.equal(failed.reason, `model_backend_${kind}`);
      assert.match(failed.artifact ?? "", /- failed/);
      assert.ok(failed.artifact?.includes(kind));
      assert.doesNotMatch(JSON.stringify(failed), /sensitive-provider-payload/);
      assert.equal(failed.humanInput, undefined);
      if (kind === "content_policy") {
        assert.equal(failed.responsibleAi?.runId, started.runId);
        assert.equal(failed.responsibleAi?.cause, "provider_content_policy");
        assert.equal(failed.responsibleAi?.direction, "prompt");
        assert.deepEqual(failed.responsibleAi?.categories, [{ name: "violence", filtered: true, severity: "low" }]);
        assert.equal(failed.responsibleAi?.providerRequestId, "request_12345678");
        assert.equal(failed.responsibleAi?.terminal, true);
        assert.equal(failed.responsibleAi?.sameRunResumable, false);
        assert.equal(failed.responsibleAi?.acknowledgmentCanOverride, false);
        assert.deepEqual((await two.coordinator.pollRun(started.runId, ctx)).responsibleAi, failed.responsibleAi);
      } else {
        assert.equal(failed.responsibleAi, undefined);
        assert.equal(failed.modelFailure?.kind, kind);
        assert.equal(failed.modelFailure?.runId, started.runId);
        assert.notEqual(failed.modelFailure?.stage, "unknown");
        assert.equal(failed.modelFailure?.providerStatus, kind === "upstream" ? 500 : 400);
        assert.equal(failed.modelFailure?.providerCode, kind === "upstream" ? "internalservererror" : undefined);
        assert.equal(failed.modelFailure?.providerRequestId, "request_12345678");
        assert.equal(failed.modelFailure?.sameRunResumable, false);
        assert.deepEqual((await two.coordinator.pollRun(started.runId, ctx)).modelFailure, failed.modelFailure);
        const rendered = renderEmbeddedResult(failed);
        assert.deepEqual(rendered.structuredContent?.modelFailure, failed.modelFailure);
        assert.match(rendered.content[0].text, /Provider HTTP status/);
      }
      assert.equal((await two.runs.get(started.runId))?.humanInput?.response?.answer, "Weekly");
      assert.match((await f.store.get("tenant-a", "project-a", primary))?.content ?? "", /review pending/);
      assert.equal(backend.seen.length, 3);
      assert.equal((await two.coordinator.listClaimableRuns()).length, 0);
    } finally { await f.cleanup(); }
  });
}

test("checkpoint storage failure persists an actionable reason without releasing the human gate", async () => {
  const f = await setup();
  class FailingCheckpointStore extends DurableRunStateStore {
    override async update(...args: Parameters<DurableRunStateStore["update"]>) {
      if (args[1].advisoryCheckpoint) throw new Error("Injected checkpoint storage outage.");
      return super.update(...args);
    }
  }
  const runs = new FailingCheckpointStore({ baseDir: join(f.root, "runs") });
  const backend = new ScriptedBackend([() => ask()]);
  const coordinator = new EmbeddedCoordinator({
    backend, workspaceManager: f.manager, runStateStore: runs, approvals: new RunStoreApprovalChannel(runs),
    quota: new TenantQuotaTracker({ concurrency: 2, monthlyCeilingUsd: 1 }),
    autoMemory: new AutoMemory({ store: f.memory, defaultProject: "project-a" }),
    stageExecutorFactory: (workspace, _project, runId, options) => {
      const runtime = new ResearchRuntime({ backend, workspace, store: f.store, project: "project-a", runId, githubRoot: f.githubRoot, ...options });
      return { execute: (_p, req, prior, _key, ledger) => runtime.execute(persona, req, prior, undefined, ledger) };
    },
  });
  try {
    const tool = loadCatalog().tools.find((entry) => entry.id === "squad_federate")!;
    const started = await coordinator.startHttpRun(tool, { ...request, toolId: tool.id, project: "project-a", squad: "demo" }, ctx);
    assert.ok(started.runId);
    assert.equal((await coordinator.approveRun(started.runId, ctx)).ok, true);
    await assert.rejects(coordinator.pollRun(started.runId, ctx), /checkpoint persistence failed/);
    const failed = await runs.get(started.runId);
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.failureReason, "checkpoint_persistence_failed");
    assert.equal(backend.seen.length, 1);
    assert.equal((await coordinator.pollRun(started.runId, ctx)).reason, "checkpoint_persistence_failed");
  } finally { await f.cleanup(); }
});

test("question tools are unavailable without a durable handoff host", async () => {
  const f = await setup();
  const workspace = await f.manager.allocate("tenant-a");
  const backend = new ScriptedBackend([(input) => {
    assert.equal(input.tools?.some((entry) => entry.name === "request_human_input"), false);
    return ask();
  }]);
  try {
    const runtime = new ResearchRuntime({ backend, workspace, store: f.store, project: "project-a", runId: "run-a", githubRoot: f.githubRoot });
    await assert.rejects(runtime.execute(persona, request), (e: unknown) => e instanceof StageBlockedError && e.reason === "stage_invalid_tool");
  } finally { await workspace.dispose(); await f.cleanup(); }
});

for (const mode of ["artifact", "authority", "tenant", "budget", "stage-budget", "legacy-stage-budget", "deadline"] as const) {
  test(`resumption fails closed on ${mode} conflict instead of restarting a stage`, async () => {
    const f = await setup();
    const workspace = await f.manager.allocate("tenant-a");
    const primary = ".copilot-tracking/reviews/test-adviser/run-a/artifact.md";
    const backend = new ScriptedBackend([
      () => call("load_instruction", { path: "notice.instructions.md" }),
      () => call("write_artifact", { path: primary, content: "# Original" }),
      () => ask(),
    ]);
    try {
      let saved: ResearchCheckpoint | undefined;
      const runtime = new ResearchRuntime({ backend, workspace, store: f.store, project: "project-a", runId: "run-a", githubRoot: f.githubRoot, allowHumanInput: true });
      await assert.rejects(runtime.execute(persona, request), (e: unknown) => {
        if (!(e instanceof StageInputRequired)) return false;
        saved = e.checkpoint;
        return true;
      });
      assert.ok(saved);
      if (mode === "legacy-stage-budget") { delete saved.stageCalls; delete saved.stageTools; }
      if (mode === "deadline") saved.stageElapsedMs = 30 * 60 * 1000;
      if (mode === "artifact") await f.store.put("tenant-a", "project-a", primary, "# Changed");
      if (mode === "authority") await writeFile(join(f.githubRoot, "instructions", "notice.instructions.md"), "Changed authority");
      const resumed = new ResearchRuntime({ backend, workspace, store: f.store, project: mode === "tenant" ? "project-b" : "project-a", runId: "run-a", githubRoot: f.githubRoot,
        allowHumanInput: true, maxModelCalls: mode === "budget" ? 3 : 60,
        maxStageModelCalls: mode === "stage-budget" || mode === "legacy-stage-budget" ? 3 : 60,
        deadlineMs: 30 * 60 * 1000,
        continuation: { checkpoint: saved, response: { answer: "Weekly", respondedBy: "human-a", respondedAt: Date.now() } } });
      await assert.rejects(resumed.execute(persona, request), (e: unknown) =>
        e instanceof StageBlockedError && e.reason === (mode === "deadline" ? "stage_deadline" : mode.includes("budget") ? "stage_execution_limit" : "stage_resume_conflict"));
      assert.equal(backend.seen.length, 3);
    } finally { await workspace.dispose(); await f.cleanup(); }
  });
}

test("private checkpoint encoding is bounded and malformed envelopes fail explicitly", () => {
  const value = { data: "x".repeat(200_000) };
  assert.deepEqual(decodeAdvisoryCheckpoint(encodeAdvisoryCheckpoint(value)), value);
  assert.throws(() => readAdvisoryCheckpoint(encodeAdvisoryCheckpoint(value)), /envelope/);
  assert.throws(() => decodeAdvisoryCheckpoint("not base64"), /encoding/);
  assert.throws(() => encodeAdvisoryCheckpoint({ data: "x".repeat(4_000_001) }), /uncompressed limit/);
  const lowCompression = { data: randomBytes(150_000).toString("base64") };
  assert.deepEqual(decodeAdvisoryCheckpoint(encodeAdvisoryCheckpoint(lowCompression)), lowCompression);
  assert.throws(() => decodeAdvisoryCheckpoint(gzipSync(Buffer.alloc(4_000_001)).toString("base64")));
});
