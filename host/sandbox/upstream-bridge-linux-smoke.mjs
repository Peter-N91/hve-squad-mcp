import { readdirSync } from "node:fs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { UpstreamBundle } from "/opt/hve-bridge/dist/src/engine/copilot/upstream-bundle.js";
import { UpstreamScriptBridge } from "/opt/hve-bridge/dist/src/engine/copilot/upstream-script-bridge.js";

const run = promisify(execFile);
const files = new Map();
let version = 0;
const store = {
  async get(tenantId, project, path) { assert.equal(tenantId, "smoke-tenant"); assert.equal(project, "smoke-project"); return files.get(path); },
  async list() { return [...files.values()].map(file => ({ path: file.path, size: Buffer.byteLength(file.content), updatedAt: file.updatedAt })); },
  async put(tenantId, project, path, content, expectedEtag) {
    const old = files.get(path);
    if (expectedEtag && old?.etag !== expectedEtag) return { ok: false, conflict: true, current: old };
    const artifact = { tenantId, project, path, content, etag: String(++version), updatedAt: Date.now() };
    files.set(path, artifact);
    return { ok: true, artifact };
  },
  async append() { throw new Error("Bridge must not use append without CAS."); },
};
const squad = ".copilot-tracking/squad/";
await store.put("smoke-tenant", "smoke-project", squad + "team.md", "# Members\n\nModel routing: economy\n\n| Role | Agent Name (Primary) | Model Tier |\n| --- | --- | --- |\n| developer | Squad Implementor | default |\n| tester | Squad Reviewer | fast |\n");
const preflight = {runId:"",roundId:"",ceilingUsd:null,evaluatedSpendUsd:0,remainingUsd:null,plannedDispatches:0,projectedCostUsd:0,reserveMultiplier:3,admissionCostUsd:0,confidence:"not-applicable",basis:"not-requested",decision:"not-requested",reason:"No cost ceiling configured."};
const stateUpdated = "2026-10-10T00:00:00.123Z";
await store.put("smoke-tenant", "smoke-project", squad + "state.json", JSON.stringify({schemaVersion:"1.4",updated:stateUpdated,turn:0,mode:"autopilot",activeRoles:[],openEscalations:[],currentRun:{costPreflight:preflight},notify:{}}));
await store.put("smoke-tenant", "smoke-project", squad + "decisions.md", "# Decisions\n");
const port = {
  async runServerCommand(command) {
    assert.ok(Buffer.byteLength(command) < 65536);
    const args = command.split(" ");
    try {
      const { stdout } = await run(args[0], args.slice(1), { encoding: "utf8", timeout: 120000, maxBuffer: 12000000 });
      return { success: true, exitCode: 0, output: stdout };
    } catch (error) {
      // This isolated smoke contains no credentials or user project content.
      console.error("Isolated workspace top-level names:", readdirSync("/workspace/.hve-upstream", {withFileTypes:true}).filter(x=>x.isDirectory()).map(x=>({workspace:x.name,children:readdirSync("/workspace/.hve-upstream/"+x.name)})));
      console.error("Isolated PowerShell smoke failure:", JSON.stringify({code:error.code,killed:error.killed,signal:error.signal,stderr:String(error.stderr).slice(0,2500),stdout:String(error.stdout).slice(0,2500)}));
      throw error;
    }
  },
};
const bridge = new UpstreamScriptBridge({store,tenantId:"smoke-tenant",project:"smoke-project",runId:"smoke-run",bundle:new UpstreamBundle("/opt/hve-upstream"),port});
await bridge.initializeMirror();
const preflightResult = await bridge.runScript({script:"Set-SquadCostPreflight",args:{
  expectedUpdated:stateUpdated,preflight:{...preflight,runId:"smoke-run",roundId:"round-0"},
}}, {writes:[{path:squad+"state.json",mode:"replace"},{path:squad+"decisions.md",mode:"append"}]});
assert.deepEqual(preflightResult.changedPaths, [squad+"state.json"]);
const seeded = await bridge.runScript({script:"Initialize-SquadConsumptionRates",args:{mode:"economy"}});
assert.deepEqual(seeded.changedPaths, [squad + "consumption-rates.md"]);
assert.equal(files.has(squad + "consumption-rates.md"), false, "No live commit before validation");
const measured = await bridge.runScript({script:"Measure-SquadLedger",args:{}});
const finops = JSON.parse(measured.output);
assert.equal(finops.unitEconomics.accepted, 0);
assert.equal(finops.unitEconomics.estCreditsPerAccepted, null);
const committed = await bridge.commitAllowedChanges();
assert.equal(committed.atomic, false);
assert.deepEqual([...committed.committedPaths].sort(), [squad + "consumption-rates.md", squad+"state.json"].sort());
assert.equal(files.get(squad+"decisions.md").content, "# Decisions\n");
assert.equal(JSON.parse(files.get(squad+"state.json").content).currentRun.costPreflight.decision,"not-requested");
assert.equal(JSON.parse(files.get(squad+"state.json").content).updated,stateUpdated);
console.log(JSON.stringify({test:"genuine Linux script/storage bridge",upstreamCommit:"a8d863a9715f0738f69711421b1897269911f68f",scripts:[preflightResult.script,seeded.script,measured.script],validatedBeforeCommit:true,atomic:false,unitEconomics:finops.unitEconomics,productionUsage:false}));
