import assert from "node:assert/strict";
import { test } from "node:test";

import { loadCatalog } from "../src/catalog/catalog.js";
import {
  buildConnectorManifest,
  buildSwagger,
} from "../generators/build-copilot-studio-connector.js";

const manifest = buildConnectorManifest(loadCatalog());

test("the connector projects the remotely-exposed tools plus squad_status and squad_render_pptx", () => {
  assert.deepEqual(
    manifest.tools.map((tool) => tool.name).sort(),
    ["squad_architect", "squad_plan", "squad_render_pptx", "squad_research", "squad_review", "squad_run", "squad_status"],
  );
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
  for (const tool of manifest.tools) {
    assert.doesNotMatch(tool.description.toLowerCase(), /delegated execution/);
    assert.doesNotMatch(tool.description.toLowerCase(), /squad-executed/);
    // The deterministic render tool makes no squad-guidance fidelity claim (it is a
    // pure file transform, no model call); every advisory tool carries the banner.
    if (tool.name !== "squad_render_pptx") {
      assert.match(tool.description, /squad-guided \/ embedded/);
    }
  }
});

test("the swagger security definition exposes the exposed tools' scopes", () => {
  const swagger = buildSwagger(manifest) as {
    securityDefinitions: { "entra-oauth2": { scopes: Record<string, string> } };
  };
  const scopes = Object.keys(swagger.securityDefinitions["entra-oauth2"].scopes).sort();
  assert.deepEqual(scopes, ["Squad.Architect", "Squad.Plan", "Squad.Render", "Squad.Research", "Squad.Review", "Squad.Run"]);
});
