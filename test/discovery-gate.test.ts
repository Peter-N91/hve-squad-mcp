/**
 * Discovery gate (hve-squad@0.15.0) — the inverse trigger of the intake gate.
 *
 * The gate itself is executed by the HOST, so what this server owes is a faithful
 * charter and an honest input surface. These tests pin the three things that are
 * actually load-bearing: the gate precedes intake in the prompt, an explicit depth
 * resolves to the roles the roster says it dispatches, and the unattended path
 * never runs it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { loadCatalog, type CatalogTool } from "../src/catalog/catalog.js";
import { DelegatedCoordinator } from "../src/engine/delegated.js";
import {
  DISCOVERY_DEPTHS,
  DISCOVERY_DEPTH_ROLES,
  discoveryInstructions,
} from "../src/engine/persona.js";
import { loadProfileTables } from "../src/engine/profiles.js";

const catalog = loadCatalog();
const engine = new DelegatedCoordinator();
const TABLES = loadProfileTables();

function byId(id: string): CatalogTool {
  const tool = catalog.tools.find((t) => t.id === id);
  assert.ok(tool, `catalog defines ${id}`);
  return tool;
}

test("the gated tools carry the discovery gate ahead of the intake gate", async () => {
  const result = await engine.handle(byId("squad_run"), {
    toolId: "squad_run",
    request: "We need better reporting for field teams",
  });

  const discovery = result.systemPrompt.indexOf("Discovery Gate (opt-in)");
  const intake = result.systemPrompt.indexOf("**Intake Gate.**");
  assert.ok(discovery >= 0, "the discovery gate is stated");
  assert.ok(intake >= 0, "the intake gate is stated");
  assert.ok(discovery < intake, "discovery runs before intake, so it is stated first");
});

test("a tool that carries no gates says nothing about discovery", async () => {
  const tool = byId("squad_research");
  assert.equal(tool.gates, false);
  assert.equal(tool.council.length, 0);

  const result = await engine.handle(tool, {
    toolId: tool.id,
    request: "Research caching options for our API",
  });
  assert.doesNotMatch(result.systemPrompt, /Discovery Gate/);
});

test("every depth dispatches the roles the roster assigns it, in order", () => {
  assert.deepEqual(DISCOVERY_DEPTH_ROLES.quick, ["analyst"]);
  assert.deepEqual(DISCOVERY_DEPTH_ROLES.standard, ["designer", "analyst"]);
  assert.deepEqual(DISCOVERY_DEPTH_ROLES.deep, [
    "designer",
    "challenger",
    "experimenter",
    "analyst",
  ]);
  assert.deepEqual(DISCOVERY_DEPTH_ROLES.skip, []);
  // `analyst` writes the brief at every depth that runs one.
  for (const depth of DISCOVERY_DEPTHS) {
    if (depth === "skip") continue;
    assert.ok(DISCOVERY_DEPTH_ROLES[depth].includes("analyst"), `${depth} seeds analyst`);
    assert.equal(
      DISCOVERY_DEPTH_ROLES[depth].at(-1),
      "analyst",
      `${depth} writes the brief last, after the roles that feed it`,
    );
  }
});

test("an explicit depth names its roles and beats the offer", async () => {
  const result = await engine.handle(byId("squad_run"), {
    toolId: "squad_run",
    request: "Reduce onboarding drop-off",
    discovery: "deep",
  });

  assert.match(result.systemPrompt, /Discovery = deep \(explicit input\)/);
  assert.match(result.systemPrompt, /do not ask whether to run it/);
  for (const role of DISCOVERY_DEPTH_ROLES.deep) {
    assert.match(result.systemPrompt, new RegExp(`\`${role}\``));
  }
  assert.match(result.stateContext, /- discovery: deep/);
});

test("a declined session is still recorded, so the gate stops re-offering", () => {
  const block = discoveryInstructions("skip");
  assert.match(block, /Depth: skip/);
  assert.match(block, /Opt-In: explicit-input/);
  assert.match(block, /does not re-offer this topic/);
});

test("an unknown or absent depth adds no per-turn block", () => {
  assert.equal(discoveryInstructions(undefined), "");
  assert.equal(discoveryInstructions(""), "");
  assert.equal(discoveryInstructions("exhaustive"), "");
});

test("the catalog input surface matches the depths the persona resolves", () => {
  for (const id of ["squad_run", "squad_federate"]) {
    const schema = byId(id).input as {
      properties?: Record<string, { enum?: string[] }>;
    };
    const depths = schema.properties?.discovery?.enum;
    assert.deepEqual(depths, [...DISCOVERY_DEPTHS], `${id} offers exactly the resolvable depths`);
  }
});

test("the narrower per-role tools do not offer a discovery depth", () => {
  for (const id of ["squad_research", "squad_plan", "squad_review", "squad_architect"]) {
    const schema = byId(id).input as { properties?: Record<string, unknown> };
    assert.equal(
      schema.properties?.discovery,
      undefined,
      `${id} mirrors a single routing intent, not the /squad entry point`,
    );
  }
});

test("every depth role is a real cast-catalog role", () => {
  for (const depth of DISCOVERY_DEPTHS) {
    for (const role of DISCOVERY_DEPTH_ROLES[depth]) {
      assert.ok(TABLES.cast.has(role), `${depth} dispatches \`${role}\`, which the roster must cast`);
    }
  }
});

test("the gate's designer resolves to DT Coach for a facilitated session", () => {
  // The roster's Primary is the UX researcher; the gate's Selection Cue is a
  // design-thinking session, which is why the persona names the alternate.
  const designer = TABLES.cast.get("designer");
  assert.ok(designer?.alternates.includes("DT Coach"));
});

test("the offer is scoped to the profiles that seed the brief's author", () => {
  const withAnalyst = [...TABLES.profiles]
    .filter(([, roles]) => roles.includes("analyst"))
    .map(([name]) => name)
    .sort();
  assert.deepEqual(withAnalyst, ["full", "product"]);
});

test("deep is the only depth a product squad must add a role for", () => {
  const product = TABLES.profiles.get("product") ?? [];
  for (const depth of ["quick", "standard"] as const) {
    for (const role of DISCOVERY_DEPTH_ROLES[depth]) {
      assert.ok(product.includes(role), `product runs ${depth} unaided, but lacks \`${role}\``);
    }
  }
  const missingForDeep = DISCOVERY_DEPTH_ROLES.deep.filter((role) => !product.includes(role));
  assert.deepEqual(missingForDeep, ["challenger"]);
});
