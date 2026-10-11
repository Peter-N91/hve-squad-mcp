import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { attributeCompletion, type CompletionUsageRecord } from "../src/engine/model-backend.js";
import { copilotUsageFor } from "../src/engine/copilot/copilot-usage.js";
import { buildRunBillingLog } from "../src/engine/copilot/run-billing-log.js";

const scripts = join(process.cwd(), "host", "upstream-runtime", ".github", "skills", "squad", "scripts");
const pwsh = spawnSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], { timeout: 30000 });
const options = { skip: pwsh.status !== 0 ? "PowerShell unavailable; exercised by Linux integration tests" : false };
const block = (turn: number, outcome: string, request: string, deliverable: string) => `### 2026-10-10T12:00:00Z Fixture\n\n* Turn: ${turn}\n* Request: ${request}\n* Deliverable: ${deliverable}\n* Outcome: ${outcome}\n\n#### Consumption\n\n\`\`\`json\n${JSON.stringify({model:"gpt-5.3-codex",model_source:"dispatch-reported",priced_as:"gpt-5.3-codex",model_tier:"default",internal_turns:1,input_tokens:1000,cached_tokens:0,cache_write_tokens:0,output_tokens:100,basis:"estimated"})}\n\`\`\`\n`;

function exercise(verdict: "Pass" | "Fail", billing?: readonly CompletionUsageRecord[]) {
  const dir = mkdtempSync(join(tmpdir(), "upstream-finops-values-"));
  try {
    const team = "# Members\n\nModel routing: economy\n\n| Role | Agent Name (Primary) | Model Tier |\n| --- | --- | --- |\n| developer | Squad Implementor | default |\n| tester | Squad Reviewer | default |\n";
    writeFileSync(join(dir,"team.md"), team);
    const seed=spawnSync("pwsh",["-NoProfile","-File",join(scripts,"Initialize-SquadConsumptionRates.ps1"),"-SquadRoot",dir,"-Mode","economy"],{encoding:"utf8",timeout:60000});
    assert.equal(seed.status,0,seed.stderr);
    mkdirSync(join(dir,"history"));
    writeFileSync(join(dir,"history","Squad Implementor.md"), "# History: Squad Implementor\n\n"+block(1,"Produced report.","Write docs/report.md.","docs/report.md"));
    writeFileSync(join(dir,"history","Squad Reviewer.md"), "# History: Squad Reviewer\n\n"+block(1,verdict+": docs/report.md.","Independently review docs/report.md.","docs/review.md"));
    const logPath = join(dir, "events.jsonl");
    if (billing) writeFileSync(logPath, buildRunBillingLog("run-a", billing).eventsJsonl);
    const measured=spawnSync("pwsh",["-NoProfile","-File",join(scripts,"Measure-SquadLedger.ps1"),"-SquadRoot",dir,"-Format","json",
      ...(billing ? ["-SessionLog", logPath] : [])],{encoding:"utf8",timeout:60000});
    assert.equal(measured.status,0,measured.stderr);
    const output=JSON.parse(measured.stdout);
    return output.unitEconomics;
  } finally { rmSync(dir,{recursive:true,force:true}); }
}

test("genuine upstream FinOps counts a failed review as rejected, not accepted",options,()=>{
  const value=exercise("Fail");
  assert.equal(value.accepted,0);
  assert.equal(value.rejected,1);
  assert.equal(value.estCreditsPerAccepted,null);
  assert.equal(value.hostBilledCreditsPerAccepted,null);
});

function billing(id: string, nano?: number) {
  return attributeCompletion({ eventId: id, attempt: 1, outcome: "completed", backendId: "copilot-sdk",
    usage: copilotUsageFor({ inputTokens: 10, outputTokens: 2,
      ...(nano === undefined ? {} : { copilotUsage: { totalNanoAiu: nano } }) }),
  }, { runId: "run-a", stage: "Squad Coordinator", actor: "Squad Coordinator", recordedAt: "2026-10-11T00:00:00Z" });
}
test("compatible SDK host log supplies aggregate billed credits per accepted value, not the last completion", options, () => {
  const value = exercise("Pass", [billing("a", 1_000_000_000), billing("b", 2_000_000_000)]);
  assert.equal(value.accepted, 1);
  assert.equal(value.hostBilledCreditsPerAccepted, 3);
});
test("genuine projection leaves partial and absent billing unavailable while preserving complete zero", options, () => {
  for (const records of [[], [billing("missing")], [billing("known", 1_000_000_000), billing("missing")]]) {
    assert.equal(exercise("Pass", records).hostBilledCreditsPerAccepted, null);
  }
  assert.equal(exercise("Pass", [billing("zero", 0)]).hostBilledCreditsPerAccepted, 0);
  assert.equal(exercise("Fail", [billing("known", 1_000_000_000)]).hostBilledCreditsPerAccepted, null);
});
test("genuine upstream FinOps counts explicitly reviewed deliverables only",options,()=>{
  const value=exercise("Pass");
  assert.equal(value.accepted,1);
  assert.equal(value.rejected,0);
  assert.equal(value.deliverablesProduced,1,"Upstream value measures exclude review artifacts from produced business deliverables.");
  assert.equal(value.unreviewed,0);
  assert.equal(typeof value.estCreditsPerAccepted,"number");
  assert.equal(value.hostBilledCreditsPerAccepted,null);
});
