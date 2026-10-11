import assert from "node:assert/strict";
import { test } from "node:test";
import { attributeCompletion, type CompletionUsageRecord } from "../src/engine/model-backend.js";
import { copilotUsageFor } from "../src/engine/copilot/copilot-usage.js";
import { buildRunBillingLog, selectRunHistory } from "../src/engine/copilot/run-billing-log.js";

function record(id: string, nano?: number): CompletionUsageRecord {
  return attributeCompletion({ eventId: id, attempt: 1, outcome: "completed", backendId: "copilot-sdk",
    usage: copilotUsageFor({ inputTokens: 10, outputTokens: 2,
      ...(nano === undefined ? {} : { copilotUsage: { totalNanoAiu: nano } }) }),
  }, { runId: "run-a", stage: "Squad Coordinator", actor: "Squad Coordinator", recordedAt: "2026-10-11T00:00:00Z" });
}
test("run billing aggregates per-completion charges into one cumulative checkpoint", () => {
  const first = record("a", 1_000_000_000), second = record("b", 2_000_000_000);
  const log = buildRunBillingLog("run-a", [second, first, first]);
  const events = log.eventsJsonl.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(log.hostBilledCredits, 3);
  assert.equal(log.completionCount, 2);
  assert.equal(events.filter(event => event.type === "session.usage_checkpoint").length, 1);
  assert.equal(events.at(-1).data.totalNanoAiu, 3_000_000_000);
  assert.equal(buildRunBillingLog("run-a", [first, second]).sourceSha256, log.sourceSha256);
});
test("partial, absent and ambiguous billing never produce a numeric checkpoint; complete zero does", () => {
  for (const records of [[], [record("missing")], [record("known", 1_000_000_000), record("missing")],
    [record("known", 1_000_000_000), { ...record("unknown"), usage: undefined, outcome: "ambiguous" as const }]]) {
    const log = buildRunBillingLog("run-a", records);
    assert.equal(log.hostBilledCredits, null);
    assert.ok(!log.eventsJsonl.includes("session.usage_checkpoint"));
  }
  const partial = buildRunBillingLog("run-a", [record("known", 1_000_000_000), record("missing")]);
  assert.equal(partial.billingStatus, "incomplete");
  assert.equal(partial.knownCreditsSubtotal, 1);
  assert.equal(partial.unreportedBillingCompletions, 1);
  const zero = buildRunBillingLog("run-a", [record("zero", 0)]);
  assert.equal(zero.billingStatus, "complete");
  assert.equal(zero.hostBilledCredits, 0);
  assert.ok(zero.eventsJsonl.includes('"totalNanoAiu":0'));
});
test("wrong run, non-SDK records, conflicting events and inconsistent billing fail explicitly", () => {
  const known = record("a", 1);
  for (const records of [
    [{ ...known, runId: "other-run" }],
    [{ ...known, backendId: "other-provider" }],
    [known, { ...known, usage: copilotUsageFor({ copilotUsage: { totalNanoAiu: 2 } }) }],
    [{ ...known, usage: { ...known.usage, hostBilledCredits: NaN } }],
    [{ ...known, usage: { ...known.usage, unreportedBillingCompletions: 1 } }],
    [{ ...known, usage: { ...known.usage, billingStatus: "unavailable" as const } }],
  ]) assert.throws(() => buildRunBillingLog("run-a", records));
});
test("history scope is exact heading ID, not a timestamp, substring or request mention", () => {
  const content = "# History\n\n### 2026-10-11T00:00:00Z prior-stage\n\n* Request: current-stage\n\n" +
    "### 2026-10-11T00:00:00Z current-stage\n\n* Deliverable: docs/report.md\n\n" +
    "### 2026-10-11T00:00:00Z current-stage-extra\n\n* Deliverable: docs/other.md\n";
  const scoped = selectRunHistory(content, new Set(["current-stage"]));
  assert.ok(scoped.includes("docs/report.md"));
  assert.ok(!scoped.includes("prior-stage"));
  assert.ok(!scoped.includes("docs/other.md"));
  assert.throws(() => selectRunHistory(content + "\n### 2026-10-11T00:00:00Z current-stage\n", new Set(["current-stage"])));
});
