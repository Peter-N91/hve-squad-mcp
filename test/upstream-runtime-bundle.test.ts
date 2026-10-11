import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { upstreamDestination, verifyGitBlob } from "../host/snapshot-upstream.js";

const root = join(process.cwd(), "host", "upstream-runtime");
interface Manifest { sourceCommit: string; sourceRef: string; files: { path: string; blob: string; bytes: number; sha256: string; source: string; commit: string }[] }
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as Manifest;
const pin = JSON.parse(readFileSync(join(process.cwd(), "host", "upstream-pin.json"), "utf8")) as { commit: string; ref: string };

function paths(dir: string, prefix = ""): string[] {
  return readdirSync(dir).flatMap(name => {
    const full = join(dir, name), rel = prefix ? prefix + "/" + name : name;
    return statSync(full).isDirectory() ? paths(full, rel) : [rel];
  });
}

test("complete preview bundle preserves every immutable Git blob, including binary assets", () => {
  assert.equal(manifest.sourceCommit, pin.commit);
  assert.equal(manifest.sourceRef, pin.ref);
  assert.match(pin.commit, /^[a-f0-9]{40}$/);
  assert.ok(manifest.files.length > 1000);
  for (const file of manifest.files) {
    const bytes = readFileSync(join(root, ...file.path.split("/")));
    assert.equal(bytes.length, file.bytes, file.path);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256, file.path);
    verifyGitBlob(bytes, file.blob);
    assert.match(file.commit, /^[a-f0-9]{40}$/, file.source);
  }
  assert.deepEqual(paths(root).sort(), [...manifest.files.map(file => file.path), "apm.yml", "manifest.json", "README.md"].sort());
});
test("complete dependency tree contains upstream orchestration, FinOps and license notices", () => {
  const files = new Set(manifest.files.map(file => file.path));
  for (const file of ["SKILL.md", "scripts/Measure-SquadLedger.ps1", "scripts/Resolve-SquadModelRoute.ps1", "scripts/Write-SquadHandoff.ps1", "scripts/Get-SquadDispatchBrief.ps1", "scripts/Set-SquadCostPreflight.ps1", "scripts/Initialize-SquadConsumptionRates.ps1"]) {
    assert.ok(files.has(".github/skills/squad/" + file), file);
  }
  assert.ok(manifest.files.filter(file => file.path.endsWith("/SKILL.md")).length > 90);
  for (const repo of ["Peter-N91/hve-squad", "microsoft/hve-core", "github/awesome-copilot"]) {
    assert.ok(manifest.files.some(file => file.path.startsWith("licenses/" + repo + "/LICENSE")));
  }
});
test("upstream layout mapping and blob verification do not accept invented bytes", () => {
  assert.equal(upstreamDestination("squad-src/.github/skills/squad/scripts/x.ps1"), ".github/skills/squad/scripts/x.ps1");
  assert.equal(upstreamDestination("skills/example/SKILL.md"), ".github/skills/example/SKILL.md");
  assert.equal(upstreamDestination("unrelated/file.txt"), undefined);
  assert.throws(() => verifyGitBlob(Buffer.from("modified"), "0".repeat(40)), /immutable Git blob/);
});
