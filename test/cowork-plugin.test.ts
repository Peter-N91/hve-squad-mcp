import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  type CoworkManifest,
  validateManifest,
} from "../generators/build-cowork-plugin.js";
import { packageRoot } from "../src/paths.js";

function clone(manifest: CoworkManifest): CoworkManifest {
  return JSON.parse(JSON.stringify(manifest)) as CoworkManifest;
}

const root = packageRoot();
const manifest = JSON.parse(
  readFileSync(join(root, "cowork", "manifest.json"), "utf8"),
) as CoworkManifest;

test("Cowork plugin uses v1.29 runtime MCP discovery without skills or pinned tools", () => {
  assert.deepEqual(validateManifest(manifest), []);
  assert.equal(manifest.manifestVersion, "1.29");
  assert.equal(manifest.agentSkills, undefined);

  const remote = manifest.agentConnectors?.[0]?.toolSource?.remoteMcpServer;
  assert.ok(remote);
  assert.equal(
    Object.prototype.hasOwnProperty.call(remote, "mcpToolDescription"),
    false,
  );
  assert.equal(
    existsSync(join(root, "cowork", "tools", "hve-squad-tools.json")),
    false,
  );
});

test("Cowork validation rejects pinned tool metadata and Agent Skills", () => {
  const pinned = clone(manifest);
  const remote = pinned.agentConnectors?.[0]?.toolSource?.remoteMcpServer;
  assert.ok(remote);
  remote.mcpToolDescription = { file: "tools/hve-squad-tools.json" };
  pinned.agentSkills = [{ folder: "skills/hve-squad-orchestrator" }];

  const problems = validateManifest(pinned);
  assert.ok(problems.some((problem) => problem.includes("omit mcpToolDescription")));
  assert.ok(problems.some((problem) => problem.includes("agentSkills must be omitted")));
});

test("Cowork validation rejects manifest versions before dynamic agent connectors", () => {
  const legacy = clone(manifest);
  legacy.manifestVersion = "1.28";
  legacy.$schema =
    "https://developer.microsoft.com/json-schemas/teams/v1.28/MicrosoftTeams.schema.json";

  const problems = validateManifest(legacy);
  assert.ok(problems.some((problem) => problem.includes("requires manifestVersion 1.29")));
  assert.ok(problems.some((problem) => problem.includes("must target the Teams 1.29 schema")));
});
