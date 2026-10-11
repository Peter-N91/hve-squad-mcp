import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { SquadArtifact, SquadArtifactStore } from "../src/engine/artifact-store.js";
import type { CopilotSessionConfig, CopilotSessionEvent } from "../src/engine/copilot/copilot-stage-executor.js";
import { installedUpstreamBundle } from "../src/engine/copilot/upstream-bundle.js";
import {
  UpstreamCoordinator, UpstreamCoordinatorError, UPSTREAM_COORDINATOR_TOOLS, selectUpstreamEconomyRoute,
  type UpstreamCoordinatorOptions, type UpstreamHistoryRecord, type UpstreamReceipt,
  type UpstreamStageRequest, type UpstreamReviewVerification, type UpstreamCoordinatorCheckpoint,
} from "../src/engine/copilot/upstream-coordinator.js";
import type { UpstreamScriptName, UpstreamScriptRequest } from "../src/engine/copilot/upstream-script-bridge.js";

const bundle = installedUpstreamBundle();
const models = ["gpt-5.4", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-6.1-sol"];
const sha = (content: string) => createHash("sha256").update(content).digest("hex");
type Call = (name: typeof UPSTREAM_COORDINATOR_TOOLS[number], args: Record<string, unknown>, success?: boolean) => Promise<Record<string, unknown>>;
const report = "docs/report.md";
const owner = { role: "technical-writer", agent: "Squad Technical Writer", charterPath: ".github/agents/squad/squad-technical-writer.agent.md", floor: "default" as const, writeScope: { exactPaths: [report], prefixes: [] } };
const reviewer = { role: "tester", agent: "Squad Reviewer", charterPath: ".github/agents/squad/squad-reviewer.agent.md", floor: "default" as const, writeScope: { exactPaths: [], prefixes: [".copilot-tracking/reviews/"] } };

function harness(script: (call: Call, emit: (event: CopilotSessionEvent) => void, config: CopilotSessionConfig) => Promise<void>) {
  const files = new Map<string, SquadArtifact>();
  let revision = 0;
  const store: SquadArtifactStore = {
    async put(tenantId, project, path, content) {
      const artifact = { tenantId, project, path, content, etag: String(++revision), updatedAt: Date.now() };
      files.set(path, artifact);
      return { ok: true, artifact };
    },
    async get(tenantId, project, path) {
      const file = files.get(path);
      assert.equal(tenantId, "tenant");
      assert.equal(project, "new-project");
      return file;
    },
    async list() { return [...files.values()].map(f => ({ path: f.path, size: f.content.length, updatedAt: f.updatedAt })); },
    async append(tenantId, project, path, block) {
      const content = (files.get(path)?.content ?? "") + block;
      const result = await store.put(tenantId, project, path, content);
      assert.ok(result.ok);
      return result.artifact;
    },
  };
  const write = async (path: string, content: string): Promise<UpstreamReceipt> => {
    await store.put("tenant", "new-project", path, content);
    return { path, sha256: sha(content) };
  };
  const stages: UpstreamStageRequest[] = [], histories: UpstreamHistoryRecord[] = [];
  const procedures: UpstreamScriptRequest[] = [];
  const runtime = { config: undefined as CopilotSessionConfig | undefined, aborted: 0, disconnected: 0 };
  let reviewVerdicts: UpstreamReviewVerification["verdict"][] = ["Pass"];
  const options: UpstreamCoordinatorOptions = {
    client: {
      async createSession(config) {
        runtime.config = config;
        const listeners = new Set<(event: CopilotSessionEvent) => void>();
        const emit = (event: CopilotSessionEvent) => { for (const listener of listeners) listener(event); };
        const call: Call = async (name, args, success = true) => {
          const tool = config.tools.find(t => t.name === name);
          assert.ok(tool, `tool ${name} exists`);
          const result = await tool.handler(args);
          assert.equal(result.resultType, success ? "success" : "failure", result.textResultForLlm);
          return success ? JSON.parse(result.textResultForLlm) as Record<string, unknown> : { error: result.textResultForLlm };
        };
        return {
          on(listener) { listeners.add(listener); return () => listeners.delete(listener); },
          async sendAndWait() {
            emit({ type: "assistant.usage", data: { inputTokens: 11, outputTokens: 7 } });
            await script(call, emit, config);
            return { data: { content: "Model's unchecked prose is not a report receipt." } };
          },
          async abort() { runtime.aborted++; },
          async disconnect() { runtime.disconnected++; },
        };
      },
    },
    bundle, store, tenantId: "tenant", project: "new-project", runId: "upstream-run",
    projectKind: "new", economyConsent: true, rosterConfirmed: true,
    roster: [owner, reviewer], coordinatorModel: "gpt-5.6-sol", availableModels: models,
    async stageRunner(request) {
      stages.push(request);
      assert.ok(request.signal instanceof AbortSignal);
      assert.equal(request.signal.aborted, false);
      const output = request.purpose === "review" ? `.copilot-tracking/reviews/${stages.length}.md` : report;
      const content = `# ${request.agent}\n${request.task}\nStage ${request.stageId}\n`;
      return { artifacts: [await write(output, content)], result: {
        backendId: "copilot-sdk", text: content, finishReason: "stop", model: request.model,
        usage: { inputTokens: 100, cacheReadTokens: 20, cacheWriteTokens: 3, outputTokens: 40, completionCount: 1, attemptCount: 1, costStatus: "unavailable" },
      } };
    },
    async prepareProcedure(name, context) {
      let request: UpstreamScriptRequest;
      switch (name) {
        case "Initialize-SquadConsumptionRates": request = { script: name, args: { mode: "economy" } }; break;
        case "Resolve-SquadModelRoute": request = { script: name, args: { mode: "economy", availableModels: [...context.availableModels] } }; break;
        case "Get-SquadDispatchBrief": request = { script: name, args: { sessionModel: context.model } }; break;
        case "Measure-SquadLedger": request = { script: name, args: { check: true } }; break;
        case "Write-SquadHandoff": request = { script: name, args: { payload: { runId: context.runId, historyRecords: histories } } }; break;
        case "Set-SquadCostPreflight": request = { script: name, args: { expectedUpdated: "trusted-etag", preflight: { roundId: "trusted-round" }, decisionText: "Trusted admission" } }; break;
      }
      return { request };
    },
    async procedureRunner(request) {
      procedures.push(request);
      return { script: request.script, output: "trusted procedure receipt", changedPaths: [], accounting: "upstream-schema-estimates-only" };
    },
    async persistStage(record) {
      histories.push(record);
      const target = `.copilot-tracking/squad/history/${record.role}.md`;
      const existing = files.get(target)?.content ?? `# History: ${record.agent}\n\n`;
      return write(target, existing + record.historyEntry);
    },
    async verifyFinish(reports, context) {
      const reviewed = [...context.stages].reverse().find(s => s.request.purpose === "review")!;
      return {
        verdict: reviewVerdicts.shift() ?? "Pass", reviewerStageId: reviewed.request.stageId,
        ownerStageId: reviewed.request.reviewsStageId!, readHashes: [...reports],
        reviewReceipt: reviewed.artifacts[0], findings: ["Independent findings"],
        approvedActionablePipeline: false,
      };
    },
    async requestHumanInput() {
      const error = Object.assign(new Error("awaiting human input"), { name: "StageInputRequired", input: { question: "approve?" }, checkpoint: { phase: "blocked" } });
      throw error;
    },
  };
  return { options, runtime, stages, histories, procedures, write, files, setVerdicts: (v: typeof reviewVerdicts) => { reviewVerdicts = [...v]; } };
}

async function initialize(call: Call) {
  for (const name of ["Initialize-SquadConsumptionRates", "Resolve-SquadModelRoute", "Get-SquadDispatchBrief"] as const) {
    await call("invoke_upstream_procedure", { name });
  }
}
async function produce(call: Call) {
  await initialize(call);
  const stage = await call("delegate_role_stage", { role: owner.role, agent: owner.agent, task: "Write the requested report directly; upstream bounded route.", purpose: "work" });
  await call("delegate_role_stage", { role: reviewer.role, agent: reviewer.agent, task: "Independently review the final stored report.", purpose: "review", reviewsStageId: stage.stageId });
  await call("invoke_upstream_procedure", { name: "Measure-SquadLedger" });
  return stage;
}
const finishArgs = { outcome: "accepted", summary: "Stored report independently reviewed.", gaps: [], reportPaths: [report] };

test("authentic upstream coordinator contract dynamically selects direct owner and protected reviewer, not native Research/Plan", async () => {
  const h = harness(async (call, _emit, config) => {
    assert.match(config.systemMessage.content, /Squad Operating Procedure/);
    assert.match(config.systemMessage.content, /Dispatch Discipline/);
    assert.match(config.systemMessage.content, /Review Follow-Through/);
    assert.deepEqual(config.availableTools, [...UPSTREAM_COORDINATOR_TOOLS]);
    assert.deepEqual(config.customAgents, []);
    assert.equal(config.tools.find(t => t.name === "finish_upstream_run")?.isTerminal, true);
    for (const tool of config.tools) assert.equal(tool.parameters.additionalProperties, false);
    for (const toolName of ["bash", "edit", "create", "task", "azure", "tracker", "arbitrary"]) {
      const pre = await config.hooks.onPreToolUse({ toolName, toolArgs: {}, sessionId: config.sessionId });
      assert.equal(pre?.permissionDecision, "deny");
    }
    assert.equal(config.onPermissionRequest({ kind: "shell" }).kind, "reject");
    await assert.rejects(config.fileSystem.writeFile("/workspace/docs/report.md", "bypass"), /denied/);
    assert.equal((await config.hooks.onPreToolUse({ toolName: "delegate_role_stage", toolArgs: {}, sessionId: "nested-worker" }))?.permissionDecision, "deny");
    await produce(call);
    await call("finish_upstream_run", finishArgs);
  });
  const result = await new UpstreamCoordinator(h.options).run("Produce a fully specified report.");
  assert.deepEqual(h.stages.map(s => s.role), ["technical-writer", "tester"]);
  const catalog = bundle.read(".github/skills/squad/references/model-catalog.md", 1, 400).content;
  const routing = bundle.read(".github/skills/squad/references/model-routing.md", 1, 400).content;
  assert.equal(h.stages[0].model, selectUpstreamEconomyRoute(catalog, routing, owner.role, owner.floor, models).model);
  assert.equal(h.stages[1].model, selectUpstreamEconomyRoute(catalog, routing, reviewer.role, reviewer.floor, models).rankedModel);
  assert.ok(h.stages.every(s => !s.allowNestedDelegation && s.maxModelCalls > 0));
  assert.equal(result.metadata.outcome, "accepted");
  assert.equal(result.metadata.rolloutVersion, "0.19.0-pre");
  assert.equal(result.metadata.productionSmokeVerified, false);
  assert.equal(result.metadata.reports[0].sha256, sha(h.files.get(report)!.content));
  assert.equal(result.usage?.inputTokens, 211);
  assert.equal(result.usage?.estimatedCostUsd, undefined);
  assert.equal(h.histories.length, 2);
  assert.deepEqual(Object.keys(h.histories[0].consumption), [
    "model", "model_source", "priced_as", "model_tier", "internal_turns", "input_tokens",
    "cached_tokens", "cache_write_tokens", "output_tokens", "basis",
  ]);
  assert.equal(h.histories[0].consumption.cached_tokens, 20);
  assert.equal(h.histories[0].upstreamHistoryPath, ".copilot-tracking/squad/history/Squad Technical Writer.md");
  assert.match(h.histories[0].historyEntry, /#### Consumption\n/);
  assert.ok(h.runtime.disconnected > 0);
});

test("immutable readers are bounded and reject traversal, unknown tools/args, unrostered stages and model script commands", async () => {
  const h = harness(async call => {
    const resources = await call("list_upstream_resources", {});
    assert.equal((resources.paths as string[]).length, 100);
    assert.equal(resources.total, 1682);
    await call("read_upstream_resource", { path: ".github/skills/squad/SKILL.md", maxLines: 10 });
    await call("read_upstream_resource", { path: "../secrets" }, false);
    await call("read_upstream_resource", { path: ".github/skills/rpi/rpi-plan/SKILL.md" }, false);
    await call("read_upstream_resource", { path: ".github/skills/squad/SKILL.md", maxLines: 401 }, false);
    await call("read_project_file", { path: "../secrets.md" }, false);
    await call("read_project_file", { path: "docs/secrets.md" }, false);
    await call("delegate_role_stage", { role: "general-purpose", agent: "task", task: "do anything", purpose: "work" }, false);
    await call("delegate_role_stage", { role: owner.role, agent: reviewer.agent, task: "mismapped agent", purpose: "work" }, false);
    await call("delegate_role_stage", { role: owner.role, agent: owner.agent, task: "missing precheck", purpose: "work" }, false);
    await call("invoke_upstream_procedure", { name: "Write-SquadHandoff", command: "rm -rf /", policy: { writes: [{ path: "/etc/passwd" }] } }, false);
    await call("invoke_upstream_procedure", { name: "arbitrary.ps1" }, false);
    await produce(call);
    const stored = await call("read_project_file", { path: report, maxLines: 1 });
    assert.equal(stored.sha256, sha(h.files.get(report)!.content));
    await call("finish_upstream_run", finishArgs);
  });
  await new UpstreamCoordinator(h.options).run("Read safe context.");
  assert.equal(h.procedures.length, 4);
  assert.ok(h.procedures.every(p => !("command" in p.args)));
});

test("requires trusted verification, consent, roster confirmation and new-project opt-in", () => {
  const h = harness(async () => undefined);
  for (const override of [
    { verifyFinish: undefined }, { persistStage: undefined }, { procedureRunner: undefined },
    { economyConsent: false }, { rosterConfirmed: false }, { projectKind: "existing" },
    { coordinatorModel: "unavailable-model" }, { maxModelCalls: 0 }, { deadlineMs: Infinity },
  ]) assert.throws(() => new UpstreamCoordinator({ ...h.options, ...override } as UpstreamCoordinatorOptions));
});

for (const routing of [
  { mode: "ranked" as const }, { mode: "economy" as const }, { mode: "manual" as const, model: "gpt-5.4" },
]) {
  test(`${routing.mode} coordinator dispatch uses the confirmed mode for scripts, owners and reviewers`, async () => {
    const h = harness(async (call, _emit, config) => {
      assert.match(config.systemMessage.content, new RegExp(`routing=${routing.mode}`));
      await produce(call);
      await call("finish_upstream_run", finishArgs);
    });
    h.options.routing = routing;
    h.options.routingConsent = true;
    const prepare = h.options.prepareProcedure;
    h.options.prepareProcedure = async (name, context) => {
      const prepared = await prepare(name, context);
      if (prepared.request.script === "Initialize-SquadConsumptionRates" ||
          prepared.request.script === "Resolve-SquadModelRoute") prepared.request.args.mode = routing.mode;
      return prepared;
    };
    const result = await new UpstreamCoordinator(h.options).run("Produce a fully specified report.");
    assert.equal(result.metadata.routing, routing.mode);
    const catalog = bundle.read(".github/skills/squad/references/model-catalog.md", 1, 400).content;
    const rules = bundle.read(".github/skills/squad/references/model-routing.md", 1, 400).content;
    for (const stage of h.stages) {
      const role = h.options.roster.find(role => role.role === stage.role)!;
      assert.equal(stage.model, selectUpstreamEconomyRoute(catalog, rules, role.role, role.floor, models, routing).model);
      if (routing.mode === "manual") assert.equal(stage.rankedModel, routing.model);
    }
  });
}
test("approval tool halts through the original StageInputRequired; model cannot fabricate an approval", async () => {
  const h = harness(async call => {
    await call("request_human_input", { question: "Confirm consequential action?", reason: "Impactful action gate." }, false);
    await call("invoke_upstream_procedure", { name: "Initialize-SquadConsumptionRates" }, false);
  });
  await assert.rejects(new UpstreamCoordinator(h.options).run("Gate an action."), (error: unknown) => error instanceof Error && error.name === "StageInputRequired" && "checkpoint" in error);
  assert.equal(h.stages.length, 0);
  assert.equal(h.procedures.length, 0);
  assert.ok(h.runtime.aborted);
});

test("Fail is not accepted; only one explicit original-owner ranked correction and the same protected rereviewer can follow", async () => {
  const h = harness(async call => {
    const original = await produce(call);
    const rejection = await call("finish_upstream_run", finishArgs, false);
    assert.match(String(rejection.error), /original role technical-writer/);
    await call("delegate_role_stage", { role: reviewer.role, agent: reviewer.agent, task: "pretend to correct", purpose: "correction", correctsStageId: original.stageId }, false);
    const corrected = await call("delegate_role_stage", { role: owner.role, agent: owner.agent, task: "Correct independent review findings.", purpose: "correction", correctsStageId: original.stageId });
    await call("delegate_role_stage", { role: owner.role, agent: owner.agent, task: "second correction", purpose: "correction", correctsStageId: original.stageId }, false);
    await call("delegate_role_stage", { role: reviewer.role, agent: reviewer.agent, task: "review stale report", purpose: "review", reviewsStageId: original.stageId }, false);
    await call("delegate_role_stage", { role: reviewer.role, agent: reviewer.agent, task: "Rereview final corrected report.", purpose: "review", reviewsStageId: corrected.stageId });
    await call("invoke_upstream_procedure", { name: "Measure-SquadLedger" });
    await call("finish_upstream_run", finishArgs);
  });
  h.setVerdicts(["Fail", "Pass"]);
  const result = await new UpstreamCoordinator(h.options).run("Finish with a real review.");
  assert.equal(result.metadata.outcome, "accepted");
  assert.equal(h.stages[2].role, owner.role);
  assert.equal(h.stages[2].model, h.stages[0].rankedModel);
  assert.equal(h.stages[3].model, h.stages[1].model);
  assert.equal(h.stages[2].round, 2);
  assert.ok(result.metadata.events.some(e => e.type === "stage.escalated"));
});

test("second failed rereview permits honest findings-only but never automatic acceptance", async () => {
  const h = harness(async call => {
    const original = await produce(call);
    await call("finish_upstream_run", finishArgs, false);
    const corrected = await call("delegate_role_stage", { role: owner.role, agent: owner.agent, task: "correct", purpose: "correction", correctsStageId: original.stageId });
    await call("delegate_role_stage", { role: reviewer.role, agent: reviewer.agent, task: "rereview", purpose: "review", reviewsStageId: corrected.stageId });
    await call("invoke_upstream_procedure", { name: "Measure-SquadLedger" });
    await call("finish_upstream_run", finishArgs, false);
    await call("finish_upstream_run", { ...finishArgs, outcome: "findings", gaps: ["Independent review still fails; no approved actionable pipeline."] });
  });
  h.setVerdicts(["Fail", "Fail", "Fail"]);
  const result = await new UpstreamCoordinator(h.options).run("Report honest findings.");
  assert.equal(result.metadata.outcome, "findings");
  assert.equal(result.metadata.verification.verdict, "Fail");
  assert.equal(result.stages.length, 4);
});

test("rejects missing report, missing independent reviewer, fake read hashes and post-review modification", async () => {
  for (const fault of ["missing-report", "wrong-reviewer", "wrong-read-hash", "changed-after-review"] as const) {
    const h = harness(async call => {
      await produce(call);
      const refused = await call("finish_upstream_run", finishArgs, false);
      assert.match(String(refused.error), /stored|independent|final report hash|changed/);
    });
    const original = h.options.verifyFinish;
    h.options.verifyFinish = async (reports, context) => {
      const result = await original(reports, context);
      if (fault === "wrong-reviewer") result.reviewerStageId = context.stages[0].request.stageId;
      if (fault === "wrong-read-hash") result.readHashes = [{ path: report, sha256: "0".repeat(64) }];
      if (fault === "changed-after-review") await h.write(report, "Changed after final review.");
      return result;
    };
    if (fault === "missing-report") {
      const originalStage = h.options.stageRunner;
      h.options.stageRunner = async request => {
        const result = await originalStage(request);
        if (request.purpose === "review") h.files.delete(report);
        return result;
      };
    }
    await assert.rejects(new UpstreamCoordinator(h.options).run("Verify final hashes."), /without a verified terminal finish/);
  }
});

test("stage persistence failure preserves completed artifacts and attempted-work events", async () => {
  const h = harness(async call => {
    await initialize(call);
    await call("delegate_role_stage", { role: owner.role, agent: owner.agent, task: "persist report", purpose: "work" }, false);
  });
  h.options.persistStage = async () => { throw new Error("storage CAS conflict"); };
  await assert.rejects(new UpstreamCoordinator(h.options).run("Persist per-stage history."), (error: unknown) => {
    assert.ok(error instanceof UpstreamCoordinatorError);
    assert.match(error.message, /storage CAS conflict/);
    assert.equal(error.stages.length, 1);
    assert.equal(error.stages[0].artifacts[0].path, report);
    assert.equal(error.stages[0].history, undefined);
    assert.ok(error.events.some(e => e.type === "stage.failed"));
    return true;
  });
});

test("procedure failure preserves attempted script and does not allow subsequent dispatch", async () => {
  const h = harness(async call => { await call("invoke_upstream_procedure", { name: "Initialize-SquadConsumptionRates" }, false); });
  h.options.procedureRunner = async () => { throw new Error("Bridge rejected server write policy"); };
  await assert.rejects(new UpstreamCoordinator(h.options).run("Bridge execution."), (error: unknown) => {
    assert.ok(error instanceof UpstreamCoordinatorError);
    assert.ok(error.events.some(e => e.type === "procedure.attempted" && e.procedure === "Initialize-SquadConsumptionRates"));
    assert.ok(error.events.some(e => e.type === "procedure.failed"));
    return true;
  });
});

test("deadline cancels a hanging child with a real signal and bounds a hanging runtime", async () => {
  const h = harness(async call => {
    await initialize(call);
    await call("delegate_role_stage", { role: owner.role, agent: owner.agent, task: "hang", purpose: "work" }, false);
  });
  let signal: AbortSignal | undefined;
  // Initialization verifies the full package; allow it to finish under parallel-suite load.
  h.options.deadlineMs = 2000;
  h.options.stageRunner = async request => { signal = request.signal; return new Promise(() => undefined); };
  await assert.rejects(new UpstreamCoordinator(h.options).run("Bound child execution."), /deadline/);
  assert.equal(signal?.aborted, true);
  assert.ok(h.runtime.aborted && h.runtime.disconnected);
});

test("model usage and procedure budgets halt without discarding attempted work", async () => {
  const h = harness(async (_call, emit) => {
    emit({ type: "assistant.usage", data: { inputTokens: 1 } });
  });
  h.options.maxModelCalls = 1;
  await assert.rejects(new UpstreamCoordinator(h.options).run("Bound model calls."), /model-call budget/);
  const p = harness(async call => {
    await call("invoke_upstream_procedure", { name: "Initialize-SquadConsumptionRates" });
    await call("invoke_upstream_procedure", { name: "Get-SquadDispatchBrief" }, false);
  });
  p.options.maxProcedureCalls = 1;
  await assert.rejects(new UpstreamCoordinator(p.options).run("Bound script calls."), /procedure budget/);
  assert.equal(p.procedures.length, 1);
});

test("server-owned structured procedures, including preflight and handoff, never receive model-chosen args", async () => {
  const h = harness(async call => {
    await produce(call);
    for (const name of ["Set-SquadCostPreflight", "Write-SquadHandoff"] as UpstreamScriptName[]) await call("invoke_upstream_procedure", { name });
    await call("finish_upstream_run", finishArgs);
  });
  await new UpstreamCoordinator(h.options).run("Use trusted procedure bridge.");
  assert.equal(h.procedures.length, 6);
  const preflight = h.procedures.find(p => p.script === "Set-SquadCostPreflight")!;
  assert.equal(preflight.args.expectedUpdated, "trusted-etag");
});

test("High findings cannot be accepted even when the review verdict says Pass", async () => {
  const h = harness(async call => {
    await produce(call);
    await call("finish_upstream_run", finishArgs, false);
    await call("finish_upstream_run", { ...finishArgs, outcome: "findings", gaps: ["High findings remain; implementation is not approved."] });
    await call("invoke_upstream_procedure", { name: "Get-SquadDispatchBrief" }, false);
  });
  const verify = h.options.verifyFinish;
  h.options.verifyFinish = async (reports, context) => ({ ...await verify(reports, context), highestSeverity: "High" });
  const result = await new UpstreamCoordinator(h.options).run("Do not accept high findings.");
  assert.equal(result.metadata.outcome, "findings");
  assert.equal(h.procedures.length, 4);
});

test("findings-only cannot conceal an already-approved actionable pipeline", async () => {
  const h = harness(async call => {
    await produce(call);
    await call("finish_upstream_run", { ...finishArgs, outcome: "findings", gaps: ["Skip approved work."] }, false);
  });
  const verify = h.options.verifyFinish;
  h.options.verifyFinish = async (reports, context) => ({ ...await verify(reports, context), approvedActionablePipeline: true });
  await assert.rejects(new UpstreamCoordinator(h.options).run("Preserve pipeline admission."), /without a verified terminal finish/);
});

test("caller cancellation and stalled session creation are bounded", async () => {
  const h = harness(async () => undefined);
  const cancelled = new AbortController();
  cancelled.abort(new Error("Operator cancellation"));
  h.options.signal = cancelled.signal;
  await assert.rejects(new UpstreamCoordinator(h.options).run("Cancelled run."), /cancelled/);
  assert.equal(h.runtime.config, undefined);
  const stalled = harness(async () => undefined);
  stalled.options.deadlineMs = 100;
  stalled.options.client = { createSession: async () => new Promise(() => undefined) };
  await assert.rejects(new UpstreamCoordinator(stalled.options).run("Bound runtime connection."), /deadline/);
});

test("coordinator resume restores failed review, exact owner correction, budgets and idempotent completed delegations", async () => {
  let resumed = false;
  let state: UpstreamCoordinatorCheckpoint | undefined;
  let originalStage: Record<string, unknown>;
  const question = "Confirm original-owner correction?", reason = "Independent review failed; retain exact owner and protected reviewer.";
  const h = harness(async call => {
    if (!resumed) {
      originalStage = await produce(call);
      await call("finish_upstream_run", finishArgs, false);
      await call("request_human_input", { question, reason }, false);
      return;
    }
    const answer = await call("request_human_input", { question, reason });
    assert.equal(answer.responseId, "correction-response");
    await initialize(call);
    const cached = await call("delegate_role_stage", { role: owner.role, agent: owner.agent, task: "Write the requested report directly; upstream bounded route.", purpose: "work" });
    assert.equal(cached.stageId, originalStage.stageId);
    const correction = await call("delegate_role_stage", { role: owner.role, agent: owner.agent, task: "Correct original report after approved exact review findings.", purpose: "correction", correctsStageId: originalStage.stageId });
    await call("delegate_role_stage", { role: reviewer.role, agent: reviewer.agent, task: "Rereview final corrected report.", purpose: "review", reviewsStageId: correction.stageId });
    await call("invoke_upstream_procedure", { name: "Measure-SquadLedger" });
    await call("finish_upstream_run", finishArgs);
  });
  h.setVerdicts(["Fail", "Pass"]);
  h.options.onState = checkpoint => { state = checkpoint; };
  await assert.rejects(new UpstreamCoordinator(h.options).run("Original upstream request."), error => error instanceof Error && error.name === "StageInputRequired");
  assert.ok(state?.failedReview);
  assert.equal(state.stages.length, 2);
  const held = structuredClone(state);
  resumed = true;
  h.options.client.resumeSession = async (sessionId, config) => {
    assert.equal(sessionId, held.sessionId);
    assert.equal(config.sessionId, held.sessionId);
    return h.options.client.createSession(config);
  };
  h.options.continuation = { checkpoint: held, answer: { question, reason, answer: "Correct only the original report.", respondedBy: "user", responseId: "correction-response" } };
  const result = await new UpstreamCoordinator(h.options).run("Original upstream request.");
  assert.equal(result.stages.length, 4);
  assert.equal(h.stages.length, 4, "cached completed owner did not execute again");
  assert.equal(result.stages[2].request.model, result.stages[0].request.rankedModel);
  assert.equal(result.stages[3].request.agent, result.stages[1].request.agent);
  assert.equal(h.histories.length, 4);
  assert.equal(h.procedures.filter(p => p.script === "Initialize-SquadConsumptionRates").length, 1);
});
