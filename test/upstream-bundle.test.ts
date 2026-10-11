import assert from "node:assert/strict";
import { test } from "node:test";
import { installedUpstreamBundle } from "../src/engine/copilot/upstream-bundle.js";

const bundle = installedUpstreamBundle();
test("installed full runtime discovers complete skills and reads upstream procedures with provenance", () => {
  assert.equal(bundle.skills().length, 97);
  const skill = bundle.skills().find(s => s.name === "squad");
  assert.ok(skill);
  const body = bundle.read(skill.path);
  assert.match(body.content, /Operating Procedure/);
  assert.match(body.commit, /^[a-f0-9]{40}$/);
  assert.ok(skill.resources.includes(".github/skills/squad/scripts/Measure-SquadLedger.ps1"));
});
test("immutable resource access cannot read host files or exceed its declared range", () => {
  assert.throws(() => bundle.read("../package.json"), /Unsafe/);
  assert.throws(() => bundle.read(".github/skills/unknown/SKILL.md"), /not declared/);
  assert.throws(() => bundle.read(".github/skills/squad/SKILL.md", 0), /positive/);
  assert.throws(() => bundle.read(".github/skills/squad/SKILL.md", 1, 401), /400 lines/);
  const first = bundle.read(".github/skills/squad/SKILL.md", 1, 5);
  assert.equal(first.firstLine, 1);
  assert.equal(first.lastLine, 5);
  assert.equal(first.truncated, true);
});
