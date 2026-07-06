import assert from "node:assert/strict";
import { test } from "node:test";

import { loadCatalog } from "../src/catalog/catalog.js";
import { ToolInputError, ToolRouter } from "../src/router/router.js";

const catalog = loadCatalog();
const router = new ToolRouter(catalog);

const EXPECTED_TOOLS = [
  "squad_architect",
  "squad_plan",
  "squad_research",
  "squad_review",
  "squad_run",
];

test("tools/list returns exactly the 5 coarse squad tools", () => {
  const descriptors = router.listToolDescriptors();
  assert.equal(descriptors.length, 5);
  assert.deepEqual(
    descriptors.map((d) => d.name).sort(),
    EXPECTED_TOOLS,
  );
  for (const descriptor of descriptors) {
    assert.equal(typeof descriptor.description, "string");
    assert.ok(descriptor.description.length > 0, `${descriptor.name} has a description`);
    assert.equal(
      (descriptor.inputSchema as { type?: string }).type,
      "object",
      `${descriptor.name} advertises an object input schema`,
    );
  }
});

test("malformed tool input is rejected by schema validation", () => {
  // Missing required `request`.
  assert.throws(() => router.validateInput("squad_research", {}), ToolInputError);
  // Wrong type for `request`.
  assert.throws(() => router.validateInput("squad_research", { request: 123 }), ToolInputError);
  // Unknown property (additionalProperties: false).
  assert.throws(
    () => router.validateInput("squad_research", { request: "x", bogus: true }),
    ToolInputError,
  );
  // Invalid enum value.
  assert.throws(
    () => router.validateInput("squad_plan", { request: "x", profile: "not-a-profile" }),
    ToolInputError,
  );
});

test("valid input passes validation and maps to a CoordinatorRequest", () => {
  assert.doesNotThrow(() =>
    router.validateInput("squad_research", { request: "caching options", profile: "default" }),
  );
  const tool = router.getTool("squad_research");
  assert.ok(tool, "squad_research is a known tool");
  const coordinatorRequest = router.toCoordinatorRequest(tool, {
    request: "caching options",
    profile: "default",
    mode: "autopilot",
  });
  assert.equal(coordinatorRequest.toolId, "squad_research");
  assert.equal(coordinatorRequest.request, "caching options");
  assert.equal(coordinatorRequest.profile, "default");
  assert.equal(coordinatorRequest.mode, "autopilot");
});

test("an unknown tool id is rejected", () => {
  assert.throws(() => router.validateInput("squad_nope", { request: "x" }), ToolInputError);
  assert.equal(router.getTool("squad_nope"), undefined);
});
