import type { BackendUsage } from "../model-backend.js";

/** SDK per-request billing is separate from configured USD estimates and session checkpoints. */
export function copilotUsageFor(data: Record<string, unknown>): BackendUsage {
  const count = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
  const inputTokens = count(data.inputTokens);
  const outputTokens = count(data.outputTokens);
  const billing = data.copilotUsage;
  const nanoAiu = billing && typeof billing === "object" && !Array.isArray(billing)
    ? count((billing as Record<string, unknown>).totalNanoAiu) : undefined;
  return {
    inputTokens, outputTokens,
    reasoningTokens: count(data.reasoningTokens),
    cacheReadTokens: count(data.cacheReadTokens),
    cacheWriteTokens: count(data.cacheWriteTokens),
    completionCount: 1, attemptCount: 1,
    unreportedInputCompletions: inputTokens === undefined ? 1 : 0,
    unreportedOutputCompletions: outputTokens === undefined ? 1 : 0,
    pricedCompletionCount: 0, incompletelyPricedCompletionCount: 0, unpricedCompletionCount: 1,
    costStatus: "unavailable",
    ...(nanoAiu !== undefined ? { hostBilledCredits: nanoAiu / 1_000_000_000 } : {}),
    billedCompletionCount: nanoAiu === undefined ? 0 : 1,
    unreportedBillingCompletions: nanoAiu === undefined ? 1 : 0,
    billingStatus: nanoAiu === undefined ? "unavailable" : "complete",
  };
}
