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

/** One dispatch's measured consumption. */
export interface ConsumptionRecord {
  role: string;
  agentName: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** One credit is one US cent under Copilot usage-based billing. */
const USD_PER_CREDIT = 0.01;

const BLOCK = /```json consumption\n([\s\S]*?)```/g;

/** Render the per-dispatch block appended to `history/<agent>.md`. */
export function renderConsumptionBlock(record: ConsumptionRecord): string {
  const payload = {
    role: record.role,
    model: record.model,
    input_tokens: record.inputTokens,
    output_tokens: record.outputTokens,
    est_cost_usd: round(record.costUsd, 6),
    est_credits: round(record.costUsd / USD_PER_CREDIT, 4),
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
      records.push({
        role: String(parsed.role ?? "unknown"),
        agentName: String(parsed.agent ?? ""),
        model: String(parsed.model ?? "unknown"),
        inputTokens: Number(parsed.input_tokens ?? 0),
        outputTokens: Number(parsed.output_tokens ?? 0),
        costUsd: Number(parsed.est_cost_usd ?? 0),
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
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
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
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      };
    total.models.add(record.model);
    total.dispatches += 1;
    total.inputTokens += record.inputTokens;
    total.outputTokens += record.outputTokens;
    total.costUsd += record.costUsd;
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
    "so no calibration factor is applied. Costs are the backend's realized figures and",
    "remain estimates of billing, not an invoice.",
    "",
    "## Attribution",
    "",
    "| Role | Model(s) | Dispatches |",
    "|------|----------|------------|",
    ...totals.map((t) => `| ${t.role} | ${[...t.models].sort().join(", ")} | ${t.dispatches} |`),
    "",
    "## Usage & Cost",
    "",
    "| Role | Input tokens | Output tokens | Cost (USD) | Credits |",
    "|------|--------------|---------------|------------|---------|",
    ...totals.map(
      (t) =>
        `| ${t.role} | ${t.inputTokens} | ${t.outputTokens} | ${round(t.costUsd, 4)} | ` +
        `${round(t.costUsd / USD_PER_CREDIT, 2)} |`,
    ),
    `| **total** | ${totals.reduce((s, t) => s + t.inputTokens, 0)} | ` +
      `${totals.reduce((s, t) => s + t.outputTokens, 0)} | ${round(costTotal, 4)} | ` +
      `${round(costTotal / USD_PER_CREDIT, 2)} |`,
    "",
  ];
  return lines.join("\n");
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
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
