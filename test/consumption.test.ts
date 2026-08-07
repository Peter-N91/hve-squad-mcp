/**
 * The consumption ledger must accumulate, not snapshot.
 *
 * The failure this pins is the one hve-squad hit and documented: rebuilding the
 * ledger from the turn in hand drops every earlier role while leaving its history
 * entry intact — and the totals still add up, which is exactly what makes it
 * expensive to notice.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { MemoryBackedArtifactStore } from "../src/engine/artifact-store.js";
import { FileSquadMemoryStore } from "../src/engine/backends/file-squad-memory.js";
import {
  parseConsumptionBlocks,
  rebuildConsumption,
  renderConsumptionBlock,
  summarize,
} from "../src/engine/consumption.js";
import type { CoordinatorRequest } from "../src/engine/coordinator-engine.js";
import { loadProfileTables, resolveProfile } from "../src/engine/profiles.js";
import { CONSUMPTION_PATH, SquadLedger } from "../src/engine/squad-ledger.js";
import { SquadRunRecorder } from "../src/engine/squad-run-recorder.js";

const TENANT = "11111111-1111-1111-1111-111111111111";
const PROJECT = "acme";
const TABLES = loadProfileTables();
const REQUEST: CoordinatorRequest = { toolId: "squad_run", request: "go" };

function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), "consumption-"));
  const store = new MemoryBackedArtifactStore(new FileSquadMemoryStore({ baseDir: dir }));
  return {
    store,
    ledger: new SquadLedger(store),
    recorder: new SquadRunRecorder({ store, tables: TABLES, today: () => "2026-08-07" }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("a consumption block round-trips through render and parse", () => {
  const block = renderConsumptionBlock({
    role: "lead",
    agentName: "Squad Lead",
    model: "azure-openai",
    inputTokens: 1200,
    outputTokens: 340,
    costUsd: 0.0182,
  });
  const [parsed] = parseConsumptionBlocks(block);
  assert.equal(parsed.role, "lead");
  assert.equal(parsed.inputTokens, 1200);
  assert.equal(parsed.outputTokens, 340);
  assert.equal(parsed.costUsd, 0.0182);
  // One credit is one US cent.
  assert.match(block, /"est_credits": 1\.82/);
  assert.match(block, /"basis": "measured"/);
});

test("a malformed block contributes nothing rather than NaN totals", () => {
  const records = parseConsumptionBlocks("```json consumption\n{ not json\n```");
  assert.deepEqual(records, []);
});

test("summarize sums per role across dispatches", () => {
  const totals = summarize([
    { role: "lead", agentName: "Squad Lead", model: "m", inputTokens: 10, outputTokens: 5, costUsd: 1 },
    { role: "lead", agentName: "Squad Lead", model: "m", inputTokens: 20, outputTokens: 6, costUsd: 2 },
    { role: "tester", agentName: "Squad Reviewer", model: "m", inputTokens: 7, outputTokens: 1, costUsd: 0.5 },
  ]);
  assert.equal(totals.length, 2);
  assert.equal(totals[0].dispatches, 2);
  assert.equal(totals[0].inputTokens, 30);
  assert.equal(totals[0].costUsd, 3);
});

test("the ledger accumulates across turns instead of snapshotting the last one", async () => {
  const fixture = makeFixture();
  try {
    await fixture.ledger.seed(TENANT, PROJECT, resolveProfile("product", TABLES), TABLES, {
      date: "2026-08-07",
    });

    // Turn one: the researcher runs.
    await fixture.recorder.recordStage(TENANT, PROJECT, REQUEST, "run-1", {
      roleKey: "researcher",
      agentName: "Squad Researcher",
      artifact: "findings",
      usage: { inputTokens: 100, outputTokens: 50, estimatedCostUsd: 0.01 },
      backendId: "azure-openai",
    });
    await fixture.recorder.closeRun(TENANT, PROJECT, "run-1", ["researcher"]);

    // Turn two: only the lead runs.
    await fixture.recorder.recordStage(TENANT, PROJECT, REQUEST, "run-2", {
      roleKey: "lead",
      agentName: "Squad Lead",
      artifact: "plan",
      usage: { inputTokens: 200, outputTokens: 80, estimatedCostUsd: 0.02 },
      backendId: "azure-openai",
    });
    await fixture.recorder.closeRun(TENANT, PROJECT, "run-2", ["lead"]);

    const ledger = await fixture.store.get(TENANT, PROJECT, CONSUMPTION_PATH);
    const text = ledger?.content ?? "";
    // The earlier role must survive a later turn's rewrite.
    assert.match(text, /\| researcher \|/, "turn one's role was dropped from the ledger");
    assert.match(text, /\| lead \|/);
    // 100 + 200 input, 50 + 80 output, 0.03 total.
    assert.match(text, /\| \*\*total\*\* \| 300 \| 130 \| 0\.03 \| 3 \|/);
  } finally {
    fixture.cleanup();
  }
});

test("a stage with no reported usage records no consumption block", async () => {
  const fixture = makeFixture();
  try {
    await fixture.ledger.seed(TENANT, PROJECT, resolveProfile("default", TABLES), TABLES, {
      date: "2026-08-07",
    });
    await fixture.recorder.recordStage(TENANT, PROJECT, REQUEST, "run-1", {
      roleKey: "researcher",
      agentName: "Squad Researcher",
      artifact: "findings",
    });
    await fixture.recorder.closeRun(TENANT, PROJECT, "run-1", ["researcher"]);

    const totals = await rebuildConsumption(fixture.store, TENANT, PROJECT);
    assert.deepEqual(totals, []);
    const ledger = await fixture.store.get(TENANT, PROJECT, CONSUMPTION_PATH);
    assert.match(ledger?.content ?? "", /# Consumption/);
  } finally {
    fixture.cleanup();
  }
});
