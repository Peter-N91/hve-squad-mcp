/**
 * Conformance corpus 1 — embedded-vs-delegated parity (COST-4).
 *
 * The council bound the first embedded cut to a parity tolerance: the embedded
 * (server-side) result must match the delegated charter's INTENT within a defined
 * corpus, flagging drift above 5%. This corpus runs 12 representative
 * `squad_research` scenarios (plus two `squad_review` scenarios) through BOTH the
 * delegated engine (which returns the charter the VS Code host would execute) and
 * the embedded engine (which executes server-side via the deterministic mock
 * backend), then compares:
 *
 *   * routing parity — the embedded result's matched routing MUST equal the
 *     delegated charter's routing (same intent/role/tier/council/gates). Zero
 *     tolerance: both read the same catalog row, so any divergence is a defect.
 *   * structural parity — the embedded artifact carries the sections the delegated
 *     charter instructs the dispatched role to produce. Drift above 5% fails.
 *
 * Runs with a STUBBED verifier and a deterministic MOCK backend — no live Azure.
 */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import { loadCatalog, type CatalogTool } from "../../src/catalog/catalog.js";
import { DelegatedCoordinator } from "../../src/engine/delegated.js";
import { EmbeddedCoordinator } from "../../src/engine/embedded.js";
import { EphemeralWorkspaceManager } from "../../src/engine/workspace.js";
import { GateKeeper, TenantQuotaTracker } from "../../src/engine/gates.js";
import { TASK_RESEARCHER_CHARTER } from "../../src/engine/embedded-roles.js";
import type { AuthContext } from "../../src/auth/entra.js";
import { MockModelBackend } from "./support/mock-backend.js";
import {
  PARITY_SCENARIOS,
  REVIEW_PARITY_SCENARIOS,
  type ParityScenario,
} from "./support/scenarios.js";

const catalog = loadCatalog();

function toolById(id: string): CatalogTool {
  const tool = catalog.tools.find((t) => t.id === id);
  assert.ok(tool, `catalog defines ${id}`);
  return tool;
}

const AUTH: AuthContext = {
  tenantId: "parity-tenant",
  subject: "parity-subject",
  scopes: ["Squad.Research", "Squad.Review"],
  audience: "api://test",
};

/** The structural sections the delegated charter intends for each dispatched role. */
const EXPECTED_SECTIONS: Record<string, string[]> = {
  "Task Researcher": ["## Summary", "## Key Findings", "## Open Questions"],
  "Task Reviewer": ["## Verdict", "## Findings"],
};

const DRIFT_TOLERANCE = 0.05;

function makeEmbedded(backend: MockModelBackend): EmbeddedCoordinator {
  return new EmbeddedCoordinator({
    backend,
    workspaceManager: new EphemeralWorkspaceManager(),
    quota: new TenantQuotaTracker({ concurrency: 8, monthlyCeilingUsd: 1000 }),
    gates: new GateKeeper(),
  });
}

interface ParityAssessment {
  routingParity: boolean;
  structuralParity: boolean;
}

async function assessScenario(scenario: ParityScenario): Promise<ParityAssessment> {
  const tool = toolById(scenario.toolId);
  const delegated = new DelegatedCoordinator();
  const backend = new MockModelBackend();
  const embedded = makeEmbedded(backend);

  const request = { toolId: tool.id, request: scenario.request, context: scenario.context };
  const delegatedResult = await delegated.handle(tool, request);
  const embeddedResult = await embedded.handle(tool, request, { auth: AUTH });

  // Routing parity: same routing decision on both paths (same catalog row).
  const routingParity =
    JSON.stringify(embeddedResult.matchedRouting) === JSON.stringify(delegatedResult.matchedRouting);

  // Structural parity: the embedded artifact carries the role's intended sections.
  const expected = EXPECTED_SECTIONS[tool.role] ?? [];
  const artifact = embeddedResult.artifact ?? "";
  const structuralParity =
    embeddedResult.outcome === "completed" && expected.every((section) => artifact.includes(section));

  return { routingParity, structuralParity };
}

test("COST-4: embedded squad_research matches the delegated charter intent within tolerance", async (t: TestContext) => {
  let routingDrift = 0;
  let structuralDrift = 0;
  for (const scenario of PARITY_SCENARIOS) {
    const { routingParity, structuralParity } = await assessScenario(scenario);
    if (!routingParity) {
      routingDrift += 1;
    }
    if (!structuralParity) {
      structuralDrift += 1;
    }
  }
  const total = PARITY_SCENARIOS.length;
  const routingDriftRatio = routingDrift / total;
  const structuralDriftRatio = structuralDrift / total;

  t.diagnostic(
    `parity over ${total} squad_research scenarios: routing drift ` +
      `${(routingDriftRatio * 100).toFixed(1)}%, structural drift ` +
      `${(structuralDriftRatio * 100).toFixed(1)}% (gate ${DRIFT_TOLERANCE * 100}%)`,
  );

  // Routing must NEVER drift (zero tolerance).
  assert.equal(routingDriftRatio, 0, `routing drift ${routingDrift}/${total} must be 0`);
  // Structural/artifact parity must stay within the 5% tolerance (COST-4).
  assert.ok(
    structuralDriftRatio <= DRIFT_TOLERANCE,
    `structural drift ${(structuralDriftRatio * 100).toFixed(1)}% exceeds the ${DRIFT_TOLERANCE * 100}% gate`,
  );
});

test("COST-4: squad_review parity holds for the council-bearing hero tool", async () => {
  for (const scenario of REVIEW_PARITY_SCENARIOS) {
    const { routingParity, structuralParity } = await assessScenario(scenario);
    assert.ok(routingParity, `${scenario.name}: routing parity`);
    assert.ok(structuralParity, `${scenario.name}: structural parity`);
  }
});

test("COST-4: the embedded system authority is the dispatched role's charter (no fork)", async () => {
  const tool = toolById("squad_research");
  const backend = new MockModelBackend();
  const embedded = makeEmbedded(backend);
  await embedded.handle(tool, { toolId: tool.id, request: "Research X." }, { auth: AUTH });

  assert.equal(backend.callCount, 1);
  const system = backend.lastCall?.system ?? "";
  // The embedded system authority is EXACTLY the dispatched role's charter...
  assert.equal(system, TASK_RESEARCHER_CHARTER);
  assert.match(system, /Task Researcher/);
  // ...and NOT the catch-all coordinator persona: the delegated path injects the
  // coordinator-only "Dispatch Discipline" block (see delegated.test.ts), which
  // the role charter never carries. (The charter naming the Squad Coordinator as
  // its dispatcher is expected and is not the coordinator persona.)
  assert.doesNotMatch(system, /Dispatch Discipline/);
});
