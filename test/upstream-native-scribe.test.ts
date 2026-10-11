import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MemoryBackedArtifactStore, type SquadArtifactStore } from "../src/engine/artifact-store.js";
import { FileSquadMemoryStore } from "../src/engine/backends/file-squad-memory.js";
import { installedUpstreamBundle } from "../src/engine/copilot/upstream-bundle.js";
import { upstreamStateTemplate } from "../src/engine/copilot/upstream-project-state.js";
import { nativeUpstreamDispatchReferences, nativeUpstreamHandoff, nativeUpstreamNoCeilingPreflight, type NativeScribeOptions } from "../src/engine/copilot/upstream-native-scribe.js";
import type { UpstreamHistoryRecord, UpstreamProcedureContext } from "../src/engine/copilot/upstream-coordinator.js";
import { UpstreamScriptBridgeError } from "../src/engine/copilot/upstream-script-bridge.js";

const bundle = installedUpstreamBundle();
const ROOT = ".copilot-tracking/squad";
const usage: UpstreamHistoryRecord["consumption"] = {
  model: "gpt-5.4", model_source: "dispatch-reported", priced_as: "gpt-5.4", model_tier: "default",
  internal_turns: 1, input_tokens: 10, cached_tokens: 0, cache_write_tokens: 0, output_tokens: 2, basis: "estimated",
};
const record: UpstreamHistoryRecord = {
  stageId: "stage-one", role: "developer", agent: "Squad Implementor", turn: 0,
  request: "Write an advisory report.", deliverable: "docs/report.md", outcome: "stop",
  timestamp: "2026-10-11T00:00:00Z", upstreamHistoryPath: `${ROOT}/history/Squad Implementor.md`,
  historyEntry: "", consumption: usage,
};
const context: UpstreamProcedureContext = {
  runId: "run-a", project: "project", model: "gpt-5.4", availableModels: ["gpt-5.4"], stages: [],
  signal: new AbortController().signal,
};
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "upstream-native-scribe-"));
  const store = new MemoryBackedArtifactStore(new FileSquadMemoryStore({ baseDir: root }));
  const options: NativeScribeOptions = { store, tenantId: "tenant", project: "project", bundle,
    routing: { mode: "manual", model: "gpt-5.4" }, roster: [{ role: "developer", agent: "Squad Implementor" }] };
  await store.put("tenant", "project", `${ROOT}/state.json`, upstreamStateTemplate(bundle, "autopilot", "2026-10-11T00:00:00Z"));
  await store.put("tenant", "project", `${ROOT}/decisions.md`, "# Existing decisions\n");
  await store.put("tenant", "project", "docs/report.md", "# Actual report\n");
  return { store, options, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("native ranked/manual history keeps upstream schema, truthful execution and replay protection", async () => {
  const f = await fixture();
  try {
    const result = await nativeUpstreamHandoff(f.options, record, context, usage, []);
    assert.equal(result.execution, "native-scribe");
    const history = (await f.store.get("tenant", "project", `${ROOT}/history/Squad-Implementor.md`))!.content;
    assert.match(history, /^# History: Squad Implementor/m);
    assert.match(history, /### \S+ stage-one/);
    assert.match(history, /#### Consumption\n/);
    assert.equal(JSON.parse((await f.store.get("tenant", "project", `${ROOT}/state.json`))!.content).turn, 1);
    await assert.rejects(nativeUpstreamHandoff(f.options, record, context, usage, []), /replay is refused/);
    assert.equal((await f.store.get("tenant", "project", `${ROOT}/history/Squad-Implementor.md`))!.content, history);
  } finally { await f.cleanup(); }
});

test("native no-ceiling preflight does not add a decision or waive an active ceiling", async () => {
  const f = await fixture();
  try {
    await nativeUpstreamNoCeilingPreflight(f.options, "run-a");
    assert.equal((await f.store.get("tenant", "project", `${ROOT}/decisions.md`))!.content, "# Existing decisions\n");
    const path = `${ROOT}/state.json`;
    const saved = (await f.store.get("tenant", "project", path))!;
    const state = JSON.parse(saved.content);
    assert.equal(state.currentRun.costPreflight.runId, "run-a");
    state.currentRun.costPreflight.ceilingUsd = 1;
    await f.store.put("tenant", "project", path, JSON.stringify(state), saved.etag);
    await assert.rejects(nativeUpstreamNoCeilingPreflight(f.options, "run-b"), /cannot waive/);
  } finally { await f.cleanup(); }
});

test("native Scribe partial CAS failures retain exact committed history paths", async () => {
  const f = await fixture();
  try {
    const conflicted: SquadArtifactStore = {
      get: f.store.get.bind(f.store), list: f.store.list.bind(f.store), append: f.store.append.bind(f.store),
      put: async (tenant, project, path, content, etag) => path.endsWith("/state.json")
        ? { ok: false, conflict: true, current: await f.store.get(tenant, project, path) }
        : f.store.put(tenant, project, path, content, etag),
    };
    await assert.rejects(nativeUpstreamHandoff({ ...f.options, store: conflicted }, record, context, usage, []),
      (error: unknown) => error instanceof UpstreamScriptBridgeError &&
        error.committedPaths.includes(`${ROOT}/history/Squad-Implementor.md`) &&
        error.committedPaths.includes(`${ROOT}/history/Squad-Scribe.md`));
  } finally { await f.cleanup(); }
});

test("ranked/manual dispatch references retain complete source hashes without a scripted brief claim", async () => {
  const f = await fixture();
  try {
    const result = await nativeUpstreamDispatchReferences(f.options);
    assert.equal(result.execution, "native-scribe");
    const output = JSON.parse(result.output);
    assert.equal(output.economyBriefExecuted, false);
    assert.equal(output.resources.length, 4);
    assert.ok(output.resources.every((resource: { sha256: string; content: string }) =>
      /^[a-f0-9]{64}$/.test(resource.sha256) && resource.content.length > 0));
  } finally { await f.cleanup(); }
});
