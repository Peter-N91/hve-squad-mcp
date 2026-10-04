import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Ajv } from "ajv";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { MemoryBackedArtifactStore, type SquadArtifactStore } from "../src/engine/artifact-store.js";
import { FileSquadMemoryStore } from "../src/engine/backends/file-squad-memory.js";
import {
  ResearchRuntime,
  StageBlockedError,
  MAX_BUNDLE_RESOURCE_CHARS,
  MAX_LOADED_AUTHORITY_CHARS,
  TEXT_ONLY_REPORT_CHARTER,
  TEXT_ONLY_REPORT_LIMITS,
} from "../src/engine/research-runtime.js";
import { resolveSquadGithubRoot } from "../src/paths.js";
import { AdvisoryBundle } from "../src/engine/advisory-bundle.js";
import { EphemeralWorkspaceManager } from "../src/engine/workspace.js";
import { runAdvisoryPipeline } from "../src/engine/advisory-pipeline.js";
import {
  ModelBackendError,
  type BackendRequest,
  type BackendResult,
  type CompletionUsageRecord,
  type ModelBackend,
} from "../src/engine/model-backend.js";
import { loadPersonaForRole, type PersonaRecord } from "../src/engine/persona-loader.js";
import { EmbeddedCoordinator } from "../src/engine/embedded.js";
import { AutoMemory } from "../src/engine/auto-memory.js";
import { EphemeralRunStateStore } from "../src/engine/run-state.js";
import { RunCostLedger, RunStoreApprovalChannel, TenantQuotaTracker } from "../src/engine/gates.js";
import { loadCatalog } from "../src/catalog/catalog.js";
import { renderEmbeddedResult } from "../src/engine/render-embedded.js";
import { defaultProfileTables, deliverableRootFor } from "../src/engine/profiles.js";
import { planning, research as researchArtifact } from "./helpers/advisory-artifacts.js";
import { StoreAdvisoryPersistence } from "../src/engine/advisory-run-store.js";
import { WORKER_EXECUTION_OPTIONS } from "../src/engine/run-worker.js";

const primary = ".copilot-tracking/research/2026-09-18/run-1-research.md";
const lane = ".copilot-tracking/research/2026-09-18/subagents/run-1/lane.md";
const research: PersonaRecord = {
  role: "Squad Researcher",
  charter: "Use the native research contract. Delegate read-only RPI Researcher lanes and verify evidence independently.",
  tools: ["delegate_research"],
  applyTo: [],
};
const request = { toolId: "squad_run", request: "Prepare a BRD for a delivery dashboard using the supplied brief.", context: "The brief requires weekly refresh. Stakeholder signoff is unresolved." };

for (const reason of ["queued", "queued_for_worker", "run_already_in_flight"]) {
  test(`unfinished work (${reason}) does not render a fabricated Human Gate`, () => {
    const rendered = renderEmbeddedResult({
      kind: "embedded", outcome: "held", reason, runId: "run-1",
      matchedRouting: { routingIntent: "research", role: "Squad Coordinator", tier: "confirm", council: [], parallelEligible: false, catchAll: true, gates: true },
    });
    assert.match(rendered.content[0].text, /Work queued or running/);
    assert.doesNotMatch(rendered.content[0].text, /Human Gate|must approve|squad_approve/);
  });
}

function call(name: string, args: Record<string, unknown>): BackendResult {
  return { text: "", finishReason: "tool_calls", backendId: "test-tools", usage: { estimatedCostUsd: 0.01 },
    toolCalls: [{ id: `${name}-call`, name, arguments: JSON.stringify(args) }] };
}

interface TestActorAssignment {
  writeScope: { exactPaths: string[]; prefixes: string[] };
  permittedPaths: string[];
}

function actorAssignment(input: BackendRequest): TestActorAssignment {
  const value = input.system
    .split("# Server-owned actor assignment\n")[1]
    .split("\n\n# Server-owned execution budget\n")[0];
  return JSON.parse(value) as TestActorAssignment;
}

const finish = (path: string, evidenceIds = ["E1"], extra: Record<string, unknown> = {}) => call("finish_stage", {
  status: "complete", readiness: "ready-with-gaps", summary: "Evidence-grounded findings; stakeholder approval remains a gap.",
  artifactPaths: [path], evidenceIds, ...extra,
});
const finishSuggestions = (evidenceIds = ["E1"]) => call("finish_stage", {
  status: "complete", readiness: evidenceIds.length ? "ready" : "ready-with-gaps",
  summary: "Candidate source pointers and excerpts; all suggestions are unverified.",
  artifactPaths: [], evidenceIds,
});
const contract = {
  cycle: 1, wave: "Wider", laneType: "internal", topic: "Brief traceability",
  questions: ["What refresh frequency is specified?"], criteria: ["Quote the supplied brief without treating it as independently verified."],
  scope: "Supplied brief only", nonGoals: "No implementation or approval", posture: "focused", limits: "One source",
  permittedPaths: ["input/context.md"], externalSources: [], lanePath: lane, primaryPath: primary,
};

function successfulResearch(): BackendResult[] {
  const content = researchArtifact("executed", {
    "convergence | analysis | audit | comparison | research-only | no-handoff": "convergence",
    "Ready | Not ready | Not applicable | Blocked": "Ready",
  }).replace("## Findings Mapped to Questions and Evidence",
    "## Findings Mapped to Questions and Evidence\n\nC1: E2 input/context.md:1 requires weekly refresh. Lane evidence is E2. Stakeholder signoff remains unresolved; no approval inferred.");
  return [
    call("load_instruction", { path: "squad/squad-routing.instructions.md" }),
    call("write_artifact", { path: primary, content: "# Research\n\nScope: supplied brief. Status: researching." }),
    call("delegate_research", contract),
    call("read_artifact", { path: "input/context.md" }),
    call("list_bundle", { kind: "instructions", offset: 0 }),
    finishSuggestions(),
    call("read_artifact", { path: "input/context.md" }),
    call("list_artifacts", {}),
    call("write_artifact", { path: primary, content }),
    finish(primary, ["E2"]),
  ];
}

class ScriptedTools implements ModelBackend {
  readonly id = "test-tools";
  readonly supportsTools = true;
  readonly seen: BackendRequest[] = [];
  constructor(private readonly responses: BackendResult[]) {}
  async complete(input: BackendRequest): Promise<BackendResult> {
    this.seen.push(structuredClone({ ...input, signal: undefined }));
    const response = this.responses.shift();
    assert.ok(response, "Unexpected extra model completion");
    return response;
  }
}

async function fixture(responses: BackendResult[], storeOverride?: (store: SquadArtifactStore) => SquadArtifactStore) {
  const root = await mkdtemp(join(tmpdir(), "research-runtime-"));
  const githubRoot = join(root, "cast");
  await mkdir(join(githubRoot, "instructions", "squad"), { recursive: true });
  await mkdir(join(githubRoot, "agents"), { recursive: true });
  for (const instruction of [
    "squad-routing.instructions.md", "squad-autonomous.instructions.md",
    "squad-autopilot.instructions.md", "squad-intake-gate.instructions.md",
    "squad-roster.instructions.md",
  ]) {
    await writeFile(join(githubRoot, "instructions", "squad", instruction),
      `# Trusted instruction: ${instruction}\nUse bounded native procedures and preserve human gates.`);
  }
  await writeFile(join(githubRoot, "agents", "rpi-researcher.agent.md"),
    "---\nname: RPI Researcher\n---\nGather candidate sources as suggestions. Read only; do not create or edit files.");
  const workspace = await new EphemeralWorkspaceManager({ baseDir: join(root, "workspaces") }).allocate("tenant-a");
  const store = new MemoryBackedArtifactStore(new FileSquadMemoryStore({ baseDir: join(root, "memory") }));
  const backend = new ScriptedTools(responses);
  let cost = 0;
  const runtime = new ResearchRuntime({
    backend, workspace, store: storeOverride?.(store) ?? store, project: "project-a", runId: "run-1",
    githubRoot, date: "2026-09-18", onUsage: (usage) => { cost += usage.estimatedCostUsd ?? 0; },
  });
  return { root, githubRoot, workspace, store, backend, runtime, cost: () => cost,
    cleanup: async () => { await workspace.dispose(); await rm(root, { recursive: true, force: true }); } };
}

test("large stored sources page within read bounds with exact ranged evidence and original line numbers", async () => {
  const source = ".copilot-tracking/squad/history/prior.md";
  const output = ".copilot-tracking/reviews/test-advisor/run-1/artifact.md";
  const content = `${"a\n".repeat(32_000)}second page`;
  const f = await fixture([
    call("read_artifact", { path: source }),
    call("read_artifact", { path: source, offset: 64_000 }),
    call("write_artifact", { path: output, content: "# Findings\nE1 and E2 cover the prior source." }),
    finish(output, ["E1", "E2"]),
  ]);
  try {
    await f.store.put("tenant-a", "project-a", source, content);
    await f.runtime.execute({ role: "Test Advisor", charter: "Read evidence.", applyTo: [] }, request);
    const pages = f.backend.seen[2].messages.filter(entry => entry.role === "tool").map(entry => JSON.parse(entry.content));
    assert.equal(pages[0].nextOffset, 64_000);
    assert.equal(pages[1].nextOffset, null);
    assert.equal(pages[1].content, "32001: second page");
    for (let i = 0; i < 2; i += 1) {
      const page = pages[i];
      assert.equal(page.truncated, true);
      assert.ok(page.endOffset - page.offset <= 64_000);
      assert.equal(page.evidence.contentSha256, createHash("sha256").update(content.slice(page.offset, page.endOffset)).digest("hex"));
      assert.deepEqual(page.evidence.range, {
        offset: page.offset, endOffset: page.endOffset, totalCharacters: content.length,
        sourceSha256: createHash("sha256").update(content).digest("hex"),
      });

    }
    const saved = JSON.parse((await f.store.get("tenant-a", "project-a", `${output}.sources.json`))!.content);
    assert.deepEqual(saved.evidence, pages.map(page => page.evidence));
  } finally { await f.cleanup(); }
});

test("text-only report mode restricts tools, writes one report, and applies a small execution budget", async () => {
  const source = ".copilot-tracking/research/2026-09-18/run-prior-research.md";
  const output = ".copilot-tracking/changes/run-1/artifact.md";
  const f = await fixture([
    call("read_artifact", { path: source }),
    call("write_artifact", { path: output, content: "# Research report\n\nThe cited evidence supports the finding (E1). Keep the open decision unresolved." }),
    finish(output, ["E1"]),
  ]);
  try {
    await f.store.put("tenant-a", "project-a", source, "# Research findings\n\nHTTP 429 source evidence and an unresolved count choice.");
    const implementor: PersonaRecord = {
      role: "Squad Implementor",
      charter: "The ordinary implementor may edit source code and run commands.",
      applyTo: [],
    };
    await f.runtime.execute(implementor, request, "Prior research was completed.", "developer", undefined, "text-only-report");

    const expectedTools = ["finish_stage", "list_artifacts", "read_artifact", "write_artifact"];
    assert.deepEqual(f.backend.seen[0].tools?.map((entry) => entry.name).sort(), expectedTools);
    assert.ok(f.backend.seen.every((entry) => JSON.stringify(entry.tools?.map((tool) => tool.name).sort()) === JSON.stringify(expectedTools)));
    assert.deepEqual(actorAssignment(f.backend.seen[0]).writeScope, { exactPaths: [output], prefixes: [] });
    assert.ok(f.backend.seen[0].system.includes(TEXT_ONLY_REPORT_CHARTER));
    assert.match(f.backend.seen[0].system, new RegExp(`"limit":${TEXT_ONLY_REPORT_LIMITS.modelCalls}`));
    assert.match(JSON.stringify(f.backend.seen[0].tools), new RegExp(output.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match((await f.store.get("tenant-a", "project-a", output))!.content, /open decision unresolved/);
  } finally { await f.cleanup(); }
});

test("paging rejects invalid offsets without evidence and preserves Unicode boundaries", async () => {
  const source = ".copilot-tracking/squad/history/unicode.md";
  const output = ".copilot-tracking/reviews/test-advisor/run-1/artifact.md";
  const content = `${"a".repeat(63_999)}\uD83D\uDE00tail`;
  const f = await fixture([
    call("read_artifact", { path: source, offset: content.length }),
    call("read_artifact", { path: source, offset: 64_000 }),
    call("read_artifact", { path: source }),
    call("read_artifact", { path: source, offset: 63_999 }),
    call("write_artifact", { path: output, content: "# Findings\nE1 E2" }),
    finish(output, ["E1", "E2"]),
  ]);
  try {
    await f.store.put("tenant-a", "project-a", source, content);
    await f.runtime.execute({ role: "Test Advisor", charter: "Read evidence.", applyTo: [] }, request);
    const results = f.backend.seen[4].messages.filter(entry => entry.role === "tool").map(entry => JSON.parse(entry.content));
    for (const result of results.slice(0, 2)) {
      assert.equal(result.status, "invalid_range");
      assert.equal(result.evidence, undefined);
      assert.equal(result.content, undefined);
    }
    assert.equal(results[2].nextOffset, 63_999);
    assert.equal(results[3].content, "1: \uD83D\uDE00tail");
    assert.equal(results[3].startsMidLine, true);
  } finally { await f.cleanup(); }
});

test("paged reads retain delegated lane read scope enforcement", async () => {
  const f = await fixture([
    ...successfulResearch().slice(0, 4),
    call("read_artifact", { path: ".copilot-tracking/squad/history/not-permitted.md", offset: 64_000 }),
    finish(primary),
  ]);
  try {
    await assert.rejects(f.runtime.execute(research, request),
      (error: unknown) => error instanceof StageBlockedError && error.reason === "research_evidence_gate");
    const blocked = JSON.parse(f.backend.seen.at(-1)!.messages.filter(entry => entry.role === "tool").at(-1)!.content);
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.reason, "stage_source_scope");
    assert.equal(blocked.evidence, undefined);
  } finally { await f.cleanup(); }
});

test("parent repairs canonical claim labels that omitted actual evidence receipts before completing", async () => {
    const responses = successfulResearch();
    const index = 8;
    const originalWrite = responses[index];
    const originalArgs = JSON.parse(originalWrite.toolCalls![0].arguments);
    const path = primary;
    const evidenceIds = ["E2"];
    responses.splice(index, 1,
      call("write_artifact", { ...originalArgs, content: originalArgs.content.replace(/\bE(\d+)\b/g, "C$1") }),
      finish(path, evidenceIds),
      originalWrite);
    const f = await fixture(responses);
    try {
      await f.runtime.execute(research, request);
      const receipts = f.backend.seen.flatMap((entry) => entry.messages)
        .filter((entry) => entry.role === "tool").map((entry) => JSON.parse(entry.content));
      const repair = receipts.find((entry) => entry.issue === "missing_artifact_citations");
      assert.equal(repair.status, "blocked");
      assert.equal(repair.retryable, true);
      assert.deepEqual(repair.requiredAction, { tool: "write_artifact", path });
      assert.deepEqual(repair.missingEvidence.map((entry: { id: string }) => entry.id), evidenceIds);
      assert.ok(repair.missingEvidence.every((entry: { source: string; contentSha256: string }) =>
        entry.source && /^[0-9a-f]{64}$/.test(entry.contentSha256)));
      assert.match((await f.store.get("tenant-a", "project-a", path))!.content, /\bE2\b/);
      assert.ok(await f.store.get("tenant-a", "project-a", `${path}.sources.json`));
      assert.match(f.backend.seen[0].system, /Canonical C#\/X# claim labels do not replace those receipts/);
    } finally { await f.cleanup(); }
});

for (const target of ["parent", "lane"] as const) {
  test(`${target} can discover the actual source after an in-scope artifact is absent`, async () => {
    const missing = ".copilot-tracking/research/missing-source.md";
    const responses = successfulResearch();
    if (target === "lane") {
      responses[2] = call("delegate_research", { ...contract, permittedPaths: [...contract.permittedPaths, missing] });
    }
    responses.splice(target === "parent" ? 2 : 4, 0,
      call("read_artifact", { path: missing }),
      call("list_artifacts", {}));
    const f = await fixture(responses);
    try {
      await f.runtime.execute(research, request);
      const receipts = f.backend.seen.flatMap((entry) => entry.messages)
        .filter((entry) => entry.role === "tool").map((entry) => JSON.parse(entry.content));
      const absent = receipts.find((entry) => entry.path === missing);
      assert.equal(absent.status, "unavailable");
      assert.equal(absent.exists, false);
      assert.equal(absent.reason, "stage_source_unavailable");
      assert.ok(absent.detail.includes(missing));
      assert.equal(absent.content, undefined);
      assert.equal(absent.evidence, undefined);
      assert.deepEqual(absent.requiredAction, { tool: "list_artifacts" });
      assert.ok(receipts.some((entry) => entry.evidence?.id === "E1" && entry.evidence.source === "input/context.md"));
      assert.equal(await f.store.get("tenant-a", "project-a", missing), undefined);
    } finally { await f.cleanup(); }
  });
}

test("a missing artifact cannot supply a fabricated evidence receipt or complete research", async () => {
  const missing = ".copilot-tracking/research/missing-source.md";
  const responses = successfulResearch().slice(0, 2);
  responses.push(call("read_artifact", { path: missing }), finish(primary));
  const f = await fixture(responses);
  try {
    await assert.rejects(f.runtime.execute(research, request),
      (error: unknown) => error instanceof StageBlockedError && error.reason === "research_evidence_gate");
    assert.equal(await f.store.get("tenant-a", "project-a", `${primary}.sources.json`), undefined);
  } finally { await f.cleanup(); }
});

test("artifact storage failures are not converted into recoverable missing sources", async () => {
  const missing = ".copilot-tracking/research/missing-source.md";
  const failure = new Error("Storage request failed");
  const f = await fixture([call("read_artifact", { path: missing })], (store) => ({
    get: async (tenant, project, path) => {
      if (path === missing) throw failure;
      return store.get(tenant, project, path);
    },
    put: store.put.bind(store), append: store.append.bind(store), list: store.list.bind(store),
  }));
  try {
    await assert.rejects(f.runtime.execute(research, request), (error: unknown) => error === failure);
  } finally { await f.cleanup(); }
});

for (const operation of [
  call("load_instruction", { path: "absent.instructions.md" }),
  call("load_instruction", { path: "absent.instructions.md" }),
  call("read_reference", { path: "instructions/squad/absent.md" }),
  call("load_instruction", { path: "missing.instructions.md" }),
]) {
  test(`${operation.toolCalls?.[0].name} unavailable lookup can discover and load actual pinned resources`, async () => {
    const f = await fixture([operation, call("list_references", { kind: "instructions", offset: 0 }), ...successfulResearch()]);
    try {
      await mkdir(join(f.githubRoot, "instructions"), { recursive: true });
      await f.runtime.execute(research, request);
      const receipts = f.backend.seen[1].messages.filter((entry) => entry.role === "tool").map((entry) => JSON.parse(entry.content));
      assert.equal(receipts.at(-1).status, "unavailable");
      assert.equal(receipts.at(-1).loaded, false);
      assert.equal(receipts.at(-1).reason, "stage_instruction_unavailable");
      assert.match(receipts.at(-1).detail, /Requested resource:/);
      assert.equal(receipts.at(-1).content, undefined);
      const listed = f.backend.seen[2].messages.filter((entry) => entry.role === "tool").map((entry) => JSON.parse(entry.content)).at(-1);
      assert.ok(listed.paths.includes("instructions/squad/squad-routing.instructions.md"));
      assert.ok(await f.store.get("tenant-a", "project-a", `${primary}.sources.json`));
    } finally { await f.cleanup(); }
  });
}

test("an unavailable optional instruction lookup does not derail native research", async () => {
  const responses = successfulResearch();
  responses[0] = call("load_instruction", { path: "absent.instructions.md" });
  const f = await fixture(responses);
  try {
    const result = await f.runtime.execute(research, request);
    assert.match(result.text, /Evidence-grounded findings/);
    assert.ok(await f.store.get("tenant-a", "project-a", `${primary}.sources.json`));
  } finally { await f.cleanup(); }
});

test("repeated unavailable bundle lookups cannot reset the shared execution budget", async () => {
  const f = await fixture(Array.from({ length: 60 }, () => call("load_instruction", { path: "absent.instructions.md" })));
  try {
    await assert.rejects(f.runtime.execute(research, request),
      (error: unknown) => error instanceof StageBlockedError && error.reason === "stage_execution_limit");
    assert.equal(f.backend.seen.length, 60);
  } finally { await f.cleanup(); }
});

test("unrepaired missing citations cannot complete or reset the shared execution budget", async () => {
  const responses = successfulResearch();
  const originalArgs = JSON.parse(responses[8].toolCalls![0].arguments);
  const incomplete = originalArgs.content.replace(/\bE(\d+)\b/g, "C$1");
  responses.splice(8, 2,
    call("write_artifact", { ...originalArgs, content: incomplete }),
    ...Array.from({ length: 60 }, () => finish(primary, ["E2"])));
  const f = await fixture(responses);
  try {
    await assert.rejects(f.runtime.execute(research, request),
      (error: unknown) => error instanceof StageBlockedError && error.reason === "stage_execution_limit");
    assert.equal(f.backend.seen.length, 60);
    assert.equal((await f.store.get("tenant-a", "project-a", primary))!.content, incomplete);
    assert.equal(await f.store.get("tenant-a", "project-a", `${primary}.sources.json`), undefined);
  } finally { await f.cleanup(); }
});

test("the read-only research worker returns suggestions without creating a lane artifact", async () => {
  const f = await fixture(successfulResearch());
  try {
    const result = await f.runtime.execute(research, request);
    assert.match(result.text, /Evidence-grounded findings/);
    assert.equal(await f.store.get("tenant-a", "project-a", lane), undefined);
    assert.ok(await f.store.get("tenant-a", "project-a", primary));
    assert.match(f.backend.seen[3].system, /"researchDelegationEnabled":false/);
    assert.ok(f.backend.seen[3].tools?.every((tool) => tool.name !== "write_artifact"));
  } finally { await f.cleanup(); }
});

test("lane preflight does not recover or disclose an out-of-scope read", async () => {
  const f = await fixture([
    ...successfulResearch().slice(0, 3),
    call("read_artifact", { path: "input/not-permitted.md" }),
    finish(primary),
  ]);
  try {
    await assert.rejects(f.runtime.execute(research, request),
      (error: unknown) => error instanceof StageBlockedError && error.reason === "research_evidence_gate");
    const blocked = f.backend.seen.at(-1)?.messages.filter((entry) => entry.role === "tool").at(-1);
    assert.ok(blocked);
    const result = JSON.parse(blocked.content);
    assert.equal(result.status, "blocked");
    assert.equal(result.reason, "stage_source_scope");
    assert.equal(await f.store.get("tenant-a", "project-a", lane), undefined);
  } finally { await f.cleanup(); }
});

test("a read-only research worker can fetch a permitted external source without writing a lane artifact", async () => {
  const url = "https://learn.microsoft.com/en-us/azure/architecture/";
  const responses = successfulResearch();
  responses[2] = call("delegate_research", { ...contract, laneType: "hybrid", externalSources: [url] });
  responses[3] = call("fetch_documentation", { url });
  const f = await fixture(responses);
  let fetched = false;
  try {
    const runtime = new ResearchRuntime({
      backend: f.backend, workspace: f.workspace, store: f.store, project: "project-a", runId: "run-1",
      githubRoot: f.githubRoot, date: "2026-09-18",
      fetchImpl: async () => {
        fetched = true;
        return new Response("<main><h1>Architecture</h1><p>Permitted external source</p></main>", {
          headers: { "content-type": "text/html" },
        });
      },
    });
    await runtime.execute(research, request);
    assert.equal(fetched, true);
    const workerTools = f.backend.seen[4].messages.filter((entry) => entry.role === "tool");
    const outputs = workerTools.map((entry) => JSON.parse(entry.content) as {
      evidence?: { source?: unknown };
    });
    assert.ok(outputs.some((output) => output.evidence?.source === url));
    assert.equal(await f.store.get("tenant-a", "project-a", lane), undefined);
    assert.ok(await f.store.get("tenant-a", "project-a", primary));
  } finally { await f.cleanup(); }
});

test("worker research continues beyond the old inline deadline with artifact gates intact", async (t) => {
  const f = await fixture(successfulResearch());
  try {
    t.mock.timers.enable({ apis: ["Date"] });
    const runtime = new ResearchRuntime({
      backend: f.backend, workspace: f.workspace, store: f.store, project: "project-a", runId: "run-1",
      githubRoot: f.githubRoot, date: "2026-09-18", deadlineMs: WORKER_EXECUTION_OPTIONS.stageDeadlineMs,
    });
    t.mock.timers.tick(4 * 60 * 1000);
    const result = await runtime.execute(research, request);
    assert.match(result.text, /Evidence-grounded findings/);
    assert.ok(await f.store.get("tenant-a", "project-a", primary));
    assert.ok(f.backend.seen.every((input) => input.toolChoice === "required"),
      "every actor turn must request a native tool call, including delegated lanes");
  } finally { t.mock.timers.reset(); await f.cleanup(); }
});

for (const deadlineMs of [undefined, WORKER_EXECUTION_OPTIONS.stageDeadlineMs]) {
  test(`${deadlineMs ? "worker" : "inline"} active deadline fails closed before another completion`, async (t) => {
    const f = await fixture([]);
    try {
      t.mock.timers.enable({ apis: ["Date"] });
      const runtime = new ResearchRuntime({
        backend: f.backend, workspace: f.workspace, store: f.store, project: "project-a", runId: "run-1",
        githubRoot: f.githubRoot, date: "2026-09-18", deadlineMs,
        now: (() => {
          let reads = 0;
          return () => reads++ === 0 ? 0 : (deadlineMs ?? 180_000) + 1;
        })(),
      });
      await assert.rejects(runtime.execute(research, request),
        (error: unknown) => error instanceof StageBlockedError && error.reason === "stage_deadline");
      assert.equal(f.backend.seen.length, 0);
    } finally { t.mock.timers.reset(); await f.cleanup(); }
  });
}

test("research executes actual lane tools and persists exact artifacts and dispatch history before planning", async () => {
  const f = await fixture(successfulResearch());
  try {
    let planCalls = 0;
    const result = await runAdvisoryPipeline(request, {
      backend: f.backend,
      stageExecutor: { execute: async (persona, req, prior, role) => {
        if (persona.role === research.role) return f.runtime.execute(persona, req, prior, role);
        planCalls++;
        assert.match(prior ?? "", /C1: E2/);
        assert.equal(await f.store.get("tenant-a", "project-a", lane), undefined);
        return { text: "A plan grounded in the persisted research.", backendId: "test-tools", finishReason: "stop" };
      } },
    }, { mode: "autopilot", plan: [
      { kind: "persona", role: research.role, persona: research, roleKey: "researcher" },
      { kind: "persona", role: "Squad Lead", persona: { role: "Squad Lead", charter: "Plan from evidence.", applyTo: [] } },
    ] });
    assert.equal(result.outcome, "completed");
    assert.equal(planCalls, 1);
    assert.equal(f.backend.seen.length, 10);
    assert.ok(Math.abs(f.cost() - 0.1) < 0.0001, "Every parent and worker completion is charged.");
    const content = await readFile(f.workspace.resolve(primary), "utf8");
    assert.equal((await f.store.get("tenant-a", "project-a", primary))?.content, content);
    const reopened = new MemoryBackedArtifactStore(new FileSquadMemoryStore({ baseDir: join(f.root, "memory") }));
    assert.equal((await reopened.get("tenant-a", "project-a", primary))?.content, content);
    const provenance = await reopened.get("tenant-a", "project-a", `${primary}.sources.json`);
    assert.ok(provenance);
    assert.match(provenance.content, /contentSha256/);
    assert.match(provenance.content, /input\/context.md/);
    assert.equal(await reopened.get("tenant-b", "project-a", primary), undefined);
    assert.equal(await reopened.get("tenant-a", "project-b", primary), undefined);
    assert.match((await reopened.get("tenant-a", "project-a", ".copilot-tracking/squad/history/squad-researcher.md"))?.content ?? "", /Status: complete/);
    assert.ok(f.backend.seen[3].tools?.every((tool) => !tool.name.startsWith("delegate_")), "Worker has no recursive delegation tools.");
    assert.ok(f.backend.seen.every((entry) => !entry.system.includes(request.context)), "Caller context never becomes system authority.");
    assert.match(f.backend.seen[1].system, /Trusted instruction: squad-routing\.instructions\.md/,
      "The host, not arbitrary tool text, installs the pinned instruction as authority.");
  } finally { await f.cleanup(); }
});

test("native procedures replace hidden skill preloads and keep a stable prompt prefix", async () => {
  const f = await fixture(successfulResearch().slice(1));
  try {
    const result = await f.runtime.execute(research, request);
    assert.equal(f.backend.seen.length, 9);
    assert.equal(result.usage?.completionCount, 9);
    assert.ok(Math.abs((result.usage?.estimatedCostUsd ?? 0) - 0.09) < 0.0001);
    assert.match(f.backend.seen[0].system, /RPI Researcher is a read-only source finder/);
    assert.ok(f.backend.seen.every((entry) => !entry.tools?.some((tool) => tool.name === "load_skill")));
    assert.ok(
      f.backend.seen.every((entry) =>
        entry.system.indexOf("# Server-owned actor assignment") <
        entry.system.indexOf("# Server-owned execution budget")),
      "Changing execution counters must follow stable authority and assignment content.",
    );
    const stablePrefixes = f.backend.seen.map((entry) =>
      entry.system.split("# Server-owned execution budget\n")[0]);
    assert.equal(new Set(stablePrefixes).size, 2,
      "Only the parent and delegated actor have distinct stable prompt prefixes.");
  } finally { await f.cleanup(); }
});

test("delegated completion aggregates are returned without charging the run ledger twice", async () => {
  const f = await fixture(successfulResearch().slice(1));
  const costLedger = new RunCostLedger({ ceilingUsd: 1 });
  try {
    const result = await runAdvisoryPipeline(request, {
      backend: f.backend,
      stageExecutor: f.runtime,
      costLedger,
    }, {
      mode: "autopilot",
      plan: [{ kind: "persona", role: research.role, persona: research, roleKey: "researcher" }],
    });
    assert.equal(result.outcome, "completed");
    assert.equal(result.usage[0].completionCount, 9);
    assert.ok(Math.abs(costLedger.spentUsd() - 0.09) < 1e-9);
    assert.ok(Math.abs(result.costUsd - 0.09) < 1e-9);
  } finally { await f.cleanup(); }
});

test("failed provider usage is attributed before the stage fails", async () => {
  const f = await fixture([]);
  const records: CompletionUsageRecord[] = [];
  const backend: ModelBackend = {
    id: "failed-backend",
    supportsTools: true,
    complete: async () => {
      throw new ModelBackendError("output_limit", {
        providerCode: "max_output_tokens",
        deployment: "deployment-a",
        usage: {
          completionCount: 1,
          attemptCount: 1,
          inputTokens: 100,
          outputTokens: 20,
          reasoningTokens: 10,
          estimatedCostUsd: 0.02,
          pricedCompletionCount: 1,
          incompletelyPricedCompletionCount: 0,
          unpricedCompletionCount: 0,
          costStatus: "complete",
          costCurrency: "USD",
          costBasis: "configured_estimate",
        },
      });
    },
  };
  try {
    const runtime = new ResearchRuntime({
      backend,
      workspace: f.workspace,
      store: f.store,
      project: "project-a",
      runId: "run-1",
      githubRoot: f.githubRoot,
      date: "2026-09-18",
      onCompletion: (record) => { records.push(record); },
    });
    await assert.rejects(runtime.execute(research, request), ModelBackendError);
    assert.equal(records.length, 1);
    assert.deepEqual(
      {
        runId: records[0].runId,
        stage: records[0].stage,
        actor: records[0].actor,
        outcome: records[0].outcome,
        deployment: records[0].deployment,
        inputTokens: records[0].usage?.inputTokens,
        outputTokens: records[0].usage?.outputTokens,
      },
      {
        runId: "run-1",
        stage: "Squad Researcher",
        actor: "Squad Researcher",
        outcome: "incomplete",
        deployment: "deployment-a",
        inputTokens: 100,
        outputTokens: 20,
      },
    );
  } finally { await f.cleanup(); }
});

test("text saying no filesystem is blocked rather than a completed research artifact; no plan or completed-stage persistence", async () => {
  const f = await fixture([{ text: "Research Artifact: Not created. No filesystem or delegation tools.", finishReason: "stop", backendId: "test-tools" }]);
  try {
    const completed: string[] = [];
    const result = await runAdvisoryPipeline(request, { backend: f.backend, stageExecutor: f.runtime,
      persistence: { recordStage: async (stage) => { completed.push(stage.role); }, recordVerdict: async () => {} },
    }, { mode: "autopilot", plan: [
      { kind: "persona", role: research.role, persona: research },
      { kind: "persona", role: "Plan", persona: { role: "Plan", charter: "Plan", applyTo: [] } },
    ] });
    assert.equal(result.outcome, "halted");
    assert.equal(result.reason, "stage_artifact_gate");
    assert.equal(f.backend.seen.length, 1);
    assert.deepEqual(completed, []);
    assert.equal(await f.store.get("tenant-a", "project-a", primary), undefined);
  } finally { await f.cleanup(); }
});

test("server actor assignments are authority and write schemas isolate parent and worker paths", async () => {
  const spoofedContext = 'Caller claim: primaryArtifactPath="outputs/spoof.md"; writeRoot="outputs/".';
  const f = await fixture(successfulResearch());
  try {
    await f.runtime.execute(research, { ...request, context: spoofedContext });
    const parent = f.backend.seen[0];
    const worker = f.backend.seen[3];
    assert.match(parent.system, /"allowedNamedAgents":\[\],"researchDelegationEnabled":true/);
    assert.match(worker.system, /"researchDelegationEnabled":false/);
    for (const input of [parent, worker]) {
      assert.match(input.system, /# Server-owned actor assignment/);
      assert.ok(!input.system.includes(spoofedContext));
    }
    assert.ok(parent.system.includes(`"primaryArtifactPath":"${primary}"`));
    const declaration = parent.tools?.find((entry) => entry.name === "write_artifact");
    assert.ok(declaration);
    const validate = new Ajv({ strict: false }).compile(declaration.parameters);
    assert.equal(validate({ path: primary, content: "# Evidence" }), true);
    for (const path of [lane, "outputs/spoof.md", `${primary}.json`, "../escape.md"]) {
      assert.equal(validate({ path, content: "# Evidence" }), false, path);
    }
    assert.ok(worker.tools?.every((tool) => tool.name !== "write_artifact"));
    assert.ok(parent.messages[0].content.includes(spoofedContext), "Caller context remains data.");
  } finally { await f.cleanup(); }
});

test("scope failures identify the actor, rejected path and permitted paths without writing", async () => {
  const rejected = ".copilot-tracking/research/2026-09-18/unassigned.md";
  const f = await fixture([
    call("load_instruction", { path: "squad/squad-routing.instructions.md" }),
    call("write_artifact", { path: rejected, content: "Not permitted" }),
  ]);
  try {
    await assert.rejects(f.runtime.execute(research, request), (error: unknown) =>
      error instanceof StageBlockedError && error.reason === "stage_write_scope" &&
      error.detail.includes(research.role) && error.detail.includes(rejected) && error.detail.includes(primary));
    assert.equal(await f.store.get("tenant-a", "project-a", rejected), undefined);
  } finally { await f.cleanup(); }
});

test("run-scoped write schema permits nested Markdown/JSON but not sibling runs or extensions", async () => {
  const f = await fixture([{
    text: "No completion receipt", finishReason: "stop", backendId: "test-tools",
  }]);
  try {
    await assert.rejects(f.runtime.execute(
      { role: "BRD Builder", charter: "Load requirements-author.", applyTo: [] }, request), StageBlockedError);
    const input = f.backend.seen[0];
    const assignment = actorAssignment(input);
    const declaration = input.tools?.find((entry) => entry.name === "write_artifact");
    assert.ok(declaration);
    const validate = new Ajv({ strict: false }).compile(declaration.parameters);
    for (const prefix of assignment.writeScope.prefixes as string[]) {
      assert.equal(validate({ path: `${prefix}nested/notes.md`, content: "notes" }), true);
      assert.equal(validate({ path: `${prefix}state.json`, content: "{}" }), true);
      assert.equal(validate({ path: `${prefix}script.ts`, content: "code" }), false);
      assert.equal(validate({ path: `${prefix.replace("run-1/", "run-10/")}notes.md`, content: "notes" }), false);
    }
    assert.equal(assignment.writeScope.prefixes.length, 2);
  } finally { await f.cleanup(); }
});

test("real research charter fails before inference when no server runtime is wired", async () => {
  const backend = new ScriptedTools([]);
  const result = await runAdvisoryPipeline(request, { backend }, { plan: [{ kind: "persona", role: research.role, persona: research }] });
  assert.equal(result.reason, "stage_runtime_unavailable");
  assert.equal(result.outcome, "halted");
  assert.equal(backend.seen.length, 0);
});

test("council members use the tool runtime and persist separate artifacts before verdict synthesis", async () => {
  const a = ".copilot-tracking/reviews/council-risk-advisor/run-1/artifact.md";
  const b = ".copilot-tracking/reviews/council-design-advisor/run-1/artifact.md";
  const f = await fixture([
    call("write_artifact", { path: a, content: "Verdict: Go-With-Conditions\nConditions: Confirm stakeholder signoff." }),
    call("finish_stage", { status: "complete", readiness: "ready-with-gaps", summary: "Verdict: Go-With-Conditions", artifactPaths: [a], evidenceIds: [], councilVerdict: "Go-With-Conditions", conditions: ["Confirm stakeholder signoff."] }),
    call("write_artifact", { path: b, content: "Verdict: Go\nConditions: none" }),
    call("finish_stage", { status: "complete", readiness: "ready", summary: "Verdict: Go", artifactPaths: [b], evidenceIds: [], councilVerdict: "Go", conditions: [] }),
  ]);
  try {
    const result = await runAdvisoryPipeline(request, { backend: f.backend, stageExecutor: f.runtime }, {
      mode: "autopilot", plan: [{
        kind: "council", role: "Council Verdict", members: [
          { role: "Risk Advisor", charter: "Review risk and state a verdict.", applyTo: [] },
          { role: "Design Advisor", charter: "Review the design and state a verdict.", applyTo: [] },
        ],
      }],
    });
    assert.equal(result.outcome, "completed");
    assert.equal(result.councilVerdict?.verdict, "Go-With-Conditions");
    assert.equal(result.councilVerdict?.members.length, 2);
    assert.ok(await f.store.get("tenant-a", "project-a", a));
    assert.ok(await f.store.get("tenant-a", "project-a", b));
    assert.equal(f.backend.seen.length, 4);
    assert.ok(f.backend.seen.every((entry) => entry.tools?.some((tool) => tool.name === "write_artifact")));
  } finally { await f.cleanup(); }
});

for (const [name, responses, reason] of [
  ["text without a verified receipt remains blocked", [{ text: "Completed the BRD.", finishReason: "stop", backendId: "test-tools" }], "stage_artifact_gate"],
  ["primary must precede delegation", [call("delegate_research", contract)], "research_primary_missing"],
  ["traversal rejected", [call("write_artifact", { path: "../other-tenant/artifact.md", content: "escape" })], "invalid_artifact_path"],
  ["absolute paths rejected", [call("read_artifact", { path: "C:\\secrets.txt" })], "invalid_artifact_path"],
  ["undeclared tool cannot run", [call("run_terminal", { command: "anything" })], "stage_invalid_tool"],
  ["tenant cannot be supplied", [call("read_artifact", { path: primary, tenantId: "tenant-b" })], "stage_invalid_tool"],
  ["private network blocked", [call("fetch_documentation", { url: "http://169.254.169.254/metadata/identity/oauth2/token" })], "stage_external_scope"],
  ["query strings blocked", [call("fetch_documentation", { url: "https://learn.microsoft.com/en-us/azure/?secret=private" })], "stage_external_scope"],
  ["fake receipt blocked", [...successfulResearch().slice(0, 9), finish(primary, ["E999"])], "research_evidence_gate"],
] as const) {
  test(name, async () => {
    const f = await fixture([...responses]);
    try {
      await assert.rejects(f.runtime.execute(research, request), (error: unknown) => error instanceof StageBlockedError && error.reason === reason);
    } finally { await f.cleanup(); }
  });
}

test("lane cannot read a source outside the explicit delegated contract", async () => {
  const responses = successfulResearch().slice(0, 4);
  responses.push(call("read_artifact", { path: "input/request.md" }));
  responses.push(call("finish_stage", { status: "blocked", readiness: "blocked", summary: "Lane source scope was rejected.", artifactPaths: [], evidenceIds: [] }));
  const f = await fixture(responses);
  try {
    await assert.rejects(f.runtime.execute(research, request), StageBlockedError);
    const toolResult = f.backend.seen.at(-1)?.messages.at(-1)?.content ?? "";
    assert.match(toolResult, /stage_source_scope/);
    assert.doesNotMatch(toolResult, /Prepare a BRD/);
  } finally { await f.cleanup(); }
});

test("durable write conflict fails the artifact gate rather than overwriting prior evidence", async () => {
  const f = await fixture(successfulResearch().slice(0, 2));
  try {
    await f.store.put("tenant-a", "project-a", primary, "Earlier attempt", "");
    await assert.rejects(f.runtime.execute(research, request), (error: unknown) => error instanceof StageBlockedError && error.reason === "stage_artifact_conflict");
    assert.equal((await f.store.get("tenant-a", "project-a", primary))?.content, "Earlier attempt");
  } finally { await f.cleanup(); }
});

test("storage failure cannot be swallowed into successful research", async () => {
  const f = await fixture(successfulResearch().slice(0, 2), (store) => ({
    get: (...args) => store.get(...args), list: (...args) => store.list(...args), append: (...args) => store.append(...args),
    put: async () => { throw new Error("Storage unavailable"); },
  }));
  try { await assert.rejects(f.runtime.execute(research, request), /Storage unavailable/); }
  finally { await f.cleanup(); }
});

test("a storage adapter returning mismatched bytes cannot satisfy the primary artifact gate", async () => {
  const f = await fixture(successfulResearch().slice(0, 2), (store) => ({
    list: (...args) => store.list(...args), put: (...args) => store.put(...args), append: (...args) => store.append(...args),
    get: async (...args) => {
      const saved = await store.get(...args);
      return saved ? { ...saved, content: "truncated or different content" } : undefined;
    },
  }));
  try {
    await assert.rejects(f.runtime.execute(research, request), (error: unknown) =>
      error instanceof StageBlockedError && error.reason === "stage_artifact_persistence");
  } finally { await f.cleanup(); }
});

test("an unavailable instruction lookup stays explicit when the actor stops blocked", async () => {
  const f = await fixture([
    call("load_instruction", { path: "unbundled.instructions.md" }),
    call("finish_stage", { status: "blocked", readiness: "blocked", summary: "Required instruction is unavailable.", artifactPaths: [], evidenceIds: [] }),
  ]);
  try {
    await assert.rejects(f.runtime.execute(research, request), (error: unknown) =>
      error instanceof StageBlockedError && error.reason === "stage_blocked" && error.detail === "Required instruction is unavailable.");
    const receipt = f.backend.seen[1].messages.filter((entry) => entry.role === "tool").map((entry) => JSON.parse(entry.content)).at(-1);
    assert.equal(receipt.reason, "stage_instruction_unavailable");
    assert.equal(receipt.path, "instructions/unbundled.instructions.md");
    assert.equal(receipt.loaded, false);
  } finally { await f.cleanup(); }
});

const probeDone = () => call("finish_stage", {
  status: "blocked", readiness: "blocked", summary: "Resource probe completed.",
  artifactPaths: [], evidenceIds: [],
});
const isProbeDone = (error: unknown) => error instanceof StageBlockedError &&
  error.reason === "stage_blocked" && error.detail === "Resource probe completed.";

test("native artifact discovery excludes bridge records and retains readable supplied input", async () => {
  const f = await fixture([
    call("list_artifacts", {}),
    call("read_artifact", { path: "input/context.md" }),
    probeDone(),
  ]);
  try {
    const memory = new FileSquadMemoryStore({ baseDir: join(f.root, "memory") });
    await memory.write("tenant-a", "project-a", "context/bridge", '{"revision":1}');
    await assert.rejects(f.runtime.execute(research, request), isProbeDone);
    const listed = JSON.parse(f.backend.seen[1].messages.at(-1)!.content);
    assert.deepEqual(listed.paths.sort(), ["input/context.md", "input/request.md"]);
    assert.doesNotMatch(f.backend.seen[2].messages.at(-1)!.content, /context\/bridge/);
    assert.match(f.backend.seen[2].messages.at(-1)!.content, /weekly refresh/);
    assert.equal((await memory.read("tenant-a", "project-a", "context/bridge"))?.content,
      '{"revision":1}');
  } finally { await f.cleanup(); }
});

test("actual pinned instructions load as authority without duplicate prompt content", async () => {
  const githubRoot = resolveSquadGithubRoot();
  assert.ok(githubRoot);
  const bundle = new AdvisoryBundle(githubRoot);
  const roster = await bundle.instruction("squad/squad-roster.instructions.md");
  assert.ok(roster.content.length <= MAX_BUNDLE_RESOURCE_CHARS);
  const reference = await bundle.reference("instructions/squad/squad-routing.instructions.md");
  const template = await bundle.reference("instructions/squad/squad-autonomous.instructions.md");
  const f = await fixture([
    call("load_instruction", { path: "squad/squad-routing.instructions.md" }),
    call("load_instruction", { path: "squad/squad-roster.instructions.md" }),
    call("load_instruction", { path: "squad/squad-roster.instructions.md" }),
    call("read_reference", { path: "instructions/squad/squad-routing.instructions.md" }),
    call("read_reference", { path: "instructions/squad/squad-autonomous.instructions.md" }),
    probeDone(),
  ]);
  try {
    const runtime = new ResearchRuntime({ backend: f.backend, workspace: f.workspace, store: f.store,
      project: "project-a", runId: "run-1", githubRoot, date: "2026-09-18" });
    await assert.rejects(runtime.execute(research, request), isProbeDone);
    const last = f.backend.seen.at(-1)!;
    assert.ok(last.system.includes(roster.content));
    assert.ok(last.system.includes(reference.content));
    assert.ok(!last.system.includes(template.content), "read_reference returns DATA rather than adding authority.");
    assert.equal(last.system.split(roster.content).length, 2, "Repeated loads must not duplicate authority.");
    const toolMessages = last.messages.filter((entry) => entry.role === "tool");
    for (const message of toolMessages.slice(0, 3)) {
      const receipt = JSON.parse(message.content);
      assert.equal(receipt.loaded, true);
      assert.equal(receipt.delivery, "system");
      assert.match(receipt.contentSha256, /^[0-9a-f]{64}$/);
      assert.equal(receipt.content, undefined);
      assert.ok(message.content.length < 500);
    }
    assert.equal(JSON.parse(toolMessages.at(-1)!.content).content, template.content);
    assert.equal(JSON.parse(toolMessages.at(-1)!.content).authority, false);
  } finally { await f.cleanup(); }
});

for (const size of [MAX_BUNDLE_RESOURCE_CHARS, MAX_BUNDLE_RESOURCE_CHARS + 1]) {
  test(`pinned authority read boundary ${size} characters is explicit and never truncated`, async () => {
    const f = await fixture([call("load_instruction", { path: "squad/squad-routing.instructions.md" }), probeDone()]);
    try {
      const content = "x".repeat(size);
      await writeFile(join(f.githubRoot, "instructions", "squad", "squad-routing.instructions.md"), content);
      if (size === MAX_BUNDLE_RESOURCE_CHARS) {
        await assert.rejects(f.runtime.execute(research, request), isProbeDone);
        assert.ok(f.backend.seen.at(-1)!.system.includes(content));
      } else {
        await assert.rejects(f.runtime.execute(research, request), (error: unknown) =>
          error instanceof StageBlockedError && error.reason === "stage_instruction_limit" &&
          error.detail.includes("instructions/squad/squad-routing.instructions.md") &&
          error.detail.includes(String(size)) && error.detail.includes(String(MAX_BUNDLE_RESOURCE_CHARS)));
        assert.equal(f.backend.seen.length, 1, "The oversized pinned instruction fails on the requested load.");
      }
    } finally { await f.cleanup(); }
  });
}

test("cumulative authority accepts its exact boundary, counts reloaded resources once and rejects overflow", async () => {
  const paths = [
    "squad/squad-routing.instructions.md",
    "squad/squad-autonomous.instructions.md",
    "squad/squad-autopilot.instructions.md",
    "squad/squad-intake-gate.instructions.md",
  ];
  const f = await fixture([
    ...paths.map((path) => call("load_instruction", { path })),
    call("load_instruction", { path: paths[0] }),
    call("load_instruction", { path: "squad/extra.instructions.md" }),
  ]);
  try {
    const size = MAX_LOADED_AUTHORITY_CHARS / paths.length;
    assert.ok(size <= MAX_BUNDLE_RESOURCE_CHARS);
    for (const path of paths) {
      await writeFile(join(f.githubRoot, "instructions", path), path.padEnd(size, "x"));
    }
    await writeFile(join(f.githubRoot, "instructions", "squad", "extra.instructions.md"), "x");
    await assert.rejects(f.runtime.execute(research, request), (error: unknown) =>
      error instanceof StageBlockedError && error.reason === "stage_instruction_limit" &&
      error.detail.includes("extra.instructions.md") && error.detail.includes(String(MAX_LOADED_AUTHORITY_CHARS + 1)) &&
      error.detail.includes("per-actor authority limit"));
    assert.equal(f.backend.seen.length, 6, "Exact boundary and repeated load must reach the next turn.");
  } finally { await f.cleanup(); }
});

for (const size of [MAX_BUNDLE_RESOURCE_CHARS, MAX_BUNDLE_RESOURCE_CHARS + 1]) {
  test(`read_reference uses the pinned-resource boundary (${size}) without promoting data`, async () => {
    const f = await fixture([call("read_reference", { path: "instructions/squad/large.md" }), probeDone()]);
    try {
      const content = "reference-data ".padEnd(size, "x");
      await writeFile(join(f.githubRoot, "instructions", "squad", "large.md"), content);
      if (size === MAX_BUNDLE_RESOURCE_CHARS) {
        await assert.rejects(f.runtime.execute(research, request), isProbeDone);
        const last = f.backend.seen.at(-1)!;
        const result = JSON.parse(last.messages.at(-1)!.content);
        assert.equal(result.content, content);
        assert.equal(result.authority, false);
        assert.ok(!last.system.includes(content));
      } else {
        await assert.rejects(f.runtime.execute(research, request), (error: unknown) =>
          error instanceof StageBlockedError && error.reason === "stage_source_limit" &&
          error.detail.includes("large.md") && error.detail.includes(String(size)));
      }
    } finally { await f.cleanup(); }
  });
}

test("RPI Researcher cannot write artifacts and reports a blocked lane", async () => {
  const responses = successfulResearch().slice(0, 3);
  responses.push(call("write_artifact", { path: primary, content: "overwrite primary" }));
  responses.push(call("finish_stage", { status: "blocked", readiness: "blocked", summary: "Worker attempted an out-of-scope write.", artifactPaths: [], evidenceIds: [] }));
  const f = await fixture(responses);
  try {
    await assert.rejects(f.runtime.execute(research, request), StageBlockedError);
    assert.ok(f.backend.seen[3].tools?.every((tool) => tool.name !== "write_artifact"));
    assert.match(f.backend.seen.at(-1)?.messages.at(-1)?.content ?? "", /stage_invalid_tool/);
    assert.match((await f.store.get("tenant-a", "project-a", primary))?.content ?? "", /Status: researching/);
  } finally { await f.cleanup(); }
});

test("four top-level stages each receive sixty calls within the 240-call run ceiling", async () => {
  const roles = ["First Advisor", "Second Advisor", "Third Advisor", "Fourth Advisor"];
  const responses = roles.flatMap(role => {
    const path = `.copilot-tracking/reviews/${role.toLowerCase().replaceAll(" ", "-")}/run-1/artifact.md`;
    return [...Array.from({ length: 58 }, () => call("list_bundle", { kind: "instructions", offset: 0 })),
      call("write_artifact", { path, content: "# Verified stage artifact" }), finish(path, [])];
  });
  const f = await fixture(responses);
  try {
    for (const role of roles) await f.runtime.execute({ role, charter: "Write advisory evidence.", applyTo: [] }, request);
    assert.equal(f.backend.seen.length, 240);
    assert.match(f.backend.seen[60].system, /"stageModelCalls":\{"used":1,"limit":60\}/);
    assert.match(f.backend.seen[60].system, /"runModelCalls":\{"used":61,"limit":240\}/);
    await assert.rejects(f.runtime.execute({ role: "Fifth Advisor", charter: "Do not run.", applyTo: [] }, request),
      (e: unknown) => e instanceof StageBlockedError && /run-wide model-call.*240\/240/.test(e.detail));
    assert.equal(f.backend.seen.length, 240);
  } finally { await f.cleanup(); }
});

test("a stage cannot consume a later stage's model-call allowance", async () => {
  const f = await fixture(Array.from({ length: 60 }, () => call("list_bundle", { kind: "instructions", offset: 0 })));
  try {
    await assert.rejects(f.runtime.execute({ role: "Test Advisor", charter: "Read skills.", applyTo: [] }, request),
      (e: unknown) => e instanceof StageBlockedError && /stage-shared model-call.*60\/60.*run usage 60\/240/.test(e.detail));
    assert.equal(f.backend.seen.length, 60);
  } finally { await f.cleanup(); }
});

for (const scope of ["run", "stage"] as const) {
  test(`${scope}-shared model-call budget bounds research including delegated workers`, async () => {
    const f = await fixture(successfulResearch());
    try {
      const runtime = new ResearchRuntime({ backend: f.backend, workspace: f.workspace, store: f.store,
        project: "project-a", runId: "run-1", githubRoot: f.githubRoot, date: "2026-09-18",
        ...(scope === "run" ? { maxModelCalls: 3 } : { maxStageModelCalls: 3 }) });
      await assert.rejects(runtime.execute(research, request), (error: unknown) => error instanceof StageBlockedError && error.reason === "stage_execution_limit");
      assert.equal(f.backend.seen.length, 3);
    } finally { await f.cleanup(); }
  });
}

test("tool-call budgets reset only between top-level stages and retain the total ceiling", async () => {
  const paths = ["first", "second", "third"].map(role => `.copilot-tracking/reviews/${role}/run-1/artifact.md`);
  const f = await fixture(paths.flatMap(path => [call("write_artifact", { path, content: "# Advice" }), finish(path, [])]));
  try {
    const runtime = new ResearchRuntime({ backend: f.backend, workspace: f.workspace, store: f.store,
      project: "project-a", runId: "run-1", githubRoot: f.githubRoot, maxToolCalls: 4, maxStageToolCalls: 2 });
    for (const role of ["First", "Second"]) await runtime.execute({ role, charter: "Write advice.", applyTo: [] }, request);
    await assert.rejects(runtime.execute({ role: "Third", charter: "Do not write.", applyTo: [] }, request),
      (e: unknown) => e instanceof StageBlockedError && /run-wide tool-call.*4\/4/.test(e.detail));
    assert.equal(await f.store.get("tenant-a", "project-a", paths[2]), undefined);
  } finally { await f.cleanup(); }
});

test("batched tool calls cannot exceed a stage's allowance", async () => {
  const batch = call("list_bundle", { kind: "instructions", offset: 0 });
  batch.toolCalls = [0, 1, 2].map(index => ({ ...batch.toolCalls![0], id: `list-${index}` }));
  const f = await fixture([batch]);
  try {
    const runtime = new ResearchRuntime({ backend: f.backend, workspace: f.workspace, store: f.store,
      project: "project-a", runId: "run-1", githubRoot: f.githubRoot, maxStageToolCalls: 2 });
    await assert.rejects(runtime.execute({ role: "Test Advisor", charter: "Read skills.", applyTo: [] }, request),
      (e: unknown) => e instanceof StageBlockedError && /stage-shared tool-call.*2\/2/.test(e.detail));
    assert.equal(f.backend.seen.length, 1);
  } finally { await f.cleanup(); }
});

test("per-run cost ceiling is checked inside lanes and charged even when research fails", async () => {
  const f = await fixture(successfulResearch());
  const costLedger = new RunCostLedger({ ceilingUsd: 0.04 });
  try {
    const result = await runAdvisoryPipeline(request,
      { backend: f.backend, stageExecutor: f.runtime, costLedger }, {
        mode: "autopilot",
        plan: [{ kind: "persona", role: "Squad Researcher", persona: research, roleKey: "researcher" }],
      });
    assert.equal(result.outcome, "halted");
    assert.equal(result.reason, "run_cost_ceiling");
    assert.equal(f.backend.seen.length, 4, "No next worker or parent completion after cost exhaustion.");
    assert.equal(costLedger.spentUsd(), 0.04);
    assert.equal(f.cost(), 0.04, "All four calls, including the incomplete lane, count against tenant usage.");
  } finally { await f.cleanup(); }
});

test("failed research is durable on the same run, never re-polled as completed or reported as no model call", async () => {
  const f = await fixture([{ text: "No artifact can be produced.", finishReason: "stop", backendId: "test-tools", usage: { estimatedCostUsd: 0.02 } }]);
  try {
    const runs = new EphemeralRunStateStore();
    const approvals = new RunStoreApprovalChannel(runs);
    const quota = new TenantQuotaTracker({ concurrency: 2, monthlyCeilingUsd: 1 });
    const coordinator = new EmbeddedCoordinator({
      backend: f.backend, workspaceManager: new EphemeralWorkspaceManager({ baseDir: join(f.root, "live-like") }),
      quota, runStateStore: runs, approvals, researchArtifacts: f.store,
      autoMemory: new AutoMemory({ store: new FileSquadMemoryStore({ baseDir: join(f.root, "memory") }), defaultProject: "project-a" }),
    });
    const tool = loadCatalog().tools.find((entry) => entry.id === "squad_run");
    assert.ok(tool);
    const ctx = { auth: { tenantId: "tenant-a", subject: "caller", scopes: [], audience: "test" } };
    const started = await coordinator.startHttpRun(tool, { toolId: "squad_run", request: "Research the supplied refresh requirements", project: "project-a" }, ctx);
    assert.ok(started.runId);
    await approvals.approve(started.runId, "operator");
    const result = await coordinator.pollRun(started.runId, ctx);
    assert.equal(result.outcome, "denied");
    assert.equal(result.reason, "stage_artifact_gate");
    assert.equal((await runs.get(started.runId))?.status, "failed");
    assert.equal((await runs.get(started.runId))?.failureReason, "stage_artifact_gate");
    const again = await coordinator.pollRun(started.runId, ctx);
    assert.equal(again.reason, result.reason);
    assert.equal(again.artifact, result.artifact);
    assert.equal(f.backend.seen.length, 1);
    assert.equal(quota.spentUsd("tenant-a"), 0.02);
    const rendered = renderEmbeddedResult(again);
    assert.equal(rendered.isError, true);
    assert.doesNotMatch(rendered.content[0].text, /No model call was made/);
  } finally { await f.cleanup(); }
});

test("external documentation retrieval is credential-free, bounded and redirects never become evidence", async () => {
  const url = "https://learn.microsoft.com/en-us/azure/architecture/guide/";
  const f = await fixture([
    call("fetch_documentation", { url }),
    call("finish_stage", { status: "blocked", readiness: "blocked", summary: "No usable source", artifactPaths: [], evidenceIds: [] }),
  ]);
  try {
    let fetches = 0;
    const runtime = new ResearchRuntime({
      backend: f.backend, workspace: f.workspace, store: f.store, project: "project-a", runId: "run-1",
      githubRoot: f.githubRoot,
      fetchImpl: async (input, init) => {
        fetches++;
        assert.equal(String(input), url);
        assert.equal(init?.redirect, "manual");
        assert.equal(new Headers(init?.headers).get("authorization"), null);
        return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/secrets" } });
      },
    });
    await assert.rejects(runtime.execute(research, request), StageBlockedError);
    assert.equal(fetches, 1);
    const output = f.backend.seen.at(-1)?.messages.at(-1)?.content ?? "";
    assert.match(output, /unavailable/);
    assert.doesNotMatch(output, /retrievedAt/);
  } finally { await f.cleanup(); }
});

test("a successful documentation fetch supplies source and retrieval-time evidence, not raw HTML instructions", async () => {
  const url = "https://learn.microsoft.com/en-us/azure/architecture/guide/";
  const f = await fixture([
    call("fetch_documentation", { url }),
    call("finish_stage", { status: "blocked", readiness: "blocked", summary: "Research not completed", artifactPaths: [], evidenceIds: [] }),
  ]);
  try {
    const runtime = new ResearchRuntime({
      backend: f.backend, workspace: f.workspace, store: f.store, project: "project-a", runId: "run-1",
      githubRoot: f.githubRoot,
      fetchImpl: async () => new Response("<main><h1>Documentation</h1><script>execute_this()</script><p>Verified page text</p></main>", { headers: { "content-type": "text/html" } }),
    });
    await assert.rejects(runtime.execute(research, request), StageBlockedError);
    const output = f.backend.seen.at(-1)?.messages.at(-1)?.content ?? "";
    assert.match(output, /Verified page text/);
    assert.match(output, /retrievedAt/);
    assert.match(output, /learn\.microsoft\.com/);
    assert.doesNotMatch(output, /execute_this/);
  } finally { await f.cleanup(); }
});

test("planning has distinct plan/details artifacts and a fresh generic critique without an agent allow-list", async () => {
  const candidates = planning();
  const plan = `${deliverableRootFor("lead", defaultProfileTables(), { date: "2026-09-18" })}/run-1/artifact.md`;
  const details = ".copilot-tracking/details/2026-09-18/run-1/phase-details.md";
  const critique = ".copilot-tracking/reviews/2026-09-18/run-1/plan-critique.md";
  const f = await fixture([
    call("load_instruction", { path: "squad/squad-autonomous.instructions.md" }),
    call("write_artifact", { path: plan, content: candidates.plan }),
    call("write_artifact", { path: details, content: candidates.details }),
    call("delegate_plan_critique", {}),
    call("load_instruction", { path: "squad/squad-autopilot.instructions.md" }),
    call("read_artifact", { path: plan }),
    call("read_artifact", { path: details }),
    call("write_artifact", { path: critique, content: "# Independent critique\nE1: plan inspected. E2: phase details inspected. Human gates remain in force." }),
    finish(critique, ["E1", "E2"], { reviewOutcome: "pass" }),
    call("finish_stage", { status: "complete", readiness: "ready-with-gaps", summary: "Plan and details independently critiqued; no implementation performed.", artifactPaths: [plan, details, critique], evidenceIds: [] }),
  ]);
  try {
    await f.runtime.execute({ role: "Squad Lead", charter: "Load rpi-plan and obtain independent critique.", applyTo: [] }, request, undefined, "lead");
    assert.ok(await f.store.get("tenant-a", "project-a", plan));
    assert.ok(await f.store.get("tenant-a", "project-a", details));
    assert.ok(await f.store.get("tenant-a", "project-a", critique));
    assert.ok(f.backend.seen[4].system.includes("fresh generic critique worker"));
    assert.ok(f.backend.seen[4].tools?.every((tool) => !tool.name.startsWith("delegate_")), "Critique cannot recursively delegate.");
  } finally { await f.cleanup(); }
});

test("plan critique can verify caller requirements and the planner's actual research sources", async () => {
  const candidates = planning();
  const plan = ".copilot-tracking/plans/run-1/artifact.md";
  const details = ".copilot-tracking/details/2026-09-18/run-1/phase-details.md";
  const critique = ".copilot-tracking/reviews/2026-09-18/run-1/plan-critique.md";
  const unrelated = ".copilot-tracking/research/another-run.md";
  const f = await fixture([
    call("load_instruction", { path: "squad/squad-autonomous.instructions.md" }),
    call("read_artifact", { path: primary }),
    call("write_artifact", { path: plan, content: candidates.plan }),
    call("write_artifact", { path: details, content: candidates.details }),
    call("delegate_plan_critique", {}),
    call("load_instruction", { path: "squad/squad-autopilot.instructions.md" }),
    call("read_artifact", { path: "input/request.md" }),
    call("read_artifact", { path: "input/context.md" }),
    call("read_artifact", { path: primary }),
    call("read_artifact", { path: plan }),
    call("read_artifact", { path: details }),
    call("write_artifact", { path: critique, content: "# Independent critique\nE2 request, E3 brief, E4 research, E5 plan, E6 details were inspected. Unknowns remain open." }),
    finish(critique, ["E2", "E3", "E4", "E5", "E6"], { reviewOutcome: "pass" }),
    call("finish_stage", { status: "complete", readiness: "ready-with-gaps", summary: "Plan independently checked against supplied evidence.", artifactPaths: [plan, details, critique], evidenceIds: [] }),
  ]);
  const complete = f.backend.complete.bind(f.backend);
  f.backend.complete = async (input) => {
    const result = input.messages.at(-1);
    if (result?.toolCallId === "delegate_plan_critique-call") {
      const receipt = JSON.parse(result.content);
      assert.equal(receipt.status, "complete", JSON.stringify(receipt));
    }
    return complete(input);
  };
  try {
    await f.store.put("tenant-a", "project-a", primary, "# Current research\nWeekly refresh remains disputed.", "");
    await f.store.put("tenant-a", "project-a", unrelated, "# Unrelated project artifact", "");
    await f.runtime.execute({ role: "Squad Lead", charter: "Load rpi-plan and obtain independent critique.", applyTo: [] }, request, undefined, "lead");
    assert.ok(await f.store.get("tenant-a", "project-a", critique));
    const assignment = actorAssignment(f.backend.seen[5]);
    assert.deepEqual(new Set(assignment.permittedPaths), new Set([plan, details, "input/request.md", "input/context.md", primary]));
    assert.ok(!assignment.permittedPaths.includes(unrelated), "Critique cannot browse unrelated stored artifacts.");
    assert.deepEqual(assignment.writeScope, { exactPaths: [critique], prefixes: [] });
  } finally { await f.cleanup(); }
});

test("plan critique still stops on an unsupplied source and identifies the rejected path", async () => {
  const candidates = planning();
  const plan = ".copilot-tracking/plans/run-1/artifact.md";
  const details = ".copilot-tracking/details/2026-09-18/run-1/phase-details.md";
  const forbidden = ".copilot-tracking/research/unsupplied.md";
  const f = await fixture([
    call("load_instruction", { path: "squad/squad-autonomous.instructions.md" }),
    call("write_artifact", { path: plan, content: candidates.plan }),
    call("write_artifact", { path: details, content: candidates.details }),
    call("delegate_plan_critique", {}),
    call("read_artifact", { path: forbidden }),
    call("finish_stage", { status: "blocked", readiness: "blocked", summary: "Critique source scope denied.", artifactPaths: [], evidenceIds: [] }),
  ]);
  try {
    await f.store.put("tenant-a", "project-a", forbidden, "UNSUPPLIED_SECRET_SENTINEL", "");
    await assert.rejects(
      f.runtime.execute({ role: "Squad Lead", charter: "Load rpi-plan.", applyTo: [] }, request, undefined, "lead"),
      (error: unknown) => error instanceof StageBlockedError && error.reason === "stage_blocked",
    );
    const result = f.backend.seen.at(-1)?.messages.at(-1)?.content ?? "";
    assert.match(result, /stage_source_scope/);
    assert.ok(result.includes(forbidden));
    assert.doesNotMatch(result, /UNSUPPLIED_SECRET_SENTINEL/);
  } finally { await f.cleanup(); }
});

test("nested plan critique cannot expand its restricted planning parent's input scope", async () => {
  const candidates = planning();
  const root = ".copilot-tracking/reviews/review-manager/run-1/";
  const parentPath = `${root}artifact.md`;
  const childRoot = `${root}delegates/scoped-planner/`;
  const f = await fixture([
    call("write_artifact", { path: parentPath, content: "# Scope\nPlan supplied research only." }),
    call("delegate_agent", { agent: "Scoped Planner", task: "Plan supplied research only.", permittedPaths: [primary] }),
    call("load_instruction", { path: "squad/squad-autonomous.instructions.md" }),
    call("read_artifact", { path: primary }),
    call("write_artifact", { path: `${childRoot}artifact.md`, content: candidates.plan }),
    call("write_artifact", { path: `${childRoot}phase-details.md`, content: candidates.details }),
    call("delegate_plan_critique", {}),
    call("read_artifact", { path: "input/context.md" }),
    call("finish_stage", { status: "blocked", readiness: "blocked", summary: "Critique attempted unsupplied input.", artifactPaths: [], evidenceIds: [] }),
    call("finish_stage", { status: "blocked", readiness: "blocked", summary: "Nested planning blocked.", artifactPaths: [], evidenceIds: [] }),
  ]);
  try {
    await writeFile(join(f.githubRoot, "agents", "scoped-planner.agent.md"), "---\nname: Scoped Planner\n---\nLoad rpi-plan and plan only supplied evidence.");
    await f.store.put("tenant-a", "project-a", primary, "# Supplied research", "");
    await assert.rejects(
      f.runtime.execute({ role: "Review Manager", charter: "Delegate planning.", applyTo: [], tools: ["agent"] }, request),
      (error: unknown) => error instanceof StageBlockedError && error.reason === "stage_blocked",
    );
    const assignment = actorAssignment(f.backend.seen[7]);
    assert.deepEqual(new Set(assignment.permittedPaths), new Set([`${childRoot}artifact.md`, `${childRoot}phase-details.md`, primary]));
    const denied = f.backend.seen[8].messages.at(-1)?.content ?? "";
    assert.match(denied, /stage_source_scope/);
    assert.match(denied, /input\/context\.md/);
    assert.doesNotMatch(denied, /The brief requires weekly refresh/);
  } finally { await f.cleanup(); }
});

test("advisory delegation honors declared agents, source scope and independent child artifacts", async () => {
  const parentPath = ".copilot-tracking/reviews/editor-parent/run-1/artifact.md";
  const childPath = ".copilot-tracking/reviews/editor-parent/run-1/delegates/evidence-editor/artifact.md";
  const f = await fixture([
    call("write_artifact", { path: parentPath, content: "# Draft\nPending evidence review." }),
    call("delegate_agent", { agent: "Evidence Editor", task: "Review the supplied brief, preserve uncertainty.", permittedPaths: ["input/context.md"] }),
    call("read_artifact", { path: "input/context.md" }),
    call("write_artifact", { path: childPath, content: "# Review\nE1 input/context.md states weekly refresh; signoff remains unresolved." }),
    finish(childPath),
    call("write_artifact", { path: parentPath, content: "# Advisory result\nWeekly refresh is a supplied requirement. Signoff remains unresolved." }),
    finish(parentPath, []),
  ]);
  try {
    await writeFile(join(f.githubRoot, "agents", "evidence-editor.agent.md"), "---\nname: Evidence Editor\nagents: []\n---\nReview only the supplied evidence.");
    await f.runtime.execute({ role: "Editor Parent", charter: "Delegate bounded review.", agents: ["Evidence Editor"], applyTo: [] }, request);
    assert.ok(await f.store.get("tenant-a", "project-a", childPath));
    assert.ok(f.backend.seen[2].tools?.every((tool) => !tool.name.startsWith("delegate_")), "Explicit empty agent allow-list prevents delegation.");
    assert.ok(!f.backend.seen.some((entry) => entry.tools?.some((tool) => /execute|terminal|deploy/.test(tool.name))));
  } finally { await f.cleanup(); }
});

for (const scenario of ["pass", "revise", "missing-verdict", "changed-draft", "tampered-review"]) {
  test(`BRD quality gate checks an independent current review: ${scenario}`, async () => {
    const root = `${deliverableRootFor("analyst", defaultProfileTables(), { date: "2026-09-18" })}/run-1/brd/`;
    const brd = `${root}artifact.md`;
    const review = `${root}reviews/brd-quality-reviewer.md`;
    const responses = [
      call("load_instruction", { path: "squad/squad-intake-gate.instructions.md" }),
      call("write_artifact", { path: brd, content: "# BRD draft\nWeekly refresh is a supplied requirement; no stakeholder approval inferred." }),
      call("delegate_agent", { agent: "BRD Quality Reviewer", task: "Inspect this draft and report the quality result.", permittedPaths: [brd] }),
      call("read_artifact", { path: brd }),
      call("write_artifact", { path: review, content: "# Quality review\nE1: checked the actual BRD draft." }),
      call("finish_stage", {
        status: "complete", readiness: "ready-with-gaps", summary: "Independent review executed.",
        artifactPaths: [review], evidenceIds: ["E1"],
        ...(scenario === "missing-verdict" ? {} : { reviewOutcome: scenario === "revise" ? "revise" : "pass" }),
      }),
    ];
    if (scenario === "changed-draft") responses.push(call("write_artifact", { path: brd, content: "# Changed, unreviewed BRD" }));
    if (scenario === "tampered-review") responses.push(call("write_artifact", { path: review, content: "# Forged replacement review" }));
    responses.push(finish(brd, []));
    const f = await fixture(responses);
    try {
      await writeFile(join(f.githubRoot, "agents", "brd-quality-reviewer.agent.md"), "---\nname: BRD Quality Reviewer\nagents: []\n---\nRead and assess the actual draft. Report pass only if its quality gates pass.");
      const execution = f.runtime.execute({
        role: "BRD Builder", charter: "Load requirements-author. Obtain a passing independent quality review.",
        agents: ["BRD Quality Reviewer"], applyTo: [],
      }, request, undefined, "analyst");
      if (scenario === "pass") {
        assert.match((await execution).text, /Planning readiness/);
      } else {
        await assert.rejects(execution, (error: unknown) => error instanceof StageBlockedError && error.reason === "stage_review_gate");
      }
    } finally { await f.cleanup(); }
  });
}

async function verifyRoutedBrdArtifacts(authoringRequest: string, repairReceipt = false): Promise<void> {
  const responses: BackendResult[] = [];
  const runStore = new EphemeralRunStateStore();
  const run = await runStore.create({ tenantId: "tenant-a", toolId: "squad_run" });
  const tables = defaultProfileTables();
  const githubRoot = join(process.cwd(), "host", "cast", ".github");
  const persona = (name: string): PersonaRecord => {
    const loaded = loadPersonaForRole(name, [join(githubRoot, "agents")]);
    assert.ok(loaded, `Pinned persona exists: ${name}`);
    return loaded;
  };
  const forRole = (role: string) => {
    const name = tables.cast.get(role)?.primary;
    assert.ok(name, `Roster role exists: ${role}`);
    return persona(name);
  };
  const output = (role: string) => `${deliverableRootFor(role, tables, { date: "2026-09-18" })}/${run.runId}/artifact.md`;
  const researchPersona = persona("Squad Researcher");
  const lead = persona("Squad Lead");
  const brdPersona = persona("BRD Builder");
  const reviewPersona = forRole("tester");
  const candidates = planning();
  const plan = output("lead");
  const details = `.copilot-tracking/details/2026-09-18/${run.runId}/phase-details.md`;
  const critique = `.copilot-tracking/reviews/2026-09-18/${run.runId}/plan-critique.md`;
  const brd = output("analyst").replace(/artifact\.md$/, "brd/artifact.md");
  const quality = `${brd.slice(0, -"artifact.md".length)}reviews/brd-quality-reviewer.md`;
  const stageFinish = (paths: string[], evidenceIds: string[] = [], extra: Record<string, unknown> = {}) => call("finish_stage", {
    status: "complete", readiness: "ready-with-gaps", summary: "Advisory work recorded; no execution or stakeholder approval inferred.", artifactPaths: paths, evidenceIds, ...extra,
  });
  const loadRequired = (_role: PersonaRecord) => {};
  responses.push(...successfulResearch().map((response) => ({
    ...response, toolCalls: response.toolCalls?.map((tool) => ({ ...tool, arguments: tool.arguments.replaceAll("run-1", run.runId) })),
  })));
  loadRequired(lead);
  responses.push(
    call("write_artifact", { path: plan, content: candidates.plan }),
    call("write_artifact", { path: details, content: candidates.details }),
    call("delegate_plan_critique", {}),
    call("load_instruction", { path: "squad/squad-autopilot.instructions.md" }),
    call("read_artifact", { path: plan }), call("read_artifact", { path: details }),
    call("write_artifact", { path: critique, content: "# Independent critique\nE3 plan and E4 phase details inspected. No implementation was executed." }),
    stageFinish([critique], ["E3", "E4"], { reviewOutcome: "pass" }),
    ...(repairReceipt ? [stageFinish(["input/request.md", details, critique])] : []),
    stageFinish([plan, details, critique]),
  );
  responses.push(
    call("load_instruction", { path: "squad/squad-intake-gate.instructions.md" }),
    call("write_artifact", { path: brd, content: "# BRD advisory draft\nWeekly refresh is supplied by the brief. Stakeholder signoff remains outstanding." }),
    call("delegate_agent", { agent: "BRD Quality Reviewer", task: "Assess the advisory draft, without inferring stakeholder approval.", permittedPaths: [brd] }),
    call("read_artifact", { path: brd }),
    call("write_artifact", { path: quality, content: "# Quality assessment\nE5: inspected the actual draft. Stakeholder gate is still outstanding." }),
    call("finish_stage", { status: "complete", readiness: "ready-with-gaps", summary: "Draft quality assessed only.", artifactPaths: [quality], evidenceIds: ["E5"], reviewOutcome: "pass" }),
    stageFinish([brd]),
  );
  for (const [key, member] of [["tester", reviewPersona]] as const) {
    loadRequired(member);
    responses.push(call("write_artifact", { path: output(key), content: "# Advisory handoff\nArtifacts are available; implementation and stakeholder approval were not executed." }), stageFinish([output(key)]));
  }
  const f = await fixture(responses);
  try {
    const runtime = new ResearchRuntime({ backend: f.backend, workspace: f.workspace, store: f.store, project: "project-a", runId: run.runId, githubRoot, date: "2026-09-18" });
    const result = await runAdvisoryPipeline({ ...request, request: authoringRequest, profile: "brd" },
      { backend: f.backend, stageExecutor: runtime, persistence: new StoreAdvisoryPersistence(runStore, run.runId) },
      { mode: "autopilot" });
    assert.equal(result.outcome, "completed", result.artifact);
    assert.deepEqual(result.stages.map((stage) => stage.role), [researchPersona.role, lead.role, brdPersona.role, reviewPersona.role]);
    assert.equal((await runStore.get(run.runId))?.stages?.length, 4);
    assert.equal(responses.length, 0);
    if (repairReceipt) {
      const correction = f.backend.seen.flatMap((entry) => entry.messages)
        .find((message) => message.role === "tool" && message.content.includes('"issue":"invalid_artifact_receipt"'));
      assert.ok(correction);
      const receipt: { missingFromReceipt: string[]; notWritten: string[]; unownedPaths: string[] } = JSON.parse(correction.content);
      assert.deepEqual(receipt.missingFromReceipt, [plan]);
      assert.deepEqual(receipt.notWritten, []);
      assert.deepEqual(receipt.unownedPaths, ["input/request.md"]);
    }
    for (const path of [plan, details, critique, brd, quality, output("tester")]) {
      assert.ok(await f.store.get("tenant-a", "project-a", path), path);
    }
    assert.equal((await f.store.get("tenant-a", "project-a", plan))?.content, candidates.plan, "BRD authoring must not overwrite the plan.");
    assert.ok(f.backend.seen.every((entry) => entry.tools?.length));
    assert.ok(f.backend.seen.every((entry) => entry.tools?.some((tool) => tool.name === "validate_artifacts")),
      "Planning and review use the server-owned native structural validators.");
    assert.ok(f.backend.seen.every((entry) => !entry.tools?.some((tool) => tool.name === "load_skill")));
  } finally { await f.cleanup(); }
}

for (const authoringRequest of ["Produce a BRD from the supplied brief.", "Continue from the supplied brief."]) {
  test(`real BRD profile persists author and review artifacts: ${authoringRequest}`, () => verifyRoutedBrdArtifacts(authoringRequest));
}

test("a persisted plan can correct its completion receipt without losing work or skipping BRD gates", () =>
  verifyRoutedBrdArtifacts("Produce a BRD from the supplied brief.", true));

test("artifact receipt correction cannot complete unwritten work and consumes the existing budget", async () => {
  const f = await fixture([
    call("load_instruction", { path: "squad/squad-routing.instructions.md" }),
    finish(primary), finish(primary), finish(primary),
  ]);
  try {
    const runtime = new ResearchRuntime({
      backend: f.backend, workspace: f.workspace, store: f.store, project: "project-a",
      runId: "run-1", githubRoot: f.githubRoot, date: "2026-09-18", maxStageModelCalls: 4,
    });
    await assert.rejects(runtime.execute(research, request), (error: unknown) =>
      error instanceof StageBlockedError && error.reason === "stage_execution_limit");
    const correction = JSON.parse(f.backend.seen[2].messages.at(-1)!.content);
    assert.equal(correction.status, "blocked");
    assert.deepEqual(correction.notWritten, [primary]);
    assert.deepEqual(correction.eligiblePaths, []);
    assert.equal(f.backend.seen.length, 4);
    assert.equal(await f.store.get("tenant-a", "project-a", primary), undefined);
    assert.equal(await f.store.get("tenant-a", "project-a", ".copilot-tracking/squad/history/squad-researcher.md"), undefined);
  } finally { await f.cleanup(); }
});

test("artifact receipt correction never grants a wider write scope", async () => {
  const f = await fixture([
    call("load_instruction", { path: "squad/squad-routing.instructions.md" }),
    finish(primary),
    call("write_artifact", { path: ".copilot-tracking/plans/unowned.md", content: "# Not this actor's output" }),
  ]);
  try {
    await assert.rejects(f.runtime.execute(research, request), (error: unknown) =>
      error instanceof StageBlockedError && error.reason === "stage_write_scope");
    assert.equal(await f.store.get("tenant-a", "project-a", ".copilot-tracking/plans/unowned.md"), undefined);
  } finally { await f.cleanup(); }
});

test("evidence receipts alone cannot complete research with a malformed primary artifact", async () => {
  const responses = successfulResearch();
  responses[8] = call("write_artifact", { path: primary, content: "# Incomplete research\nE2 exists, but canonical waves and closeout are missing." });
  const f = await fixture(responses);
  try {
    await assert.rejects(f.runtime.execute(research, request), (error: unknown) =>
      error instanceof StageBlockedError && error.reason === "stage_contract_gate");
    assert.equal(await f.store.get("tenant-a", "project-a", ".copilot-tracking/squad/history/squad-researcher.md"), undefined);
  } finally { await f.cleanup(); }
});
