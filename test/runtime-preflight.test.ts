import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadCatalog } from "../src/catalog/catalog.js";
import { MemoryBackedArtifactStore } from "../src/engine/artifact-store.js";
import { AutoMemory } from "../src/engine/auto-memory.js";
import { FileSquadMemoryStore } from "../src/engine/backends/file-squad-memory.js";
import { DurableRunStateStore } from "../src/engine/durable-run-state.js";
import { EmbeddedCoordinator } from "../src/engine/embedded.js";
import { TenantQuotaTracker } from "../src/engine/gates.js";
import { completeWithObserver, ModelBackendError, type BackendRequest, type BackendResult, type ModelBackend } from "../src/engine/model-backend.js";
import { composeEmbeddedPrompt } from "../src/engine/embedded-prompt.js";
import { inspectTaskContext } from "../src/engine/model-preflight.js";
import { SquadRunRecorder } from "../src/engine/squad-run-recorder.js";
import { SquadHistory } from "../src/engine/squad-history.js";
import { TEAM_PATH } from "../src/engine/squad-ledger.js";
import { ResearchRuntime, StageInputRequired, type ResearchCheckpoint } from "../src/engine/research-runtime.js";
import { EphemeralWorkspaceManager } from "../src/engine/workspace.js";
import { RedactingLogger } from "../src/observability/logger.js";
import { runAdvisoryPipeline, AdvisoryStageFailure } from "../src/engine/advisory-pipeline.js";
import { renderEmbeddedResult } from "../src/engine/render-embedded.js";

const secret = "Bearer fixture_only_012345678901234567890123456789";
const persona = { role: "Test Adviser", charter: "Read original evidence and retain the human gate.", applyTo: [] };
const request = { toolId: "squad_run", request: "Review health, breach response and explicit override decisions.", context: "No signoff inferred." };
const sourcePath = ".copilot-tracking/research/source.md";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const call = (name: string, args: Record<string, unknown>): BackendResult => ({
  backendId: "fixture", text: "", finishReason: "tool_calls", usage: { estimatedCostUsd: 0.01 },
  toolCalls: [{ id: name + "-id", name, arguments: JSON.stringify(args) }],
});
const ask = () => call("request_human_input", { question: "Weekly or daily refresh?", purpose: "clarification", choices: ["Weekly", "Daily"] });
class Script implements ModelBackend {
  readonly id = "fixture";
  readonly supportsTools = true;
  readonly seen: BackendRequest[] = [];
  constructor(private readonly script: BackendResult[]) {}
  async complete(input: BackendRequest): Promise<BackendResult> {
    this.seen.push(structuredClone({ ...input, signal: undefined }));
    const next = this.script.shift();
    assert.ok(next, "Unexpected extra backend attempt");
    return next;
  }
}
async function fixture(script: BackendResult[] = []) {
  const root = await mkdtemp(join(tmpdir(), "runtime-preflight-"));
  const githubRoot = join(root, "cast");
  await mkdir(join(githubRoot, "instructions"), { recursive: true });
  await writeFile(join(githubRoot, "instructions", "notice.instructions.md"), "Pinned review instructions.");
  const manager = new EphemeralWorkspaceManager({ baseDir: join(root, "workspaces") });
  const workspace = await manager.allocate("tenant-a");
  const memory = new FileSquadMemoryStore({ baseDir: join(root, "memory") });
  const store = new MemoryBackedArtifactStore(memory);
  const backend = new Script(script);
  let events = 0, before = 0;
  const options = { backend, workspace, store, project: "project-a", runId: "run-a", githubRoot, allowHumanInput: true,
    onCompletion: () => { events++; }, beforeCall: () => { before++; } };
  const runtime = new ResearchRuntime(options);
  return { root, options, runtime, manager, workspace, memory, store, backend, events: () => events, before: () => before,
    cleanup: async () => { await workspace.dispose(); await rm(root, { force: true, recursive: true }); } };
}
function rejected(error: unknown): boolean {
  assert.ok(error instanceof ModelBackendError);
  assert.equal(error.providerAttempted, false);
  assert.ok(error.preflight?.issues.length);
  assert.doesNotMatch(String(error) + JSON.stringify(error.preflight), /fixture_only/);
  return true;
}

for (const context of [secret, '{"kind":"hve-task-context","schemaVersion":99}', "x".repeat(256_001)]) {
  test(`runtime validates input before seeding or dispatch (${context.length} characters)`, async () => {
    const f = await fixture();
    try {
      await assert.rejects(f.runtime.execute(persona, { ...request, context }), rejected);
      assert.equal(f.backend.seen.length, 0);
      assert.equal(f.events(), 0);
      assert.equal(f.before(), 0);
      await assert.rejects(readFile(f.workspace.resolve("input/context.md")));
    } finally { await f.cleanup(); }
  });
}

test("later source/tool output fails before a second provider attempt without changing canonical evidence", async () => {
  const f = await fixture([call("read_artifact", { path: sourcePath })]);
  try {
    const original = "# Original evidence\n" + secret;
    await f.store.put("tenant-a", "project-a", sourcePath, original);
    await assert.rejects(f.runtime.execute(persona, request), rejected);
    assert.equal(f.backend.seen.length, 1);
    assert.equal(f.events(), 1);
    assert.equal(f.before(), 1);
    assert.equal((await f.store.get("tenant-a", "project-a", sourcePath))?.content, original);
  } finally { await f.cleanup(); }
});

test("packet seeding and read_artifact preserve exact context and independent original-source hashes", async () => {
  const f = await fixture([call("read_artifact", { path: "input/context.md" }), call("read_artifact", { path: sourcePath }), ask()]);
  try {
    const source = "# Original evidence\nDaily refresh is a preference, NOT an accepted decision.";
    const context = JSON.stringify({
      kind: "hve-task-context", schemaVersion: 1, facts: ["Review unresolved refresh frequency."],
      decisions: ["Keep weekly until explicit approval."], constraints: ["No signoff inferred."], openQuestions: ["Daily?"],
      sources: [{ path: sourcePath, purpose: "Full independent review", sha256: sha(source), excerpt: source }],
      exclusions: [{ category: "diagnostic_history", count: 4 }],
    });
    await f.store.put("tenant-a", "project-a", sourcePath, source);
    await assert.rejects(f.runtime.execute(persona, { ...request, context }), StageInputRequired);
    assert.equal(await readFile(f.workspace.resolve("input/context.md"), "utf8"), context);
    assert.ok(f.backend.seen[0].messages[0].content.includes(context));
    const contextEvidence = JSON.parse(f.backend.seen[1].messages.at(-1)!.content);
    assert.equal(contextEvidence.sourceSha256, sha(context));
    assert.ok(contextEvidence.content.includes(context));
    const sourceEvidence = JSON.parse(f.backend.seen[2].messages.at(-1)!.content);
    assert.equal(sourceEvidence.sourceSha256, sha(source));
    assert.equal((await f.store.get("tenant-a", "project-a", sourcePath))?.content, source);
    assert.equal(f.events(), 3);
  } finally { await f.cleanup(); }
});

for (const mode of ["answer", "saved-context"] as const) {
  test(`resumed ${mode} is preflighted with ZERO new observer/provider attempts and untouched checkpoint pairing`, async () => {
    const f = await fixture([ask()]);
    try {
      let checkpoint: ResearchCheckpoint | undefined;
      await assert.rejects(f.runtime.execute(persona, request), (error: unknown) => {
        assert.ok(error instanceof StageInputRequired);
        checkpoint = error.checkpoint;
        return true;
      });
      assert.ok(checkpoint);
      const messagesBefore = structuredClone(checkpoint.messages);
      const callsBefore = checkpoint.calls;
      if (mode === "saved-context") checkpoint.request.context = '{"kind":"hve-task-context","schemaVersion":2}';
      const resumed = new ResearchRuntime({ ...f.options,
        continuation: { checkpoint, response: { answer: mode === "answer" ? secret : "Weekly", respondedBy: "fixture-human", respondedAt: Date.now() } },
      });
      await assert.rejects(resumed.execute(persona, request), rejected);
      assert.equal(f.backend.seen.length, 1);
      assert.equal(f.events(), 1);
      assert.equal(f.before(), 1);
      assert.equal(checkpoint.calls, callsBefore);
      assert.deepEqual(checkpoint.messages, messagesBefore);
      assert.equal(checkpoint.toolCallId, "request_human_input-id");
    } finally { await f.cleanup(); }
  });
}

test("composition rejection retains advisory-stage attribution without backend dispatch", async () => {
  const f = await fixture();
  try {
    await assert.rejects(runAdvisoryPipeline({ ...request, context: secret }, { backend: f.backend },
      { plan: [{ kind: "persona", role: persona.role, persona }] }), (error: unknown) => {
      assert.ok(error instanceof AdvisoryStageFailure);
      assert.equal(error.failedStage, persona.role);
      return rejected(error.cause);
    });
    assert.equal(f.backend.seen.length, 0);
  } finally { await f.cleanup(); }
});

for (const mode of ["packet", "legacy"] as const) {
    test(`memory-backed ${mode} dispatch preserves roster and history without silently changing context selection`, async () => {
      const f = await fixture([{ backendId: "fixture", text: "Completed bounded advice.", finishReason: "stop" }]);
      const project = "selected-project";
      const oldPath = ".copilot-tracking/research/UNRELATED_RUN_HISTORY.md";
      const oldArtifact = "Original diagnostic record: ContentFiltered, unrelated to this task.";
      const oldState = "UNRELATED_STATE_DIAGNOSTIC: previous provider rejection.";
      const oldDecision = "UNRELATED_OLD_DECISION: historical workaround, not sender authority.";
      const context = mode === "packet" ? JSON.stringify({
        kind: "hve-task-context", schemaVersion: 1, facts: ["Business evidence only."],
        decisions: ["Keep EXACT sender decision; no automatic override."],
        constraints: ["Preserve this caveat EXACTLY: approval is pending."], openQuestions: [],
        sources: [], exclusions: [{ category: "diagnostic_history", count: 3 }],
      }, null, 2) : "Keep EXACT sender decision; approval is pending.";
      try {
        const recorder = new SquadRunRecorder({ store: f.store });
        const seeded = await recorder.open("tenant-a", project, { ...request, profile: "default" });
        assert.equal(seeded.profile.name, "default");
        const rosterBefore = await f.store.get("tenant-a", project, TEAM_PATH);
        assert.ok(rosterBefore);
        await f.store.put("tenant-a", project, oldPath, oldArtifact);
        await f.memory.write("tenant-a", project, "state", oldState);
        await f.memory.write("tenant-a", project, "decisions", oldDecision);
        const history = new SquadHistory(f.store);
        assert.match((await history.contextBlock("tenant-a", project))!, /UNRELATED_RUN_HISTORY/);

        const autoMemory = new AutoMemory({ store: f.memory, defaultProject: "different-default" });
        let memoryLoads = 0, executionCount = 0;
        const load = autoMemory.loadContext.bind(autoMemory);
        autoMemory.loadContext = async (tenant, resolvedProject) => {
          memoryLoads++;
          assert.equal(tenant, "tenant-a");
          assert.equal(resolvedProject, project);
          return load(tenant, resolvedProject);
        };
        const tool = loadCatalog().tools.find(item => item.id === "squad_plan")!;
        await writeFile(join(f.options.githubRoot, `${tool.role.toLowerCase().replaceAll(" ", "-")}.agent.md`),
          `---\nname: ${tool.role}\n---\nProduce bounded advice.`);
        const engine = new EmbeddedCoordinator({
          backend: f.backend, workspaceManager: f.manager,
          quota: new TenantQuotaTracker({ concurrency: 2, monthlyCeilingUsd: 10 }),
          autoMemory, runRecorder: recorder,
          stageExecutorFactory: (workspace, resolvedProject) => {
            assert.equal(workspace.tenantId, "tenant-a");
            assert.equal(resolvedProject, project);
            return { execute: async (p, framed) => {
              executionCount++;
              assert.equal(framed.project, project);
              assert.equal(framed.profile, "default", "Persisted roster still overrides the caller hint.");
              if (mode === "packet") {
                assert.equal(framed.context, context);
                assert.equal(inspectTaskContext(framed.context!).packet, true);
              }
              return completeWithObserver(f.backend,
                composeEmbeddedPrompt({ systemAuthority: p.charter, request: framed.request, context: framed.context }),
                () => undefined);
            } };
          },
        });
        const result = await engine.handleAdvisory(tool,
          { ...request, toolId: tool.id, context, project, profile: "product" },
          { auth: { tenantId: "tenant-a", subject: "fixture-human", scopes: ["Squad.Plan"], audience: "fixture" } },
          [f.options.githubRoot]);
        assert.equal(result.outcome, "completed");
        assert.equal(executionCount, 1);
        assert.equal(f.backend.seen.length, 1);
        const outbound = JSON.stringify(f.backend.seen[0]);
        assert.ok(f.backend.seen[0].messages[0].content.includes(context));
        if (mode === "packet") {
          assert.equal(memoryLoads, 0);
          assert.doesNotMatch(outbound, /UNRELATED_|Prior deliverables|prior squad memory|ContentFiltered/);
        } else {
          assert.equal(memoryLoads, 1);
          assert.match(outbound, /UNRELATED_STATE_DIAGNOSTIC/);
          assert.match(outbound, /UNRELATED_OLD_DECISION/);
          assert.match(outbound, /UNRELATED_RUN_HISTORY/);
        }
        assert.equal((await f.store.get("tenant-a", project, TEAM_PATH))?.content, rosterBefore.content);
        assert.equal((await history.read("tenant-a", project, oldPath))?.content, oldArtifact);
        assert.equal(await history.read("other-tenant", project, oldPath), undefined);
        assert.equal(await history.read("tenant-a", "different-default", oldPath), undefined);
        assert.equal((await f.memory.read("tenant-a", project, "decisions"))?.content, oldDecision);
        assert.ok((await f.memory.read("tenant-a", project, "state"))?.content.includes(oldState));
      } finally { await f.cleanup(); }
    });
  }

  for (const context of ['{"kind":"hve-task-context","schemaVersion":', '{"kind":"hve-task-context","schemaVersion":99}']) {
    test("memory-backed malformed/unsupported packet is rejected before history loading, never treated as legacy", async () => {
      const f = await fixture();
      try {
        const autoMemory = new AutoMemory({ store: f.memory });
        let memoryLoads = 0;
        autoMemory.loadContext = async () => { memoryLoads++; return "Unrelated historical diagnostics."; };
        const engine = new EmbeddedCoordinator({
          backend: f.backend, workspaceManager: f.manager, autoMemory,
          runRecorder: new SquadRunRecorder({ store: f.store }),
          quota: new TenantQuotaTracker({ concurrency: 2, monthlyCeilingUsd: 10 }),
        });
        const tool = loadCatalog().tools.find(item => item.id === "squad_research")!;
        const result = await engine.handle(tool, { ...request, toolId: tool.id, context },
          { auth: { tenantId: "tenant-a", subject: "fixture-human", scopes: ["Squad.Research"], audience: "fixture" } });
        assert.equal(result.outcome, "denied");
        assert.equal(result.modelFailure?.providerAttempted, false);
        assert.ok(result.modelFailure?.preflight?.issues.some(issue => issue.rule === "task_context_schema"));
        assert.equal(memoryLoads, 0);
        assert.equal(f.backend.seen.length, 0);
      } finally { await f.cleanup(); }
    });
  }
test("native failure receipt and durable restarted status retain safe preflight metadata, not input or fake usage", async () => {
  const f = await fixture();
  const logs: string[] = [];
  const runs = new DurableRunStateStore({ baseDir: join(f.root, "runs") });
  const coordinator = (store: DurableRunStateStore) => new EmbeddedCoordinator({
    backend: f.backend, workspaceManager: f.manager, runStateStore: store,
    quota: new TenantQuotaTracker({ concurrency: 2, monthlyCeilingUsd: 10 }),
    logger: new RedactingLogger({ sink: line => logs.push(line) }),
  });
  const ctx = { auth: { tenantId: "tenant-a", subject: "fixture-human", scopes: ["Squad.Research"], audience: "fixture" } };
  try {
    const tool = loadCatalog().tools.find(item => item.id === "squad_research")!;
    const result = await coordinator(runs).handle(tool, { ...request, toolId: tool.id, context: secret }, ctx);
    assert.equal(result.outcome, "denied");
    assert.equal(result.modelFailure?.providerAttempted, false);
    assert.equal(f.backend.seen.length, 0);
    assert.ok(result.runId);
    const persisted = await runs.get(result.runId);
    assert.equal(persisted?.status, "failed");
    assert.deepEqual(persisted?.modelFailure, result.modelFailure);
    const restarted = coordinator(new DurableRunStateStore({ baseDir: join(f.root, "runs") }));
    const polled = await restarted.pollRun(result.runId, ctx);
    assert.deepEqual(polled.modelFailure, result.modelFailure);
    const receipt = JSON.stringify(renderEmbeddedResult(polled));
    assert.match(receipt, /No provider attempt was made/);
    assert.match(receipt, /credential_bearer/);
    assert.doesNotMatch(receipt + logs.join("") + JSON.stringify(persisted), /fixture_only/);
    assert.ok(!logs.some(line => line.includes("model completion accounted")));
  } finally { await f.cleanup(); }
});
