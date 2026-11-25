import assert from "node:assert/strict";
import { test } from "node:test";
import { copilotUsageFor } from "../src/engine/copilot/copilot-usage.js";
import { aggregateBackendUsage } from "../src/engine/model-backend.js";

test("Copilot service nano-AIU becomes reported credits, never configured USD or a multiplier", () => {
  const usage = copilotUsageFor({
    inputTokens: 100, outputTokens: 20, cacheReadTokens: 70, reasoningTokens: 10,
    cost: 3, copilotUsage: { totalNanoAiu: 1_250_000_000 },
  });
  assert.equal(usage.hostBilledCredits, 1.25);
  assert.equal(usage.billingStatus, "complete");
  assert.equal(usage.estimatedCostUsd, undefined);
  assert.equal(usage.costStatus, "unavailable");
  assert.equal(usage.inputTokens, 100);
  assert.equal(usage.outputTokens, 20);
});

test("missing or invalid billing is unavailable, while a reported zero is measured", () => {
  for (const copilotUsage of [undefined, {}, { totalNanoAiu: -1 }, { totalNanoAiu: NaN }, { totalNanoAiu: "10" }]) {
    const usage = copilotUsageFor({ cost: 3, copilotUsage });
    assert.equal(usage.hostBilledCredits, undefined);
    assert.equal(usage.billingStatus, "unavailable");
    assert.equal(usage.unreportedBillingCompletions, 1);
  }
  assert.equal(copilotUsageFor({ copilotUsage: { totalNanoAiu: 0 } }).hostBilledCredits, 0);
  assert.equal(copilotUsageFor({ copilotUsage: { totalNanoAiu: 0 } }).billingStatus, "complete");
});

test("billing aggregation preserves known subtotals and missing-completion coverage", () => {
  const billed = copilotUsageFor({ inputTokens: 100, outputTokens: 20, copilotUsage: { totalNanoAiu: 1_250_000_000 } });
  const missing = copilotUsageFor({ outputTokens: 5 });
  const total = aggregateBackendUsage([billed, missing])!;
  assert.equal(total.hostBilledCredits, 1.25);
  assert.equal(total.billingStatus, "incomplete");
  assert.equal(total.billedCompletionCount, 1);
  assert.equal(total.unreportedBillingCompletions, 1);
  assert.equal(total.unreportedInputCompletions, 1);
  assert.equal(total.estimatedCostUsd, undefined);
  assert.equal(aggregateBackendUsage([billed, billed])!.hostBilledCredits, 2.5);
  assert.equal(aggregateBackendUsage([billed, billed])!.billingStatus, "complete");
  assert.equal(aggregateBackendUsage([{ inputTokens: 1 }])!.billingStatus, undefined, "non-Copilot behavior unchanged");
});
