import assert from "node:assert/strict";
import { test } from "node:test";

import type { ToolCatalog } from "../src/catalog/catalog.js";
import {
  buildDescriptor,
  loadGeneratorInputs,
  validateCatalog,
} from "../generators/build-manifests.js";

function clone(catalog: ToolCatalog): ToolCatalog {
  return JSON.parse(JSON.stringify(catalog)) as ToolCatalog;
}

const inputs = loadGeneratorInputs();

test("the drift check passes on the real catalog and deployed cast", () => {
  const errors = validateCatalog(inputs.catalog, inputs.routingRows, inputs.knownAgents);
  assert.deepEqual(errors, []);
});

test("known agents resolve the mapped roles and council members", () => {
  assert.ok(inputs.knownAgents.has("Task Researcher"));
  assert.ok(inputs.knownAgents.has("Task Planner"));
  assert.ok(inputs.knownAgents.has("Task Reviewer"));
  assert.ok(inputs.knownAgents.has("System Architecture Reviewer"));
  assert.ok(inputs.knownAgents.has("Squad Coordinator"));
  assert.ok(inputs.knownAgents.has("Security Planner"));
});

test("the drift check FAILS when a tool maps to a nonexistent agent", () => {
  const mutated = clone(inputs.catalog);
  mutated.tools[0].role = "Nonexistent Agent ZZZ";
  const errors = validateCatalog(mutated, inputs.routingRows, inputs.knownAgents);
  assert.ok(errors.length > 0, "a drift error is reported");
  assert.ok(
    errors.some((message) => /Nonexistent Agent ZZZ/.test(message)),
    "the error names the missing agent",
  );
});

test("the drift check FAILS when a tool maps to a nonexistent routing intent", () => {
  const mutated = clone(inputs.catalog);
  const firstNonCatchAll = mutated.tools.find((tool) => !tool.catchAll);
  assert.ok(firstNonCatchAll, "there is a non-catch-all tool to mutate");
  firstNonCatchAll.routingIntent = "totally bogus intent zzz";
  const errors = validateCatalog(mutated, inputs.routingRows, inputs.knownAgents);
  assert.ok(
    errors.some((message) => /does not match any routing row/.test(message)),
    "the error reports the missing routing intent",
  );
});

test("the drift check FAILS when a council member is not installed", () => {
  const mutated = clone(inputs.catalog);
  const reviewTool = mutated.tools.find((tool) => tool.id === "squad_review");
  assert.ok(reviewTool, "squad_review exists");
  reviewTool.council.push("Ghost Council Member");
  const errors = validateCatalog(mutated, inputs.routingRows, inputs.knownAgents);
  assert.ok(errors.some((message) => /Ghost Council Member/.test(message)));
});

test("buildDescriptor projects exactly the 5 catalog tools", () => {
  const descriptor = buildDescriptor(inputs.catalog);
  assert.equal(descriptor.tools.length, 5);
  assert.deepEqual(
    descriptor.tools.map((tool) => tool.name).sort(),
    ["squad_architect", "squad_plan", "squad_research", "squad_review", "squad_run"],
  );
  for (const tool of descriptor.tools) {
    assert.equal(typeof tool.routing.role, "string");
    assert.ok(tool.routing.role.length > 0);
  }
});
