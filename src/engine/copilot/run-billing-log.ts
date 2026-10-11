import { createHash } from "node:crypto";
import { aggregateBackendUsage, type CompletionUsageRecord } from "../model-backend.js";

export interface RunBillingSnapshot {
  version: 1;
  runId: string;
  billingStatus: "complete" | "incomplete" | "unavailable";
  completionCount: number;
  billedCompletionCount: number;
  unreportedBillingCompletions: number;
  /** Null unless every represented completion has service-reported billing. */
  hostBilledCredits: number | null;
  knownCreditsSubtotal: number | null;
  sourceSha256: string;
  eventsJsonl: string;
}

/** Only trusted durable completion records may supply this compatibility log. */
export function buildRunBillingLog(runId: string, records: readonly CompletionUsageRecord[]): RunBillingSnapshot {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId) || records.length > 1000) {
    throw new Error("Invalid or oversized run billing snapshot.");
  }
  const unique = new Map<string, CompletionUsageRecord>();
  for (const record of records) {
    if (record.runId !== runId || record.schemaVersion !== 1 || record.backendId !== "copilot-sdk" ||
        typeof record.eventId !== "string" || !record.eventId || !Number.isFinite(Date.parse(record.recordedAt))) {
      throw new Error("Billing record does not belong to this SDK run.");
    }
    const prior = unique.get(record.eventId);
    if (prior && JSON.stringify(prior) !== JSON.stringify(record)) throw new Error("Conflicting duplicate billing event.");
    unique.set(record.eventId, record);
    const usage = record.usage;
    if (usage) {
      for (const key of ["completionCount", "billedCompletionCount", "unreportedBillingCompletions"] as const) {
        if (usage[key] !== undefined && (!Number.isSafeInteger(usage[key]) || usage[key]! < 0)) throw new Error("Invalid billing coverage count.");
      }
      const represented = usage.completionCount ?? 1;
      const billed = usage.billedCompletionCount ?? (usage.hostBilledCredits === undefined ? 0 : represented);
      const missing = usage.unreportedBillingCompletions ?? (usage.hostBilledCredits === undefined ? represented : 0);
      const status = billed > 0 && missing === 0 ? "complete" : billed > 0 ? "incomplete" : "unavailable";
      if (usage.hostBilledCredits !== undefined && (!Number.isFinite(usage.hostBilledCredits) || usage.hostBilledCredits < 0) ||
          billed + missing !== represented || billed > 0 && usage.hostBilledCredits === undefined ||
          billed === 0 && usage.hostBilledCredits !== undefined ||
          usage.billingStatus !== undefined && usage.billingStatus !== status) {
        throw new Error("Billing amount and completeness disagree.");
      }
    }
  }
  const canonical = [...unique.values()].sort((a, b) => a.eventId.localeCompare(b.eventId));
  const usage = aggregateBackendUsage(canonical.map(record => record.usage));
  const completionCount = usage?.completionCount ?? 0;
  const billedCompletionCount = usage?.billedCompletionCount ?? 0;
  // A failed/ambiguous provider attempt with no usage must not certify a total.
  const unreportedBillingCompletions = (usage?.unreportedBillingCompletions ?? completionCount) +
    canonical.filter(record => !record.usage ||
      (record.outcome === "failed" || record.outcome === "ambiguous") && record.usage.completionCount === 0).length;
  const billingStatus = billedCompletionCount > 0 && unreportedBillingCompletions === 0
    ? "complete" : billedCompletionCount > 0 ? "incomplete" : "unavailable";
  const knownCreditsSubtotal = usage?.hostBilledCredits ?? null;
  const hostBilledCredits = billingStatus === "complete" ? knownCreditsSubtotal : null;
  const sourceSha256 = createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
  const timestamp = canonical.map(record => record.recordedAt).sort().at(-1) ?? "1970-01-01T00:00:00.000Z";
  const events: object[] = [{
    type: "session.info", timestamp,
    data: { runId, source: "server-sdk-completion-ledger", sourceSha256, billingStatus,
      completionCount, billedCompletionCount, unreportedBillingCompletions, knownCreditsSubtotal },
  }];
  if (hostBilledCredits !== null) {
    const totalNanoAiu = Math.round(hostBilledCredits * 1_000_000_000);
    if (!Number.isSafeInteger(totalNanoAiu)) throw new Error("Aggregated billing exceeds safe nano-AIU precision.");
    // Squad reads the last checkpoint as cumulative, not a sum of per-call events.
    events.push({ type: "session.usage_checkpoint", timestamp, data: { totalNanoAiu } });
  }
  return { version: 1, runId, billingStatus, completionCount, billedCompletionCount, unreportedBillingCompletions,
    hostBilledCredits, knownCreditsSubtotal, sourceSha256, eventsJsonl: events.map(event => JSON.stringify(event)).join("\n") + "\n" };
}

/** Select only exact server-issued stage/helper heading IDs; never use timestamps as run identity. */
export function selectRunHistory(content: string, entryIds: ReadonlySet<string>): string {
  const headings = [...content.matchAll(/^###[ \t]+\S+[ \t]+([^\r\n]+)\r?$/gm)];
  const selected: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < headings.length; index++) {
    const id = headings[index][1].trim();
    if (!entryIds.has(id)) continue;
    if (seen.has(id)) throw new Error("Duplicate run history heading.");
    seen.add(id);
    selected.push(content.slice(headings[index].index, headings[index + 1]?.index ?? content.length));
  }
  return selected.length ? content.slice(0, headings[0].index) + selected.join("\n") : "";
}
