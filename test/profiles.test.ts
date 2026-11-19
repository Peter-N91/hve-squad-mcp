import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { loadCatalog } from "../src/catalog/catalog.js";
import { parseTables } from "../src/engine/markdown-table.js";
import { REGISTERED_PACKS } from "../src/engine/persona.js";
import {
  DEFAULT_PROFILE,
  DELIVERABLE_PRODUCING_ROLES,
  deliverableRootFor,
  INTAKE_VALIDATOR_ROLE,
  loadProfileTables,
  parseDeliverableRoots,
  parseProfiles,
  resolveProfile,
  SCRIBE_ROLE,
} from "../src/engine/profiles.js";
import { loadRosterMap, route } from "../src/engine/routing.js";
import { resolveSquadGithubRoot } from "../src/paths.js";

const TABLES = loadProfileTables();

test("the deployed roster yields every documented profile", () => {
  const names = [...TABLES.profiles.keys()].sort();
  assert.deepEqual(names, [
    "accessibility",
    "architecture",
    "azure",
    "compliance",
    "default",
    "design",
    "full",
    "modernization",
    "operations",
    "product",
    "security",
  ]);
});

test("every catalog tool offers the full deployed profile set", () => {
  const expected = [...TABLES.profiles.keys()].sort();
  const catalog = loadCatalog();
  for (const tool of catalog.tools) {
    const schema = tool.input as { properties?: Record<string, { enum?: string[] }> };
    assert.deepEqual(
      [...(schema.properties?.profile?.enum ?? [])].sort(),
      expected,
      `${tool.id} profile enum must match squad-roster.instructions.md`,
    );
  }
});

test("REGISTERED_PACKS matches the Registered Packs table in squad-roster.instructions.md", () => {
  const githubRoot = resolveSquadGithubRoot();
  assert.ok(githubRoot, "squad .github root resolves");
  const rosterMd = readFileSync(
    join(githubRoot, "instructions", "squad", "squad-roster.instructions.md"),
    "utf8",
  );
  const packTable = parseTables(rosterMd).find(
    (t) =>
      (t.headers[0] ?? "").trim().toLowerCase() === "pack" &&
      t.headers.some((h) => h.toLowerCase().includes("adds")),
  );
  assert.ok(packTable, "Registered Packs table found in squad-roster.instructions.md");
  const deployedPacks = packTable.rows
    .map((row) => (row[0] ?? "").replace(/`/g, "").trim().toLowerCase())
    .filter((name) => name.length > 0);
  assert.deepEqual(deployedPacks, [...REGISTERED_PACKS]);
});

test("the product profile seeds exactly the roster's twelve roles", () => {
  const product = resolveProfile("product", TABLES);
  assert.equal(product.name, "product");
  assert.equal(product.requestedFound, true);
  assert.deepEqual(product.roles, [
    "researcher",
    "lead",
    "developer",
    "tester",
    "analyst",
    "designer",
    "product-owner",
    "technical-writer",
    "experimenter",
    "data-scientist",
    "intake-validator",
    "scribe",
  ]);
});

test("every profile carries the scribe and the methodology spine", () => {
  for (const [name, roles] of TABLES.profiles) {
    assert.ok(roles.includes(SCRIBE_ROLE), `${name} must seed the scribe`);
    for (const spine of ["researcher", "lead", "developer", "tester"]) {
      assert.ok(roles.includes(spine), `${name} must carry the ${spine} spine role`);
    }
  }
});

test("the intake gate is seeded by product and full only", () => {
  const withGate = [...TABLES.profiles]
    .filter(([, roles]) => roles.includes(INTAKE_VALIDATOR_ROLE))
    .map(([name]) => name)
    .sort();
  assert.deepEqual(withGate, ["full", "product"]);
});

test("only product and full fan the implement stage out across deliverable specialists", () => {
  const fanning = [...TABLES.profiles.keys()]
    .filter((name) => resolveProfile(name, TABLES).fansOut)
    .sort();
  assert.deepEqual(fanning, ["full", "product"]);
  assert.equal(resolveProfile("product", TABLES).deliverableRoles.length, 6);
});

test("every deliverable-producing role is a real catalog role", () => {
  const roster = loadRosterMap();
  for (const role of DELIVERABLE_PRODUCING_ROLES) {
    assert.ok(roster.has(role), `${role} is named in profiles.ts but absent from the cast catalog`);
  }
});

test("an unknown or omitted profile falls back to default without throwing", () => {
  for (const requested of [undefined, "", "  ", "nonesuch"]) {
    const resolved = resolveProfile(requested, TABLES);
    assert.equal(resolved.name, DEFAULT_PROFILE);
    assert.equal(resolved.requestedFound, false);
    assert.equal(resolved.fansOut, false);
    assert.equal(resolved.hasIntakeGate, false);
  }
});

test("deliverable roots resolve their date and deck-slug placeholders", () => {
  assert.equal(
    deliverableRootFor("researcher", TABLES, { date: "2026-08-07" }),
    ".copilot-tracking/research/2026-08-07",
  );
  assert.equal(deliverableRootFor("lead", TABLES), ".copilot-tracking/plans");
  assert.equal(deliverableRootFor("intake-validator", TABLES), ".copilot-tracking/reviews");
  // Custom rosters or connectors may still declare a `<deck-slug>` placeholder.
  const customTables = {
    ...TABLES,
    deliverableRoots: new Map([
      ...TABLES.deliverableRoots,
      ["presenter", ".copilot-tracking/ppt/<date>/<deck-slug>"],
    ]),
  };
  assert.equal(
    deliverableRootFor("presenter", customTables, { date: "2026-08-07", slug: "q3-review" }),
    ".copilot-tracking/ppt/2026-08-07/q3-review",
  );
});

test("a role that returns findings rather than an artifact has no deliverable root", () => {
  for (const role of [
    "cost-manager",
    "deployer",
    "fact-checker",
    "asbuilt-author",
    "azure-diagnose",
    "aws-diagnose",
    "scribe",
  ]) {
    assert.equal(deliverableRootFor(role, TABLES), undefined, `${role} should have no root`);
  }
});

test("a federation sub-squad rebases tracking roots but not docs or outputs", () => {
  assert.equal(
    deliverableRootFor("lead", TABLES, { squad: "product" }),
    ".copilot-tracking/squad/members/product/plans",
  );
  assert.equal(
    deliverableRootFor("researcher", TABLES, { squad: "product", date: "2026-08-07" }),
    ".copilot-tracking/squad/members/product/research/2026-08-07",
  );
  // Published documentation and data-science outputs stay repository-wide.
  assert.equal(deliverableRootFor("technical-writer", TABLES, { squad: "product" }), "docs");
  assert.equal(deliverableRootFor("data-scientist", TABLES, { squad: "product" }), "outputs");
});

test("a malformed roster is rejected rather than silently yielding an empty profile set", () => {
  assert.throws(() => parseProfiles("# no tables here"), /Squad Profiles table/);
  assert.throws(() => parseDeliverableRoots("# no tables here"), /Deliverable Roots table/);
});

test("route() seeds the product profile, its intake gate, and its fan-out", () => {
  const plan = route("draft the requirements for the new onboarding experience", {
    profile: "product",
  });
  assert.equal(plan.profile, "product");
  assert.equal(plan.intake?.role, INTAKE_VALIDATOR_ROLE);
  assert.equal(plan.intake?.agentName, "PRD Quality Reviewer");
  assert.deepEqual(
    plan.fanOut.map((stage) => stage.role),
    [...DELIVERABLE_PRODUCING_ROLES],
  );
});

test("route() gives a non-product profile no intake gate and no fan-out", () => {
  const plan = route("plan the caching work", { profile: "architecture" });
  assert.equal(plan.profile, "architecture");
  assert.equal(plan.intake, undefined);
  assert.deepEqual(plan.fanOut, []);
});
