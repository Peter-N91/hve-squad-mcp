import assert from "node:assert/strict";
import { test } from "node:test";

import {
  computeRoutePlan,
  loadRosterMap,
  loadRoutingTables,
  parseRosterMap,
  parseRoutingIntents,
  route,
  type RoutingTables,
} from "../src/engine/routing.js";

// ---------------------------------------------------------------------------
// A small deterministic fixture of the routing + roster tables so the pure
// classifier is tested independent of disk contents. It mirrors the shape of
// the real Default Routing Rules + Cast Catalog rows the router parses.
// ---------------------------------------------------------------------------
const FIXTURE_TABLES: RoutingTables = {
  intents: [
    { patterns: ["research", "investigate", "explore", "find out"], roles: ["task researcher"], tier: "auto", parallelEligible: true },
    { patterns: ["plan", "break down", "sequence", "design plan"], roles: ["task planner"], tier: "confirm", parallelEligible: false },
    { patterns: ["implement", "build", "code", "fix"], roles: ["task implementor"], tier: "confirm", parallelEligible: false },
    { patterns: ["review", "validate", "check quality"], roles: ["task reviewer"], tier: "auto", parallelEligible: true },
    { patterns: ["security", "threat", "vulnerability", "stride"], roles: ["security planner"], tier: "confirm", parallelEligible: true },
    { patterns: ["architecture", "system design", "components"], roles: ["system architecture reviewer"], tier: "auto", parallelEligible: true },
    { patterns: ["responsible ai", "rai", "fairness", "harm"], roles: ["rai planner"], tier: "confirm", parallelEligible: true },
  ],
  rosterMap: new Map<string, string>([
    ["researcher", "Task Researcher"],
    ["lead", "Task Planner"],
    ["developer", "Task Implementor"],
    ["tester", "Task Reviewer"],
    ["architect", "System Architecture Reviewer"],
    ["security", "Security Planner"],
    ["cost-manager", "Squad Cost Manager"],
    ["product-owner", "ADO Backlog Manager"],
    ["rai", "RAI Planner"],
  ]),
};

test("a research-type request routes to a single researcher stage", () => {
  const plan = computeRoutePlan("research caching options for the API", {}, FIXTURE_TABLES);
  assert.equal(plan.stages.length, 1);
  assert.equal(plan.stages[0].role, "researcher");
  assert.equal(plan.stages[0].agentName, "Task Researcher");
  assert.equal(plan.stages[0].tier, "auto");
  assert.equal(plan.stages[0].parallelEligible, true);
  assert.equal(plan.council.engaged, false);
  assert.deepEqual(plan.council.members, []);
});

test("a full advisory request routes research -> plan -> review", () => {
  const plan = computeRoutePlan("plan and review the migration approach", {}, FIXTURE_TABLES);
  assert.deepEqual(
    plan.stages.map((s) => s.role),
    ["researcher", "lead", "tester"],
  );
  assert.deepEqual(
    plan.stages.map((s) => s.agentName),
    ["Task Researcher", "Task Planner", "Task Reviewer"],
  );
  // Per-stage tier/parallel come from the routing rows.
  assert.deepEqual(
    plan.stages.map((s) => s.tier),
    ["auto", "confirm", "auto"],
  );
  assert.deepEqual(
    plan.stages.map((s) => s.parallelEligible),
    [true, false, true],
  );
});

test("council engages when the request crosses two or more council domains", () => {
  const plan = computeRoutePlan(
    "review the security and cost tradeoffs of the proposed architecture",
    {},
    FIXTURE_TABLES,
  );
  assert.deepEqual(plan.stages.map((s) => s.role), ["researcher", "lead", "tester"]);
  assert.equal(plan.council.engaged, true);
  // Base council members resolve to their roster Primary agents.
  assert.deepEqual(plan.council.members, [
    "System Architecture Reviewer",
    "Security Planner",
    "Squad Cost Manager",
    "ADO Backlog Manager",
  ]);
});

test("council adds RAI when the request touches the RAI domain (>=2 domains)", () => {
  const plan = computeRoutePlan(
    "review the fairness and security posture of the model",
    {},
    FIXTURE_TABLES,
  );
  assert.equal(plan.council.engaged, true);
  assert.ok(plan.council.members.includes("RAI Planner"));
});

test("council does NOT engage for a full advisory request with fewer than two domains", () => {
  const plan = computeRoutePlan("plan and review the caching change", {}, FIXTURE_TABLES);
  assert.deepEqual(plan.stages.map((s) => s.role), ["researcher", "lead", "tester"]);
  assert.equal(plan.council.engaged, false);
  assert.deepEqual(plan.council.members, []);
});

test("a single council domain alone still routes full advisory but without council", () => {
  const plan = computeRoutePlan("review the security of the auth flow", {}, FIXTURE_TABLES);
  assert.deepEqual(plan.stages.map((s) => s.role), ["researcher", "lead", "tester"]);
  assert.equal(plan.council.engaged, false);
});

test("mode override forces the full advisory pipeline even for a research phrasing", () => {
  const plan = computeRoutePlan("research caching options", { mode: "autopilot" }, FIXTURE_TABLES);
  assert.deepEqual(plan.stages.map((s) => s.role), ["researcher", "lead", "tester"]);
});

test("profile=full override forces the full advisory pipeline", () => {
  const plan = computeRoutePlan("research caching options", { profile: "full" }, FIXTURE_TABLES);
  assert.deepEqual(plan.stages.map((s) => s.role), ["researcher", "lead", "tester"]);
});

// ---------------------------------------------------------------------------
// Read-only parsing of the real deployed routing + roster instructions.
// ---------------------------------------------------------------------------

test("parseRoutingIntents reads the real Default Routing Rules table", () => {
  const tables = loadRoutingTables();
  const intents = tables.intents;
  assert.ok(intents.length > 0, "routing rows parsed");
  const research = intents.find((r) => r.patterns.includes("research"));
  assert.ok(research, "the research intent row is present");
  assert.equal(research.tier, "auto");
  assert.equal(research.parallelEligible, true);
  const plan = intents.find((r) => r.patterns.includes("plan"));
  assert.ok(plan, "the plan intent row is present");
  assert.equal(plan.tier, "confirm");
  assert.equal(plan.parallelEligible, false);
});

test("parse helpers accept raw markdown directly (mirrors the generator parser)", () => {
  const routingMd = [
    "| Pattern / Keyword | Role(s) | Autonomy Tier | Parallel-Eligible |",
    "|---|---|---|---|",
    "| research, investigate | Task Researcher | auto | yes |",
    "| plan, sequence | Task Planner | confirm | no |",
  ].join("\n");
  const intents = parseRoutingIntents(routingMd);
  assert.equal(intents.length, 2);
  assert.deepEqual(intents[0].patterns, ["research", "investigate"]);
  assert.equal(intents[1].tier, "confirm");

  const rosterMd = [
    "| Role | Primary Agent (`name:`) | Alternate Agents (`name:`) | Selection Cue |",
    "|---|---|---|---|",
    "| lead | Task Planner | RPI Agent | plan |",
    "| devrel | — | — | Thin charter needed |",
  ].join("\n");
  const map = parseRosterMap(rosterMd);
  assert.equal(map.get("lead"), "Task Planner");
  assert.equal(map.has("devrel"), false, "thin-charter roles are skipped");
});

test("loadRosterMap resolves role keys to roster Primary agents", () => {
  const map = loadRosterMap();
  assert.equal(map.get("architect"), "System Architecture Reviewer");
  assert.equal(map.get("tester"), "Task Reviewer");
  assert.equal(map.get("lead"), "Task Planner");
  assert.equal(map.get("researcher"), "Task Researcher");
});

test("route() over the real instructions classifies a research request to one stage", () => {
  const plan = route("investigate the current caching layer");
  assert.equal(plan.stages.length, 1);
  assert.equal(plan.stages[0].role, "researcher");
  assert.equal(plan.stages[0].agentName, "Task Researcher");
});

test("route() over the real instructions classifies a multi-domain request with council", () => {
  const plan = route("review the security and cost of the proposed architecture");
  assert.deepEqual(plan.stages.map((s) => s.role), ["researcher", "lead", "tester"]);
  assert.equal(plan.council.engaged, true);
  assert.ok(plan.council.members.includes("Security Planner"));
  assert.ok(plan.council.members.includes("Squad Cost Manager"));
});
