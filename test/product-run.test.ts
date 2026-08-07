/**
 * End-to-end proof that a `product` run's deliverables actually land in storage.
 *
 * The engine could route the right roles, resolve the right personas, and still
 * write nothing — which is exactly what happened before the ledger sink was
 * wired: `SquadRunRecorder.recordStage` existed and was never called, so a run
 * produced a compiled artifact and an empty tree. These tests assert on the
 * STORE rather than on the returned artifact, so that failure cannot recur
 * silently.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { MemoryBackedArtifactStore } from "../src/engine/artifact-store.js";
import { FileSquadMemoryStore } from "../src/engine/backends/file-squad-memory.js";
import { planAdvisoryStages, runAdvisoryPipeline } from "../src/engine/advisory-pipeline.js";
import type { CoordinatorRequest } from "../src/engine/coordinator-engine.js";
import type { BackendRequest, BackendResult, ModelBackend } from "../src/engine/model-backend.js";
import { loadProfileTables, resolveProfile } from "../src/engine/profiles.js";
import { route } from "../src/engine/routing.js";
import { SquadHistory } from "../src/engine/squad-history.js";
import { SquadLedger } from "../src/engine/squad-ledger.js";
import { SquadRunRecorder } from "../src/engine/squad-run-recorder.js";

const TENANT = "11111111-1111-1111-1111-111111111111";
const PROJECT = "acme-onboarding";
const RUN_ID = "run-1";
const TABLES = loadProfileTables();

/** Echoes back which persona was in authority, so a stage is attributable. */
class EchoBackend implements ModelBackend {
  readonly id = "echo";
  readonly systems: string[] = [];
  constructor(private readonly intakeVerdict = "Ready") {}
  complete(request: BackendRequest): Promise<BackendResult> {
    this.systems.push(request.system);
    const isIntake = /Product Manager Advisor|PRD Quality Reviewer/i.test(request.system);
    const text = isIntake
      ? `Verdict: ${this.intakeVerdict}\n\nIntake assessed.`
      : `Deliverable body for ${request.system.slice(0, 40)}`;
    return Promise.resolve({ text, backendId: "echo", finishReason: "stop" });
  }
}

function makeFixture(intakeVerdict = "Ready") {
  const dir = mkdtempSync(join(tmpdir(), "product-run-"));
  const store = new MemoryBackedArtifactStore(new FileSquadMemoryStore({ baseDir: dir }));
  const recorder = new SquadRunRecorder({ store, tables: TABLES, today: () => "2026-08-07" });
  return {
    store,
    recorder,
    ledger: new SquadLedger(store),
    history: new SquadHistory(store),
    backend: new EchoBackend(intakeVerdict),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const REQUEST: CoordinatorRequest = {
  toolId: "squad_run",
  request: "plan and review the new customer onboarding product",
  profile: "product",
};

async function runProduct(fixture: ReturnType<typeof makeFixture>) {
  const routePlan = route(REQUEST.request, { profile: "product" });
  const plan = planAdvisoryStages(routePlan);
  await fixture.ledger.seed(TENANT, PROJECT, resolveProfile("product", TABLES), TABLES, {
    date: "2026-08-07",
  });
  return runAdvisoryPipeline(
    REQUEST,
    {
      backend: fixture.backend,
      ledger: fixture.recorder.sinkFor(TENANT, PROJECT, REQUEST, RUN_ID),
    },
    { mode: "autopilot", plan },
  );
}

test("a product run writes each role's deliverable under its own roster root", async () => {
  const fixture = makeFixture();
  try {
    const result = await runProduct(fixture);
    assert.equal(result.outcome, "completed");

    const tree = (await fixture.store.list(TENANT, PROJECT)).map((e) => e.path);

    // The methodology spine lands in its own roots.
    assert.ok(
      tree.some((p) => p.startsWith(".copilot-tracking/research/2026-08-07/")),
      `no research deliverable in ${tree.join(", ")}`,
    );
    assert.ok(
      tree.some((p) => p.startsWith(".copilot-tracking/plans/")),
      `no plan deliverable in ${tree.join(", ")}`,
    );
    assert.ok(
      tree.some((p) => p.startsWith(".copilot-tracking/reviews/")),
      `no review deliverable in ${tree.join(", ")}`,
    );
    // The product specialists write real files, not just prose in the artifact.
    assert.ok(
      tree.some((p) => p.startsWith(".copilot-tracking/ppt/2026-08-07/")),
      `no presenter deliverable in ${tree.join(", ")}`,
    );
    assert.ok(tree.some((p) => p.startsWith("docs/")), `no technical-writer output in ${tree.join(", ")}`);
    assert.ok(tree.some((p) => p.startsWith("outputs/")), `no data-scientist output in ${tree.join(", ")}`);
  } finally {
    fixture.cleanup();
  }
});

test("every dispatched agent gets a history entry and the run summary lists them", async () => {
  const fixture = makeFixture();
  try {
    await runProduct(fixture);
    const history = await fixture.store.list(
      TENANT,
      PROJECT,
      ".copilot-tracking/squad/history",
    );
    const agentFiles = history.filter((e) => !e.path.includes("autopilot-run-"));
    assert.ok(agentFiles.length >= 5, `expected per-agent history, got ${agentFiles.length}`);

    const runSummary = await fixture.store.get(
      TENANT,
      PROJECT,
      ".copilot-tracking/squad/history/autopilot-run-run-1.md",
    );
    assert.match(runSummary?.content ?? "", /Squad Researcher/);
    assert.match(runSummary?.content ?? "", /Squad Lead/);
  } finally {
    fixture.cleanup();
  }
});

test("the intake verdict is recorded in the decision log", async () => {
  const fixture = makeFixture();
  try {
    await runProduct(fixture);
    const decisions = await fixture.history.decisions(TENANT, PROJECT);
    assert.match(decisions ?? "", /Intake Readiness Verdict/);
    assert.match(decisions ?? "", /Verdict: Ready/);
  } finally {
    fixture.cleanup();
  }
});

test("a Not-Ready intake halts the run before any deliverable is written", async () => {
  const fixture = makeFixture("Not-Ready");
  try {
    const result = await runProduct(fixture);
    assert.equal(result.outcome, "halted");
    assert.equal(result.reason, "intake_not_ready");

    const tree = (await fixture.store.list(TENANT, PROJECT)).map((e) => e.path);
    assert.ok(
      !tree.some((p) => p.startsWith(".copilot-tracking/plans/")),
      "a halted run must not leave a plan behind",
    );
    const decisions = await fixture.history.decisions(TENANT, PROJECT);
    assert.match(decisions ?? "", /Verdict: Not-Ready/);
  } finally {
    fixture.cleanup();
  }
});

test("a follow-up run reads the first run's output back without naming a key", async () => {
  const fixture = makeFixture();
  try {
    await runProduct(fixture);
    const block = await fixture.history.contextBlock(TENANT, PROJECT);
    assert.match(block ?? "", /Squad profile: product/);
    assert.match(block ?? "", /\.copilot-tracking\/plans\//);
    assert.match(block ?? "", /\.copilot-tracking\/ppt\//);
  } finally {
    fixture.cleanup();
  }
});
