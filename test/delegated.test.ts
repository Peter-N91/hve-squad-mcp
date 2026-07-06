import assert from "node:assert/strict";
import { test } from "node:test";

import { loadCatalog, type CatalogTool } from "../src/catalog/catalog.js";
import { DelegatedCoordinator } from "../src/engine/delegated.js";

const catalog = loadCatalog();
const engine = new DelegatedCoordinator();

function byId(id: string): CatalogTool {
  const tool = catalog.tools.find((t) => t.id === id);
  assert.ok(tool, `catalog defines ${id}`);
  return tool;
}

test("the delegated engine reports delegated mode (runs no model)", () => {
  assert.equal(engine.mode, "delegated");
});

test("squad_research returns the persona + routing + framedRequest contract", async () => {
  const tool = byId("squad_research");
  const result = await engine.handle(tool, {
    toolId: tool.id,
    request: "Research caching options for our API",
  });

  assert.equal(result.kind, "delegated");
  // systemPrompt carries the Coordinator persona and Dispatch Discipline.
  assert.match(result.systemPrompt, /Squad Coordinator/);
  assert.match(result.systemPrompt, /Dispatch Discipline/);
  // matchedRouting reflects the catalog row.
  assert.equal(result.matchedRouting.role, "Task Researcher");
  assert.equal(result.matchedRouting.routingIntent, "research, investigate, explore, find out");
  assert.equal(result.matchedRouting.tier, "auto");
  assert.equal(result.matchedRouting.parallelEligible, true);
  // framedRequest names the role and carries the request verbatim.
  assert.match(result.framedRequest, /Task Researcher/);
  assert.match(result.framedRequest, /Research caching options for our API/);
  // stateContext points at the squad state root.
  assert.match(result.stateContext, /\.copilot-tracking\/squad\//);
});

test("squad_run frames the full pipeline and carries gates + mode", async () => {
  const tool = byId("squad_run");
  const result = await engine.handle(tool, {
    toolId: tool.id,
    request: "Build feature X end to end",
    mode: "autopilot",
  });

  assert.equal(result.matchedRouting.catchAll, true);
  assert.equal(result.matchedRouting.gates, true);
  assert.match(result.systemPrompt, /Implementation Gate/);
  assert.match(result.systemPrompt, /autopilot/);
  assert.match(result.framedRequest, /classify this request/);
  assert.match(result.framedRequest, /Build feature X end to end/);
});

test("squad_review surfaces the council members and gate context", async () => {
  const tool = byId("squad_review");
  const result = await engine.handle(tool, {
    toolId: tool.id,
    request: "Pre-implementation go/no-go for the design",
  });

  assert.ok(result.matchedRouting.council.includes("Security Planner"));
  assert.ok(result.matchedRouting.council.includes("System Architecture Reviewer"));
  assert.match(result.systemPrompt, /Implementation Gate/);
  assert.match(result.framedRequest, /council/i);
});

test("context is appended to the framed request when provided", async () => {
  const tool = byId("squad_research");
  const result = await engine.handle(tool, {
    toolId: tool.id,
    request: "Research options",
    context: "Constraint: must stay on the current Node LTS.",
  });
  assert.match(result.framedRequest, /Constraint: must stay on the current Node LTS\./);
});
