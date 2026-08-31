import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  type CoworkManifest,
  validateSkillPackage,
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

test("Cowork plugin combines one project skill with v1.29 runtime MCP discovery", () => {
  assert.deepEqual(validateManifest(manifest), []);
  assert.deepEqual(validateSkillPackage(join(root, "cowork"), manifest), []);
  assert.equal(manifest.manifestVersion, "1.29");
  assert.deepEqual(manifest.agentSkills, [
    { folder: "./skills/hve-project-manager" },
  ]);

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
  assert.equal(
    existsSync(
      join(root, "cowork", "skills", "hve-project-manager", "SKILL.md"),
    ),
    true,
  );
});

test("Cowork project contract uses a OneDrive-safe activity filename", () => {
  const contract = readFileSync(
    join(
      root,
      "cowork",
      "skills",
      "hve-project-manager",
      "references",
      "project-contract.md",
    ),
    "utf8",
  );

  assert.match(contract, /activity\/000001-20260101T000000Z\.json/);
  assert.doesNotMatch(contract, /activity\/[^`\r\n]*T00:00:00Z\.json/);
});

test("Cowork project skill bounds cross-stage context and avoids blind retries", () => {
  const skill = readFileSync(
    join(root, "cowork", "skills", "hve-project-manager", "SKILL.md"),
    "utf8",
  );

  assert.match(skill, /no more than 256,000 characters/);
  assert.match(skill, /do not repeat the same\s+call/i);
  assert.match(skill, /retry once/i);
});

test("Cowork project skill negotiates schema-v2 project context and tracking updates", () => {
  const skill = readFileSync(
    join(root, "cowork", "skills", "hve-project-manager", "SKILL.md"),
    "utf8",
  );
  const contract = readFileSync(
    join(
      root,
      "cowork",
      "skills",
      "hve-project-manager",
      "references",
      "project-contract.md",
    ),
    "utf8",
  );

  assert.equal(manifest.version, "1.2.3");
  assert.match(skill, /projectContext\.schemaVersion/);
  assert.match(skill, /structuredContent\.contextBridge/);
  assert.match(skill, /trackingUpdates/);
  assert.match(contract, /"schemaVersion": 2/);
  assert.match(contract, /\.copilot-tracking\/squad\/history/);
  assert.match(contract, /Schema 1 migration/);
});

test("Cowork validation rejects pinned tool metadata and duplicate skills", () => {
  const pinned = clone(manifest);
  const remote = pinned.agentConnectors?.[0]?.toolSource?.remoteMcpServer;
  assert.ok(remote);
  remote.mcpToolDescription = { file: "tools/hve-squad-tools.json" };
  pinned.agentSkills = [
    { folder: "./skills/hve-project-manager" },
    { folder: "./skills/hve-project-manager" },
  ];

  const problems = validateManifest(pinned);
  assert.ok(problems.some((problem) => problem.includes("omit mcpToolDescription")));
  assert.ok(problems.some((problem) => problem.includes("Duplicate Agent Skill folder")));
});

test("Cowork validation requires the project-manager skill", () => {
  const noProjectManager = clone(manifest);
  noProjectManager.agentSkills = [];

  const problems = validateManifest(noProjectManager);
  assert.ok(problems.some((problem) => problem.includes("At least one agentSkill")));
  assert.ok(problems.some((problem) => problem.includes("./skills/hve-project-manager")));
});

test("Cowork validation rejects a declared skill with no SKILL.md", () => {
  const missingSkill = clone(manifest);
  missingSkill.agentSkills = [{ folder: "./skills/missing-skill" }];

  const problems = validateSkillPackage(join(root, "cowork"), missingSkill);
  assert.ok(problems.some((problem) => problem.includes("missing SKILL.md")));
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
