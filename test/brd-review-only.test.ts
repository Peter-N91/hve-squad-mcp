import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { MemoryBackedArtifactStore } from "../src/engine/artifact-store.js";
import { FileSquadMemoryStore } from "../src/engine/backends/file-squad-memory.js";
import { EphemeralWorkspaceManager } from "../src/engine/workspace.js";
import { ResearchRuntime, StageBlockedError, StageInputRequired } from "../src/engine/research-runtime.js";
import { parseBrdReview, validateBrdReviewOutputs, type BrdReviewRequest } from "../src/engine/brd-review.js";
import { loadPersonaForRole, type PersonaRecord } from "../src/engine/persona-loader.js";
import { route } from "../src/engine/routing.js";
import { planAdvisoryStages, runAdvisoryPipeline } from "../src/engine/advisory-pipeline.js";
import type { BackendResult, ModelBackend } from "../src/engine/model-backend.js";
import { loadCatalog } from "../src/catalog/catalog.js";
import { ToolRouter } from "../src/router/router.js";
import { encodeRunParams, decodeRunParams, coordinatorRequestFromRun } from "../src/engine/run-params.js";
import { EmbeddedCoordinator } from "../src/engine/embedded.js";
import { AutoMemory } from "../src/engine/auto-memory.js";
import { SquadRunRecorder } from "../src/engine/squad-run-recorder.js";
import { TenantQuotaTracker } from "../src/engine/gates.js";
import { TEAM_PATH } from "../src/engine/squad-ledger.js";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const targetPath = ".copilot-tracking/brd/source.md";
const content = "---\nbrd_id: TEST-BRD\nversion: '0.4'\nphase: Define\n---\n# Existing BRD\n\nTest draft; no human approval asserted.";
const document = { id: "TEST-BRD", version: "0.4", phase: "Define" as const };
const review: BrdReviewRequest = { kind: "brd", targetPath, targetSha256: sha(content), document, sources: [] };
const request = { toolId: "squad_run", request: "Independently assess the exact existing BRD; do not author a replacement.", project: "project-test", review };
const tool = (name: string, args: unknown): BackendResult => ({
  text: "", finishReason: "tool_calls", toolCalls: [{ id: `tool-${name}`, name, arguments: JSON.stringify(args) }], backendId: "fake",
});
function payload(verdict: "PASS" | "NEEDS_REVIEW" | "FAIL" = "PASS") {
  const status = verdict === "PASS" ? "COVERED" : verdict === "NEEDS_REVIEW" ? "CAUTION" : "RISK";
  const brd = { ...document, artifact_path: targetPath };
  const counts = { RISK: +(status === "RISK"), CAUTION: +(status === "CAUTION"), COVERED: +(status === "COVERED"), NOT_APPLICABLE: 0 };
  const findings = {
    schema_version: "BRD_STANDARD_FINDINGS_V1", assessment_id: "test-assessment", assessed_at: "2026-09-20T16:00:00Z",
    brd, standard: { skill_name: "requirements-quality", skill_version: "1.0" }, mode: "plan", overall_status: status,
    summary_counts: counts, findings: [{ finding_id: "F1", checklist_item: "coverage", status,
      severity: status === "COVERED" ? "N/A" : "HIGH", location: { section: "Existing BRD" },
      finding: "Test assessment finding.", recommendation: status === "COVERED" ? null : "Clarify the source." }],
    iso_29148_attributes: Object.fromEntries(["necessary", "appropriate", "unambiguous", "complete", "singular", "feasible", "verifiable", "correct", "conforming"].map((key) => [key, 3])),
    iso_25010_categories: Object.fromEntries(["functional_suitability", "performance_efficiency", "compatibility", "usability", "reliability", "security", "maintainability", "portability"].map((key) => [key, true])),
    smart_business_goals: [], fr_ac_coverage: { fr_total: 1, fr_with_ac: 1, coverage_pct: 100 },
  };
  const report = {
    schema_version: "BRD_QUALITY_REPORT_V1", report_id: "test-report", generated_at: "2026-09-20T16:00:00Z", brd,
    overall_status: verdict, decision_thresholds: { iso_29148_core_min_score: 2, fr_to_ac_min_pct: 80, fr_to_bg_target_pct: 100 },
    gate_decisions: { define_exit: verdict === "FAIL" ? "BLOCKED" : verdict === "PASS" ? "APPROVED" : "APPROVED_WITH_COMMENTS", govern_exit: "NOT_EVALUATED" },
    summary_counts: counts, severity_breakdown: { CRITICAL: 0, HIGH: +(status !== "COVERED"), MEDIUM: 0, LOW: 0 },
    standards_assessed: [{ skill_name: "requirements-quality", skill_version: "1.0", overall_status: status, findings_count: 1 }],
    category_summaries: {
      iso_29148: { average_score: 3, weakest_attribute: "necessary", weakest_attribute_score: 3 },
      iso_25010: { covered_categories: 8, missing_categories: [] },
      smart: { goals_total: 0, goals_passing: 0, pass_rate_pct: 100 },
      fr_ac_coverage: { fr_total: 1, fr_with_ac: 1, coverage_pct: 100, threshold_pct: 80 },
      fr_bg_coverage: { fr_total: 1, fr_with_bg: 1, bg_total: 0, coverage_pct: 100, target_pct: 100, waiver_required: false },
    },
    top_findings: [], recommendations: [], warnings: [],
  };
  return { summary: "Assessment only; stakeholder decisions remain open.", evidenceIds: ["E1"], findings, report };
}
async function fixture(complete: ModelBackend["complete"]) {
  const root = await mkdtemp(join(process.cwd(), ".review-test-"));
  const manager = new EphemeralWorkspaceManager({ baseDir: join(root, "workspace") });
  const workspace = await manager.allocate("tenant-test");
  const memory = new FileSquadMemoryStore({ baseDir: join(root, "memory") });
  const store = new MemoryBackedArtifactStore(memory);
  await store.put("tenant-test", "project-test", targetPath, content, "");
  const backend: ModelBackend = { id: "fake", supportsTools: true, complete };
  const options = { backend, workspace, store, project: "project-test", runId: "test-review", deadlineMs: 10000 };
  return { options, store, memory, manager, cleanup: async () => { await workspace.dispose(); await rm(root, { recursive: true, force: true }); } };
}

test("explicit review routes one executable reviewer despite seeded brd/profile/mode and authoring keywords", () => {
  const plan = route("Research and author a BRD", { profile: "brd", mode: "autopilot", review });
  assert.deepEqual(plan.stages.map((stage) => stage.agentName), ["BRD Quality Reviewer"]);
  assert.equal(plan.fanOut.length, 0);
  assert.equal(plan.council.engaged, false);
  assert.deepEqual(planAdvisoryStages(plan).map((stage) => stage.role), ["BRD Quality Reviewer"]);
  assert.ok(route("Author a BRD", { profile: "brd" }).fanOut.some((stage) => stage.agentName === "BRD Builder"));
});

test("catalog exposes bounded explicit review and normalized request preserves it", () => {
  const router = new ToolRouter(loadCatalog());
  const { toolId: _toolId, ...input } = request;
  router.validateInput("squad_run", input);
  assert.deepEqual(router.toCoordinatorRequest(router.getTool("squad_run")!, request).review, review);
  assert.deepEqual(coordinatorRequestFromRun({ ...request, params: encodeRunParams(request) }).review, review);
  assert.throws(() => decodeRunParams(JSON.stringify({ review: { ...review, kind: "unknown" } })), /review_input_invalid/);
  for (const invalid of [{ ...review, unexpected: true }, { ...review, targetSha256: "" }, { ...review, document: undefined }]) {
    assert.throws(() => router.validateInput("squad_run", { ...input, review: invalid }));
    assert.throws(() => parseBrdReview(invalid));
  }
});

for (const verdict of ["PASS", "NEEDS_REVIEW", "FAIL"] as const) {
  test(`review ${verdict} completes execution, persists paired schemas and receipt, never changes target`, async () => {
    let calls = 0;
    const f = await fixture(async (input) => {
      assert.ok(!input.tools?.some((entry) => ["delegate_agent", "write_artifact", "finish_stage"].includes(entry.name)));
      return calls++ === 0 ? tool("read_artifact", { path: targetPath }) : tool("finish_brd_review", payload(verdict));
    });
    try {
      const runtime = new ResearchRuntime(f.options);
      const result = await runAdvisoryPipeline(request, { backend: f.options.backend, stageExecutor: runtime }, { mode: "autopilot" });
      assert.equal(result.outcome, "completed", JSON.stringify(result));
      assert.equal(result.stages.length, 1);
      const saved = await f.store.get("tenant-test", "project-test", ".copilot-tracking/reviews/test-review/brd-review-receipt.json");
      assert.ok(saved);
      const receipt = JSON.parse(saved.content);
      assert.equal(receipt.executionStatus, "complete");
      assert.equal(receipt.qualityOutcome, verdict === "PASS" ? "pass" : verdict === "FAIL" ? "blocked" : "revise");
      assert.equal(receipt.humanApprovalInferred, false);
      for (const artifact of receipt.artifacts) assert.equal(sha((await f.store.get("tenant-test", "project-test", artifact.path))!.content), artifact.sha256);
      assert.equal((await f.store.get("tenant-test", "project-test", targetPath))!.content, content);
      assert.equal(calls, 2);
    } finally { await f.cleanup(); }
  });
}

for (const bad of ["hash", "missing", "metadata", "credential"] as const) {
  test(`review ${bad} rejected before any model call`, async () => {
    let calls = 0;
    const f = await fixture(async () => { calls++; throw new Error("unexpected inference"); });
    try {
      const selection = structuredClone(review);
      if (bad === "hash") selection.targetSha256 = "0".repeat(64);
      if (bad === "missing") selection.targetPath = ".copilot-tracking/missing.md";
      if (bad === "metadata") selection.document.id = "WRONG";
      if (bad === "credential") {
        const secret = `Authorization: Bearer ${"testsecret".repeat(8)}`;
        selection.sources = [{ path: ".copilot-tracking/evidence/private.md", content: secret, sha256: sha(secret) }];
      }
      await assert.rejects(new ResearchRuntime(f.options).execute(loadPersonaForRole("BRD Quality Reviewer")!, { ...request, review: selection }, undefined, "brd-reviewer"));
      assert.equal(calls, 0);
    } finally { await f.cleanup(); }
  });
}

test("review cannot finish without complete source evidence or with substituted payload identity", async () => {
  const f = await fixture(async () => tool("finish_brd_review", payload()));
  try {
    await assert.rejects(new ResearchRuntime(f.options).execute(loadPersonaForRole("BRD Quality Reviewer")!, request), (error: unknown) =>
      error instanceof StageBlockedError && error.reason === "review_evidence_missing");
    const args = payload();
    args.report.brd = { ...args.report.brd, id: "substitute" };
    assert.throws(() => validateBrdReviewOutputs(review, args.findings, args.report), /review_payload_identity/);
  } finally { await f.cleanup(); }
});

test("stage boundary resets deadline, human wait is excluded, same-stage resume retains elapsed and run counters", async () => {
  let now = 0;
  let calls = 0;
  const actor: PersonaRecord = { role: "Timer Test", charter: "Use tools.", applyTo: [], tools: ["read/readFile"] };
  const firstPath = ".copilot-tracking/reviews/timer-test/test-review/artifact.md";
  const observedBudgets: { stageModelCalls: { used: number }; runModelCalls: { used: number } }[] = [];
  const f = await fixture(async (input) => {
    observedBudgets.push(JSON.parse(input.system.split("# Server-owned execution budget\n")[1].split("\n")[0]));
    calls++;
    now += 40;
    return calls % 2 === 1 ? tool("write_artifact", { path: firstPath, content: "# Completed stage" }) :
      tool("finish_stage", { status: "complete", readiness: "ready", summary: "Done", artifactPaths: [firstPath], evidenceIds: [] });
  });
  try {
    const runtime = new ResearchRuntime({ ...f.options, now: () => now, deadlineMs: 100 });
    await runtime.execute(actor, { ...request, review: undefined });
    now += 100000;
    await runtime.execute(actor, { ...request, review: undefined });
    assert.equal(calls, 4, "second stage has a fresh allowance despite first stage and outside-stage wait");
    assert.equal(observedBudgets[2].stageModelCalls.used, 1);
    assert.equal(observedBudgets[2].runModelCalls.used, 3);
    let phase = 0;
    f.options.backend.complete = async () => {
      phase++; now += 60;
      return tool("request_human_input", { purpose: "confirmation", question: "Confirm test?", choices: ["Yes"] });
    };
    const hold = new ResearchRuntime({ ...f.options, now: () => now, deadlineMs: 100, allowHumanInput: true });
    let checkpoint;
    try { await hold.execute(actor, { ...request, review: undefined }, undefined, "timer-test"); }
    catch (error) { assert.ok(error instanceof StageInputRequired); checkpoint = error.checkpoint; }
    assert.ok(checkpoint);
    assert.equal(checkpoint.stageElapsedMs, 60);
    now += 100000;
    f.options.backend.complete = async () => { now += 45; return tool("read_artifact", { path: "input/request.md" }); };
    const resumed = new ResearchRuntime({ ...f.options, now: () => now, deadlineMs: 100, allowHumanInput: true,
      continuation: { checkpoint, response: { answer: "Yes", respondedAt: Date.now(), respondedBy: "test-human" } } });
    await assert.rejects(resumed.execute(actor, { ...request, review: undefined }, undefined, "timer-test"),
      (error: unknown) => error instanceof StageBlockedError && error.reason === "stage_deadline");
    delete checkpoint.stageElapsedMs;
    checkpoint.elapsedMs = 101;
    const legacy = new ResearchRuntime({ ...f.options, now: () => now, deadlineMs: 100,
      continuation: { checkpoint, response: { answer: "Yes", respondedAt: Date.now(), respondedBy: "test-human" } } });
    await assert.rejects(legacy.execute(actor, { ...request, review: undefined }, undefined, "timer-test"),
      (error: unknown) => error instanceof StageBlockedError && error.reason === "stage_deadline");
    assert.equal(phase, 1);
  } finally { await f.cleanup(); }
});

test("full paged target and exact inline evidence are mandatory, preserved and non-authoritative", async () => {
  const longContent = `${content}\n${"Bounded legitimate business evidence. ".repeat(2000)}`;
  const source = "D3: six-week internal scenario only; not customer approval.";
  const selected = { ...review, targetSha256: sha(longContent), document: { ...document, id: "TEST-BRD" },
    sources: [{ path: ".copilot-tracking/evidence/decisions.md", sha256: sha(source), content: source }] };
  let calls = 0;
  let nextOffset: number | undefined;
  const evidenceIds: string[] = [];
  const f = await fixture(async (input) => {
    assert.ok(!input.system.includes(source));
    assert.ok(!input.system.includes('"id":"TEST-BRD"'), "caller document identity is not system authority");
    const previous = input.messages.at(-1);
    if (previous?.role === "tool") {
      const returned = JSON.parse(previous.content);
      if (returned.evidence) evidenceIds.push(returned.evidence.id);
      if (returned.path === targetPath) nextOffset = returned.nextOffset;
    }
    calls++;
    if (calls === 1 || nextOffset) {
      const offset = nextOffset ?? 0; nextOffset = undefined;
      return tool("read_artifact", { path: targetPath, offset });
    }
    if (calls === 3) return tool("read_artifact", { path: selected.sources[0].path });
    return tool("finish_brd_review", { ...payload(), evidenceIds });
  });
  try {
    const current = await f.store.get("tenant-test", "project-test", targetPath);
    await f.store.put("tenant-test", "project-test", targetPath, longContent, current!.etag);
    await new ResearchRuntime(f.options).execute(loadPersonaForRole("BRD Quality Reviewer")!, { ...request, review: selected });
    assert.equal(calls, 4);
    assert.equal(evidenceIds.length, 3);
    assert.equal(await f.store.get("tenant-test", "project-test", selected.sources[0].path), undefined, "inline sources are not silently installed into canonical storage");
  } finally { await f.cleanup(); }
});

test("changed source and incomplete paging never produce a completed review receipt", async () => {
  for (const mutate of [false, true]) {
    let calls = 0;
    const longContent = content + "\n" + "x".repeat(65000);
    const f = await fixture(async () => {
      if (calls++ === 0) return tool("read_artifact", { path: targetPath });
      if (mutate) {
        const current = await f.store.get("tenant-test", "project-test", targetPath);
        await f.store.put("tenant-test", "project-test", targetPath, content + "\nChanged", current!.etag);
      }
      return tool("finish_brd_review", payload());
    });
    try {
      if (!mutate) {
        const current = await f.store.get("tenant-test", "project-test", targetPath);
        await f.store.put("tenant-test", "project-test", targetPath, longContent, current!.etag);
      }
      await assert.rejects(new ResearchRuntime(f.options).execute(loadPersonaForRole("BRD Quality Reviewer")!,
        { ...request, review: mutate ? review : { ...review, targetSha256: sha(longContent) } }),
      (error: unknown) => error instanceof StageBlockedError && error.reason === (mutate ? "review_source_changed" : "review_evidence_incomplete"));
      assert.equal(await f.store.get("tenant-test", "project-test", ".copilot-tracking/reviews/test-review/brd-review-receipt.json"), undefined);
    } finally { await f.cleanup(); }
  }
});

for (const attack of ["write_artifact", "delegate_agent", "fetch_documentation"]) {
  test(`independent reviewer cannot invoke ${attack}`, async () => {
    const f = await fixture(async () => tool(attack, {}));
    try {
      await assert.rejects(new ResearchRuntime(f.options).execute(loadPersonaForRole("BRD Quality Reviewer")!, request),
        (error: unknown) => error instanceof StageBlockedError && error.reason === "stage_invalid_tool");
      assert.equal((await f.store.get("tenant-test", "project-test", targetPath))!.content, content);
    } finally { await f.cleanup(); }
  });
}

test("payload validation rejects false pass, fabricated counts, summary metrics, references and unexpected schema fields", () => {
  const mutations = [
    (p: ReturnType<typeof payload>) => { p.report.overall_status = "PASS"; p.findings.iso_29148_attributes.necessary = 1; },
    (p: ReturnType<typeof payload>) => { p.report.summary_counts = { ...p.report.summary_counts, RISK: 10 }; },
    (p: ReturnType<typeof payload>) => { p.report.category_summaries.smart.goals_total = 12; },
    (p: ReturnType<typeof payload>) => { p.findings.fr_ac_coverage.coverage_pct = 0; },
    (p: ReturnType<typeof payload>) => { (p.findings as Record<string, unknown>).gate_decisions = {}; },
    (p: ReturnType<typeof payload>) => { p.report.schema_version = "UNKNOWN"; },
  ];
  for (const mutate of mutations) {
    const p = payload(); mutate(p);
    assert.throws(() => validateBrdReviewOutputs(review, p.findings, p.report), /review_payload_/);
  }
});

test("deadline expiry during a final completion cannot publish review artifacts", async () => {
  let now = 0; let calls = 0;
  const f = await fixture(async () => {
    if (calls++ === 0) return tool("read_artifact", { path: targetPath });
    now = 101;
    return tool("finish_brd_review", payload());
  });
  try {
    await assert.rejects(new ResearchRuntime({ ...f.options, now: () => now, deadlineMs: 100 }).execute(loadPersonaForRole("BRD Quality Reviewer")!, request),
      (error: unknown) => error instanceof StageBlockedError && error.reason === "stage_deadline");
    assert.equal(await f.store.get("tenant-test", "project-test", ".copilot-tracking/reviews/test-review/brd-review-receipt.json"), undefined);
  } finally { await f.cleanup(); }
});

test("memory-backed seeded brd project still dispatches ONLY independent reviewer without history or roster mutation", async () => {
  let calls = 0;
  const f = await fixture(async (input) => {
    assert.match(input.system, /BRD Quality Reviewer/);
    assert.doesNotMatch(JSON.stringify(input), /UNRELATED_DIAGNOSTIC_HISTORY/);
    return calls++ === 0 ? tool("read_artifact", { path: targetPath }) : tool("finish_brd_review", payload());
  });
  try {
    const recorder = new SquadRunRecorder({ store: f.store });
    await recorder.open("tenant-test", "project-test", { ...request, profile: "brd" });
    const rosterBefore = (await f.store.get("tenant-test", "project-test", TEAM_PATH))!.content;
    await f.memory.write("tenant-test", "project-test", "state", "UNRELATED_DIAGNOSTIC_HISTORY");
    const engine = new EmbeddedCoordinator({
      backend: f.options.backend, workspaceManager: f.manager, researchArtifacts: f.store,
      autoMemory: new AutoMemory({ store: f.memory }), runRecorder: recorder,
      quota: new TenantQuotaTracker({ concurrency: 2, monthlyCeilingUsd: 10 }),
    });
    const tool = loadCatalog().tools.find((entry) => entry.id === "squad_run")!;
    const ctx = { auth: { tenantId: "tenant-test", subject: "test-human", scopes: ["Squad.Run"], audience: "fixture" } };
    const queued = await engine.startHttpRun(tool, { ...request, profile: "brd", mode: "autopilot", context: "Keep the selected existing BRD unchanged." }, ctx);
    assert.equal(queued.outcome, "held", "Existing entry gate remains enforced.");
    assert.equal((await engine.approveRun(queued.runId!, ctx)).ok, true);
    const result = await engine.pollRun(queued.runId!, ctx);
    assert.equal(result.outcome, "completed", JSON.stringify(result));
    assert.equal(calls, 2);
    assert.equal((await f.store.get("tenant-test", "project-test", TEAM_PATH))!.content, rosterBefore);
  } finally { await f.cleanup(); }
});
