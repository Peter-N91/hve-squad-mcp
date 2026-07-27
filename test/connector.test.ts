import assert from "node:assert/strict";
import { test } from "node:test";

import { loadCatalog } from "../src/catalog/catalog.js";
import {
  buildConnectorManifest,
  buildSwagger,
} from "../generators/build-copilot-studio-connector.js";

const manifest = buildConnectorManifest(loadCatalog());

test("the connector projects the remotely-exposed tools plus the synthetic status, render, and memory tools", () => {
  assert.deepEqual(
    manifest.tools.map((tool) => tool.name).sort(),
    [
      "squad_architect",
      "squad_backlog",
      "squad_business_plan",
      "squad_federate",
      "squad_memory_read",
      "squad_memory_write",
      "squad_plan",
      "squad_render_pptx",
      "squad_research",
      "squad_review",
      "squad_run",
      "squad_status",
    ],
  );
});

test("squad_memory_read and squad_memory_write carry their least-privilege scopes", () => {
  const byName = new Map(manifest.tools.map((tool) => [tool.name, tool]));
  assert.equal(byName.get("squad_memory_read")?.scope, "Squad.Memory");
  assert.equal(byName.get("squad_memory_write")?.scope, "Squad.MemoryWrite");
});

test("squad_run and squad_status carry the Squad.Run scope", () => {
  const byName = new Map(manifest.tools.map((tool) => [tool.name, tool]));
  assert.equal(byName.get("squad_run")?.scope, "Squad.Run");
  assert.equal(byName.get("squad_status")?.scope, "Squad.Run");
});

test("squad_run copy describes the async run-id + squad_status poll pattern", () => {
  const run = manifest.tools.find((tool) => tool.name === "squad_run");
  assert.ok(run);
  assert.match(run.description, /run id/i);
  assert.match(run.description, /squad_status/);
  assert.match(run.description, /Human Gate/);
});

test("no connector tool carries delegated-execution or squad-executed copy (PROD-2)", () => {
  // The deterministic tools (render + the memory broker) make no squad-guidance
  // fidelity claim — they are pure data operations with no model call — so only the
  // advisory/pipeline tools must carry the banner; the rest must NOT.
  const deterministicTools = new Set(["squad_render_pptx", "squad_memory_read", "squad_memory_write"]);
  for (const tool of manifest.tools) {
    assert.doesNotMatch(tool.description.toLowerCase(), /delegated execution/);
    assert.doesNotMatch(tool.description.toLowerCase(), /squad-executed/);
    if (!deterministicTools.has(tool.name)) {
      assert.match(tool.description, /squad-guided \/ embedded/);
    }
  }
});

test("the swagger security definition exposes the exposed tools' scopes", () => {
  const swagger = buildSwagger(manifest) as {
    securityDefinitions: { "entra-oauth2": { scopes: Record<string, string> } };
  };
  const scopes = Object.keys(swagger.securityDefinitions["entra-oauth2"].scopes).sort();
  assert.deepEqual(scopes, [
    "Squad.Architect",
    "Squad.Backlog",
    "Squad.Business",
    "Squad.Federate",
    "Squad.Memory",
    "Squad.MemoryWrite",
    "Squad.Plan",
    "Squad.Render",
    "Squad.Research",
    "Squad.Review",
    "Squad.Run",
  ]);
});
