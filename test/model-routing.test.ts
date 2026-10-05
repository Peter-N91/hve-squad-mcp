/**
 * Per-role model routing (`routing=off|ranked|manual`, hve-squad 0.18.0).
 *
 * The `/squad` and `/squad-federation` prompts gained a `routing` argument that
 * the coordinator persists in `team.md`. The two catch-all tools mirror it on the
 * attended (delegated) path; the narrower per-role tools do not, because they
 * mirror a single routing intent rather than the `/squad` entry point.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { loadCatalog, type CatalogTool } from "../src/catalog/catalog.js";
import { DelegatedCoordinator } from "../src/engine/delegated.js";
import { MODEL_ROUTING_MODES, routingInstructions } from "../src/engine/persona.js";
import { ToolRouter } from "../src/router/router.js";

const catalog = loadCatalog();
const engine = new DelegatedCoordinator();

function byId(id: string): CatalogTool {
  const tool = catalog.tools.find((t) => t.id === id);
  assert.ok(tool, `catalog tool ${id} exists`);
  return tool;
}

test("the catch-all tools offer exactly the routing modes the persona resolves", () => {
  for (const id of ["squad_run", "squad_federate"]) {
    const schema = byId(id).input as { properties?: Record<string, { enum?: string[] }> };
    assert.deepEqual(schema.properties?.routing?.enum, [...MODEL_ROUTING_MODES], `${id} routing enum`);
  }
});

test("the narrower per-role tools do not offer a routing mode", () => {
  for (const id of ["squad_research", "squad_plan", "squad_review", "squad_architect"]) {
    const schema = byId(id).input as { properties?: Record<string, unknown> };
    assert.equal(schema.properties?.routing, undefined, `${id} has no routing input`);
  }
});

test("the router carries a validated routing mode into the coordinator request", () => {
  const router = new ToolRouter(catalog);
  const request = router.toCoordinatorRequest(byId("squad_run"), {
    request: "ship the change",
    routing: "ranked",
  });
  assert.equal(request.routing, "ranked");
});

test("an explicit routing mode is forwarded verbatim and recorded in the state context", async () => {
  const result = await engine.handle(byId("squad_run"), {
    toolId: "squad_run",
    request: "ship the change",
    routing: "manual",
  });
  assert.match(result.systemPrompt, /Model routing = manual \(explicit input\)/);
  assert.match(result.systemPrompt, /`routing=manual`/);
  assert.match(result.systemPrompt, /Scribe never inherits the session model/);
  assert.match(result.stateContext, /- model routing: manual/);
});

test("the federation tool forwards the routing mode to every selected sub-squad", async () => {
  const result = await engine.handle(byId("squad_federate"), {
    toolId: "squad_federate",
    request: "plan the platform work",
    routing: "ranked",
  });
  assert.match(result.systemPrompt, /Model routing = ranked/);
  assert.match(result.systemPrompt, /never widen or substitute it/);
});

test("an absent routing mode adds no block and defers to team.md", async () => {
  const result = await engine.handle(byId("squad_run"), {
    toolId: "squad_run",
    request: "ship the change",
  });
  assert.doesNotMatch(result.systemPrompt, /Model routing =/);
  assert.match(result.stateContext, /- model routing: \(as recorded in team\.md/);
  assert.equal(routingInstructions(undefined), "");
  assert.equal(routingInstructions("cheapest"), "");
});
