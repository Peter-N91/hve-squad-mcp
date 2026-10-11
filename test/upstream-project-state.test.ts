import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryBackedArtifactStore } from "../src/engine/artifact-store.js";
import { FileSquadMemoryStore } from "../src/engine/backends/file-squad-memory.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { installedUpstreamBundle } from "../src/engine/copilot/upstream-bundle.js";
import { upstreamSeedFiles, upstreamStateTemplate, inspectProjectRuntime } from "../src/engine/copilot/upstream-project-state.js";

const bundle = installedUpstreamBundle();
test("upstream initialization uses the actual pinned closed state schema and economy roster", () => {
  const roster = "# Members\n\nModel routing: economy\n\n| Role | Agent Name (Primary) | Model Tier |\n| --- | --- | --- |\n| developer | Squad Implementor | default |\n";
  const files = upstreamSeedFiles(bundle, roster, "autopilot", "2026-10-10T12:00:00Z");
  const state = JSON.parse(files.get(".copilot-tracking/squad/state.json")!);
  assert.equal(state.schemaVersion, "1.4");
  assert.equal(state.mode, "autopilot");
  assert.equal(state.currentRun.costPreflight.decision, "not-requested");
  assert.deepEqual(Object.keys(state).sort(), ["schemaVersion", "updated", "turn", "mode", "activeRoles", "openEscalations", "currentRun", "notify"].sort());
  assert.equal(JSON.parse(files.get(".copilot-tracking/squad/runtime-binding.json")!).commit, bundle.identity.sourceCommit);
  assert.throws(() => upstreamSeedFiles(bundle, roster.replace("economy", "off"), "autopilot", "now"), /confirmed routing roster/);
  assert.equal(JSON.parse(upstreamStateTemplate(bundle, "interactive", "2026-10-10T12:00:00Z")).turn, 0);
});

test("existing native project remains native without rewriting its state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "upstream-binding-"));
  const store = new MemoryBackedArtifactStore(new FileSquadMemoryStore({ baseDir: dir }));
  try {
    await mkdir(dir, { recursive: true });
    assert.equal(await inspectProjectRuntime(store, "tenant", "project-test", bundle), "uninitialized");
    const content = "{\"schemaVersion\":2,\"privateState\":\"preserve\"}";
    await store.put("tenant", "project-test", ".copilot-tracking/squad/state.json", content);
    const old = await store.get("tenant", "project-test", ".copilot-tracking/squad/state.json");
    assert.deepEqual(await inspectProjectRuntime(store, "tenant", "project-test", bundle), { runtime: "native" });
    const current = await store.get("tenant", "project-test", ".copilot-tracking/squad/state.json");
    assert.equal(current!.content, content);
    assert.equal(current!.etag, old!.etag);
    assert.equal(await store.get("tenant", "project-test", ".copilot-tracking/squad/runtime-binding.json"), undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("existing upstream projects refuse implicit rolling preview migrations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "upstream-pin-binding-"));
  const store = new MemoryBackedArtifactStore(new FileSquadMemoryStore({ baseDir: dir }));
  try {
    const path = ".copilot-tracking/squad/runtime-binding.json";
    await store.put("tenant", "project-test", path, JSON.stringify({ runtime: "upstream", commit: "0".repeat(40), schemaVersion: "1.4" }));
    await assert.rejects(inspectProjectRuntime(store, "tenant", "project-test", bundle), /explicit verified version migration/);
    await store.put("tenant", "project-test", path, JSON.stringify({ runtime: "upstream", commit: bundle.identity.sourceCommit, schemaVersion: "1.4" }));
    assert.deepEqual(await inspectProjectRuntime(store, "tenant", "project-test", bundle), { runtime: "upstream", commit: bundle.identity.sourceCommit, schemaVersion: "1.4", routing: { mode: "economy" } });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("partial upstream initialization and unbound schema 1.4 never become native projects", async () => {
  const dir = await mkdtemp(join(tmpdir(), "upstream-partial-binding-"));
  const store = new MemoryBackedArtifactStore(new FileSquadMemoryStore({ baseDir: dir }));
  try {
    await store.put("tenant", "project-test", ".copilot-tracking/squad/runtime-initialization.json", '{"kind":"upstream-initialization"}');
    await assert.rejects(inspectProjectRuntime(store, "tenant", "project-test", bundle), /Incomplete upstream initialization/);
    await store.put("tenant", "another-project", ".copilot-tracking/squad/state.json", upstreamStateTemplate(bundle, "autopilot", "2026-10-11T00:00:00Z"));
    await assert.rejects(inspectProjectRuntime(store, "tenant", "another-project", bundle), /Unbound upstream schema/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
