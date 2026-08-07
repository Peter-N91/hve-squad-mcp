/**
 * The advisory gate release is a NARROWING of the human gate, not an override.
 *
 * It exists because a Copilot Studio agent cannot reach `/admin/approve`, so a
 * `product` run would otherwise hold forever waiting for a human who is not in
 * that loop. That makes it the one place where a hold can become a proceed, and
 * therefore the one place worth attacking. These tests pin the four properties
 * that keep it safe.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { GateKeeper, IMPACTFUL_ROLES, isAdvisoryOnly } from "../src/engine/gates.js";
import { loadProfileTables, resolveProfile } from "../src/engine/profiles.js";
import type { CatalogTool } from "../src/catalog/catalog.js";

const TABLES = loadProfileTables();

const PIPELINE_TOOL = {
  id: "squad_run",
  title: "Squad Run",
  description: "",
  routingIntent: "*",
  role: "Squad Coordinator",
  tier: "confirm",
  parallelEligible: false,
  council: [],
  catchAll: true,
  gates: true,
  input: { type: "object" },
} as unknown as CatalogTool;

test("the default posture is unchanged: an advisory-only run still holds", () => {
  const gate = new GateKeeper();
  const decision = gate.classify({ tool: PIPELINE_TOOL, advisoryOnly: true });
  assert.equal(decision.kind, "hold");
});

test("with the operator flag on, an advisory-only run proceeds", () => {
  const gate = new GateKeeper({ advisoryAutopilotEnabled: true });
  const decision = gate.classify({ tool: PIPELINE_TOOL, advisoryOnly: true });
  assert.equal(decision.kind, "proceed");
});

test("a run that is not advisory-only still holds even with the flag on", () => {
  const gate = new GateKeeper({ advisoryAutopilotEnabled: true });
  assert.equal(gate.classify({ tool: PIPELINE_TOOL, advisoryOnly: false }).kind, "hold");
  // An absent flag is not a permission.
  assert.equal(gate.classify({ tool: PIPELINE_TOOL }).kind, "hold");
});

test("a destructive run holds regardless of the flag and the advisory claim", () => {
  const gate = new GateKeeper({ advisoryAutopilotEnabled: true });
  const decision = gate.classify({
    tool: PIPELINE_TOOL,
    advisoryOnly: true,
    destructive: true,
  });
  assert.equal(decision.kind, "hold");
  assert.match(decision.kind === "hold" ? decision.reason : "", /destructive/);
});

test("autonomy mode never releases a gate on its own", () => {
  const gate = new GateKeeper({ advisoryAutopilotEnabled: true });
  for (const mode of ["autonomous", "autopilot"]) {
    assert.equal(gate.classify({ tool: PIPELINE_TOOL, mode }).kind, "hold");
  }
});

test("the product profile is advisory-only; azure and operations are not", () => {
  assert.equal(isAdvisoryOnly(resolveProfile("product", TABLES).roles), true);
  assert.equal(isAdvisoryOnly(resolveProfile("default", TABLES).roles), true);
  // These seed deployer / iac-author / azure-diagnose, which reach outside the tree.
  assert.equal(isAdvisoryOnly(resolveProfile("azure", TABLES).roles), false);
  assert.equal(isAdvisoryOnly(resolveProfile("operations", TABLES).roles), false);
  assert.equal(isAdvisoryOnly(resolveProfile("full", TABLES).roles), false);
});

test("no profile seeds backlog-executor, so a live backlog write is never auto-released", () => {
  for (const name of TABLES.profiles.keys()) {
    assert.ok(
      !resolveProfile(name, TABLES).roles.includes("backlog-executor"),
      `${name} must not seed backlog-executor`,
    );
  }
  assert.ok(IMPACTFUL_ROLES.has("backlog-executor"));
});
