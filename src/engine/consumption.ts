/**
 * The consumption ledger, from measured tokens rather than estimates.
 *
 * `squad-state.instructions.md` has the Scribe ESTIMATE cost, because a squad
 * running under GitHub Copilot has no per-dispatch token telemetry — it can only
 * model `internal_turns × average_context` and calibrate against a per-user
 * aggregate after the fact. This server is in a better position: the model
 * backend returns real input and output token counts for every dispatch, so the
 * ledger reports what was actually consumed and marks its basis `measured`.
 *
 * The file REPLACES but its rows ACCUMULATE: each rewrite is derived from every
 * consumption block recorded in `history/*.md` for the project, summed per role.
 * Deriving it from the turn in hand would drop every earlier role while leaving
 * its history entry intact — and the total would still look right, which is what
 * makes that bug expensive to notice.
 */
import { SQUAD_STATE_ROOT, type SquadArtifactStore } from "./artifact-store.js";
import { CONSUMPTION_PATH } from "./squad-ledger.js";

/** One recorded stage's measured completion aggregate. */
export interface ConsumptionRecord {
  role: string;
  agentName: string;
  model: string;
  completionCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  unreportedInputCompletions?: number;
  unreportedOutputCompletions?: number;
  costUsd?: number;
  pricedCompletionCount?: number;
  incompletelyPricedCompletionCount?: number;
  unpricedCompletionCount?: number;
  costStatus?: "complete" | "incomplete" | "unavailable";
}

/** One credit is one US cent under Copilot usage-based billing. */
const USD_PER_CREDIT = 0.01;

const BLOCK = /```json consumption\n([\s\S]*?)```/g;

/** Render the per-stage block appended to `history/<agent>.md`. */
export function renderConsumptionBlock(record: ConsumptionRecord): string {
  const completionCount = record.completionCount ?? 1;
  const costStatus = record.costStatus ??
    (record.costUsd === undefined ? "unavailable" : "complete");
  const payload = {
    role: record.role,
    agent: record.agentName,
    model: record.model,
    completion_count: completionCount,
    ...(record.inputTokens !== undefined ? { input_tokens: record.inputTokens } : {}),
    ...(record.outputTokens !== undefined ? { output_tokens: record.outputTokens } : {}),
    ...(record.reasoningTokens !== undefined ? { reasoning_tokens: record.reasoningTokens } : {}),
    ...(record.cacheReadTokens !== undefined ? { cache_read_tokens: record.cacheReadTokens } : {}),
    ...(record.cacheWriteTokens !== undefined ? { cache_write_tokens: record.cacheWriteTokens } : {}),
    ...((record.unreportedInputCompletions ?? 0) > 0
      ? { unreported_input_completions: record.unreportedInputCompletions }
      : {}),
    ...((record.unreportedOutputCompletions ?? 0) > 0
      ? { unreported_output_completions: record.unreportedOutputCompletions }
      : {}),
    ...(record.costUsd !== undefined
      ? {
          est_cost_usd: round(record.costUsd, 6),
          est_credits: round(record.costUsd / USD_PER_CREDIT, 4),
          currency: "USD",
          cost_basis: "configured_estimate",
        }
      : {}),
    priced_completion_count: record.pricedCompletionCount ??
      (costStatus === "complete" ? completionCount : 0),
    incompletely_priced_completion_count: record.incompletelyPricedCompletionCount ??
      (costStatus === "incomplete" ? completionCount : 0),
    unpriced_completion_count: record.unpricedCompletionCount ??
      (costStatus === "unavailable" ? completionCount : 0),
    cost_status: costStatus,
    basis: "measured",
  };
  return ["#### Consumption", "", "```json consumption", JSON.stringify(payload, null, 2), "```"].join(
    "\n",
  );
}

/** Recover every consumption block from a history file. */
export function parseConsumptionBlocks(markdown: string): ConsumptionRecord[] {
  const records: ConsumptionRecord[] = [];
  for (const match of markdown.matchAll(BLOCK)) {
    try {
      const parsed = JSON.parse(match[1]) as Record<string, unknown>;
      const completionCount = nonNegativeNumber(parsed.completion_count) ?? 1;
      const costUsd = nonNegativeNumber(parsed.est_cost_usd);
      const costStatus = parsed.cost_status === "complete" ||
        parsed.cost_status === "incomplete" ||
        parsed.cost_status === "unavailable"
        ? parsed.cost_status
        : costUsd === undefined ? "unavailable" : "complete";
      records.push({
        role: String(parsed.role ?? "unknown"),
        agentName: String(parsed.agent ?? ""),
        model: String(parsed.model ?? "unknown"),
        completionCount,
        inputTokens: nonNegativeNumber(parsed.input_tokens),
        outputTokens: nonNegativeNumber(parsed.output_tokens),
        reasoningTokens: nonNegativeNumber(parsed.reasoning_tokens),
        cacheReadTokens: nonNegativeNumber(parsed.cache_read_tokens),
        cacheWriteTokens: nonNegativeNumber(parsed.cache_write_tokens),
        unreportedInputCompletions: nonNegativeNumber(parsed.unreported_input_completions) ??
          (parsed.input_tokens === undefined ? completionCount : 0),
        unreportedOutputCompletions: nonNegativeNumber(parsed.unreported_output_completions) ??
          (parsed.output_tokens === undefined ? completionCount : 0),
        costUsd,
        pricedCompletionCount: nonNegativeNumber(parsed.priced_completion_count) ??
          (costStatus === "complete" ? completionCount : 0),
        incompletelyPricedCompletionCount:
          nonNegativeNumber(parsed.incompletely_priced_completion_count) ??
          (costStatus === "incomplete" ? completionCount : 0),
        unpricedCompletionCount: nonNegativeNumber(parsed.unpriced_completion_count) ??
          (costStatus === "unavailable" ? completionCount : 0),
        costStatus,
      });
    } catch {
      // A hand-edited or truncated block contributes nothing rather than
      // poisoning the totals with NaN.
    }
  }
  return records;
}

interface RoleTotal {
  role: string;
  models: Set<string>;
  dispatches: number;
  completions: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  unreportedInputCompletions: number;
  unreportedOutputCompletions: number;
  costUsd: number;
  pricedCompletionCount: number;
  incompletelyPricedCompletionCount: number;
  unpricedCompletionCount: number;
}

/** Sum per role, preserving first-seen order so the ledger mirrors the roster. */
export function summarize(records: readonly ConsumptionRecord[]): RoleTotal[] {
  const byRole = new Map<string, RoleTotal>();
  for (const record of records) {
    const total =
      byRole.get(record.role) ??
      {
        role: record.role,
        models: new Set<string>(),
        dispatches: 0,
        completions: 0,
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        unreportedInputCompletions: 0,
        unreportedOutputCompletions: 0,
        costUsd: 0,
        pricedCompletionCount: 0,
        incompletelyPricedCompletionCount: 0,
        unpricedCompletionCount: 0,
      };
    total.models.add(record.model);
    total.dispatches += 1;
    const completionCount = record.completionCount ?? 1;
    const costStatus = record.costStatus ??
      (record.costUsd === undefined ? "unavailable" : "complete");
    total.completions += completionCount;
    total.inputTokens += record.inputTokens ?? 0;
    total.outputTokens += record.outputTokens ?? 0;
    total.reasoningTokens += record.reasoningTokens ?? 0;
    total.cacheReadTokens += record.cacheReadTokens ?? 0;
    total.cacheWriteTokens += record.cacheWriteTokens ?? 0;
    total.unreportedInputCompletions += record.unreportedInputCompletions ??
      (record.inputTokens === undefined ? completionCount : 0);
    total.unreportedOutputCompletions += record.unreportedOutputCompletions ??
      (record.outputTokens === undefined ? completionCount : 0);
    total.costUsd += record.costUsd ?? 0;
    total.pricedCompletionCount += record.pricedCompletionCount ??
      (costStatus === "complete" ? completionCount : 0);
    total.incompletelyPricedCompletionCount += record.incompletelyPricedCompletionCount ??
      (costStatus === "incomplete" ? completionCount : 0);
    total.unpricedCompletionCount += record.unpricedCompletionCount ??
      (costStatus === "unavailable" ? completionCount : 0);
    byRole.set(record.role, total);
  }
  return [...byRole.values()];
}

/** Render the two role-aligned tables the roster asks for. */
export function renderConsumptionMarkdown(totals: readonly RoleTotal[]): string {
  const costTotal = totals.reduce((sum, t) => sum + t.costUsd, 0);
  const lines = [
    "# Consumption",
    "",
    "Derived from every `#### Consumption` block recorded in `history/*.md` for this",
    "project. Token counts are **measured** by the model backend rather than estimated,",
    "so no calibration factor is applied. Costs use operator-configured USD meter rates,",
    "are explicitly marked incomplete/unavailable when inputs are missing, and are not an invoice.",
    "",
    "## Attribution",
    "",
    "| Role | Model(s) | Stages | Completions |",
    "|------|----------|--------|-------------|",
    ...totals.map((t) => `| ${t.role} | ${[...t.models].sort().join(", ")} | ${t.dispatches} | ${t.completions} |`),
    "",
    "## Usage & Cost",
    "",
    "Reasoning tokens are included in output totals and cache-read tokens are included",
    "in input totals; the detail columns must not be added to those totals.",
    "",
    "| Role | Input tokens | Cache read | Cache write | Output tokens | Reasoning | Cost (USD) | Credits |",
    "|------|--------------|------------|-------------|---------------|-----------|------------|---------|",
    ...totals.map(
      (t) =>
        `| ${t.role} | ${reportedTotal(t.inputTokens, t.unreportedInputCompletions)} | ` +
        `${t.cacheReadTokens} | ${t.cacheWriteTokens} | ` +
        `${reportedTotal(t.outputTokens, t.unreportedOutputCompletions)} | ${t.reasoningTokens} | ` +
        `${reportedCost(t)} | ${reportedCredits(t)} |`,
    ),
    `| **total** | ${reportedTotal(
      totals.reduce((s, t) => s + t.inputTokens, 0),
      totals.reduce((s, t) => s + t.unreportedInputCompletions, 0),
    )} | ${totals.reduce((s, t) => s + t.cacheReadTokens, 0)} | ` +
      `${totals.reduce((s, t) => s + t.cacheWriteTokens, 0)} | ${reportedTotal(
        totals.reduce((s, t) => s + t.outputTokens, 0),
        totals.reduce((s, t) => s + t.unreportedOutputCompletions, 0),
      )} | ${totals.reduce((s, t) => s + t.reasoningTokens, 0)} | ` +
      `${reportedCostSummary(
        costTotal,
        totals.reduce((s, t) => s + t.incompletelyPricedCompletionCount, 0),
        totals.reduce((s, t) => s + t.unpricedCompletionCount, 0),
      )} | ${reportedCreditSummary(
        costTotal,
        totals.reduce((s, t) => s + t.incompletelyPricedCompletionCount, 0),
        totals.reduce((s, t) => s + t.unpricedCompletionCount, 0),
      )} |`,
    "",
  ];
  return lines.join("\n");
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function reportedTotal(value: number, missing: number): string {
  return missing > 0 ? `${value} known; ${missing} unreported` : String(value);
}

function reportedCost(total: RoleTotal): string {
  return reportedCostSummary(
    total.costUsd,
    total.incompletelyPricedCompletionCount,
    total.unpricedCompletionCount,
  );
}

function reportedCredits(total: RoleTotal): string {
  return reportedCreditSummary(
    total.costUsd,
    total.incompletelyPricedCompletionCount,
    total.unpricedCompletionCount,
  );
}

function reportedCostSummary(
  value: number,
  incomplete: number,
  unavailable: number,
): string {
  if (incomplete === 0 && unavailable === 0) {
    return String(round(value, 4));
  }
  if (value === 0 && incomplete === 0) {
    return `unavailable (${unavailable} completions)`;
  }
  return `${round(value, 4)} known; ${incomplete} incomplete, ${unavailable} unavailable`;
}

function reportedCreditSummary(
  value: number,
  incomplete: number,
  unavailable: number,
): string {
  if (incomplete === 0 && unavailable === 0) {
    return String(round(value / USD_PER_CREDIT, 2));
  }
  if (value === 0 && incomplete === 0) {
    return "unavailable";
  }
  return `${round(value / USD_PER_CREDIT, 2)} known`;
}

/**
 * Rebuild `consumption.md` from the project's recorded history.
 *
 * Reads every history file rather than accepting a caller-supplied total, so the
 * ledger cannot disagree with the per-dispatch record it claims to summarize.
 */
export async function rebuildConsumption(
  store: SquadArtifactStore,
  tenantId: string,
  project: string,
): Promise<RoleTotal[]> {
  const entries = await store.list(tenantId, project, `${SQUAD_STATE_ROOT}/history`);
  const records: ConsumptionRecord[] = [];
  for (const entry of entries) {
    if (entry.path.includes("autopilot-run-")) {
      continue; // The run summary references dispatches; it does not record them.
    }
    const file = await store.get(tenantId, project, entry.path);
    if (file) {
      records.push(...parseConsumptionBlocks(file.content));
    }
  }
  const totals = summarize(records);
  await store.put(tenantId, project, CONSUMPTION_PATH, renderConsumptionMarkdown(totals));
  return totals;
}
