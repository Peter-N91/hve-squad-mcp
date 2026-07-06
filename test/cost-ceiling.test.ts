import assert from "node:assert/strict";
import { test } from "node:test";

import { RunCostLedger } from "../src/engine/gates.js";
import { runAdvisoryPipeline, type AdvisoryStagePlan } from "../src/engine/advisory-pipeline.js";
import type { PersonaRecord } from "../src/engine/persona-loader.js";
import type { BackendRequest, BackendResult, ModelBackend } from "../src/engine/model-backend.js";

/** A counting backend that returns a fixed per-call cost. */
class CountingBackend implements ModelBackend {
  readonly id = "counting-backend";
  calls = 0;

  constructor(private readonly costUsd: number) {}

  async complete(_request: BackendRequest): Promise<BackendResult> {
    this.calls += 1;
    return {
      text: `STAGE-${this.calls}`,
      finishReason: "stop",
      backendId: this.id,
      usage: { estimatedCostUsd: this.costUsd },
    };
  }
}

const persona = (role: string): PersonaRecord => ({ role, charter: `${role}-CHARTER authority`, applyTo: [] });
const stage = (role: string): AdvisoryStagePlan => ({ kind: "persona", role, persona: persona(role) });

// ---------------------------------------------------------------------------
// RunCostLedger primitive.
// ---------------------------------------------------------------------------

test("RunCostLedger admits until accumulated spend reaches the ceiling", () => {
  const ledger = new RunCostLedger({ ceilingUsd: 0.02 });
  assert.equal(ledger.check().ok, true);
  ledger.record(0.01);
  assert.equal(ledger.check().ok, true);
  ledger.record(0.01);
  const refused = ledger.check();
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.equal(refused.reason, "run_cost_ceiling");
    assert.equal(refused.spentUsd, 0.02);
    assert.equal(refused.ceilingUsd, 0.02);
  }
});

test("RunCostLedger ignores non-positive costs", () => {
  const ledger = new RunCostLedger({ ceilingUsd: 0.02 });
  ledger.record(undefined);
  ledger.record(0);
  ledger.record(-5);
  assert.equal(ledger.spentUsd(), 0);
});

// ---------------------------------------------------------------------------
// Advisory pipeline halts before the next stage on the ceiling with 0 further calls.
// ---------------------------------------------------------------------------

test("a run that would exceed the per-run ceiling halts before the next stage with 0 further backend calls", async () => {
  const backend = new CountingBackend(0.01);
  const ledger = new RunCostLedger({ ceilingUsd: 0.015 });
  const plan = [stage("Alpha"), stage("Beta"), stage("Gamma"), stage("Delta")];

  const result = await runAdvisoryPipeline(
    { toolId: "squad_run", request: "expensive advisory run", mode: "autopilot" },
    { backend, costLedger: ledger },
    { plan, mode: "autopilot" },
  );

  assert.equal(result.outcome, "halted");
  assert.equal(result.reason, "run_cost_ceiling");
  // Stage 1 (0.01 < 0.015 ok) + stage 2 (0.02 recorded) run; the check BEFORE stage 3
  // refuses, so exactly 2 backend calls were made and stages 3-4 never dispatched.
  assert.equal(backend.calls, 2);
  assert.equal(result.stages.length, 2);
  assert.ok(Math.abs(result.costUsd - 0.02) < 1e-9);
});

test("a run under the ceiling completes and dispatches every stage", async () => {
  const backend = new CountingBackend(0.01);
  const ledger = new RunCostLedger({ ceilingUsd: 1.0 });
  const plan = [stage("Alpha"), stage("Beta"), stage("Gamma")];

  const result = await runAdvisoryPipeline(
    { toolId: "squad_run", request: "cheap advisory run", mode: "autopilot" },
    { backend, costLedger: ledger },
    { plan, mode: "autopilot" },
  );

  assert.equal(result.outcome, "completed");
  assert.equal(backend.calls, 3);
  assert.equal(result.stages.length, 3);
});
