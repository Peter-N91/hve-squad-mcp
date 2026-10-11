import { createHash } from "node:crypto";
import type { SquadArtifact, SquadArtifactStore } from "../artifact-store.js";
import type { UpstreamBundle } from "./upstream-bundle.js";
import type { UpstreamHistoryRecord, UpstreamProcedureContext, UpstreamRoutingSelection } from "./upstream-coordinator.js";
import { UpstreamScriptBridgeError, type UpstreamScriptResult } from "./upstream-script-bridge.js";

const ROOT = ".copilot-tracking/squad";
const hash = (content: string) => createHash("sha256").update(content, "utf8").digest("hex");
const line = (content: string) => content.replace(/[\r\n]/g, " ").trim();

interface NativeState {
  schemaVersion: "1.4";
  turn: number;
  updated: string;
  activeRoles: string[];
  openEscalations: string[];
  currentRun: Record<string, unknown> & {
    sessionModel: string;
    costPreflight: Record<string, unknown> & { ceilingUsd: number | null };
  };
  notify: Record<string, unknown>;
}
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
function assertState(value: unknown): asserts value is NativeState {
  const keys = ["schemaVersion", "updated", "turn", "mode", "activeRoles", "openEscalations", "currentRun", "notify"];
  const runKeys = ["sessionModel", "modelOverrides", "estCostUsd", "estCreditsTotal", "costPreflight"];
  const preflightKeys = ["runId", "roundId", "ceilingUsd", "evaluatedSpendUsd", "remainingUsd", "plannedDispatches",
    "projectedCostUsd", "reserveMultiplier", "admissionCostUsd", "confidence", "basis", "decision", "reason"];
  const exact = (record: Record<string, unknown>, fields: string[]) =>
    Object.keys(record).length === fields.length && fields.every(field => Object.hasOwn(record, field));
  const cost = (number: unknown) => typeof number === "number" && Number.isFinite(number) && number >= 0;
  if (!object(value) || !exact(value, keys) || value.schemaVersion !== "1.4" ||
      typeof value.turn !== "number" || !Number.isSafeInteger(value.turn) || value.turn < 0 ||
      typeof value.updated !== "string" || !["interactive", "autopilot", "autonomous"].includes(String(value.mode)) ||
      !Array.isArray(value.activeRoles) || !value.activeRoles.every(role => typeof role === "string") ||
      !Array.isArray(value.openEscalations) || !value.openEscalations.every(entry => typeof entry === "string") ||
      !object(value.notify) || !object(value.currentRun) || !exact(value.currentRun, runKeys) ||
      typeof value.currentRun.sessionModel !== "string" || !object(value.currentRun.modelOverrides) ||
      !cost(value.currentRun.estCostUsd) || !cost(value.currentRun.estCreditsTotal) ||
      !object(value.currentRun.costPreflight) || !exact(value.currentRun.costPreflight, preflightKeys) ||
      !(value.currentRun.costPreflight.ceilingUsd === null ||
        typeof value.currentRun.costPreflight.ceilingUsd === "number" &&
        Number.isFinite(value.currentRun.costPreflight.ceilingUsd) && value.currentRun.costPreflight.ceilingUsd >= 0)) {
    throw new Error("Native Scribe requires the exact upstream schema 1.4 state.");
  }
}

export interface NativeScribeOptions {
  store: SquadArtifactStore;
  tenantId: string;
  project: string;
  routing: UpstreamRoutingSelection;
  roster: readonly { role: string; agent: string }[];
  bundle: UpstreamBundle;
}

async function write(options: NativeScribeOptions, path: string, content: string, baseline: SquadArtifact | undefined,
  committed: string[]): Promise<void> {
  try {
    const result = await options.store.put(options.tenantId, options.project, path, content, baseline?.etag ?? "");
    if (!result.ok) throw new UpstreamScriptBridgeError("native_scribe_conflict",
      "Native Scribe CAS conflicted; committed paths require reconciliation.", [...committed]);
    committed.push(path);
    const stored = await options.store.get(options.tenantId, options.project, path);
    if (!stored || stored.etag !== result.artifact.etag || stored.content !== content) throw new Error("Read-back mismatch.");
  } catch (error) {
    if (error instanceof UpstreamScriptBridgeError) throw error;
    throw new UpstreamScriptBridgeError("native_scribe_conflict",
      "Native Scribe transaction failed; committed and uncertain paths require reconciliation.",
      [...committed], committed.includes(path) ? [] : [path]);
  }
}

/** Read the full pinned references instead of invoking the economy-only compact brief. */
export async function nativeUpstreamDispatchReferences(options: NativeScribeOptions): Promise<UpstreamScriptResult> {
  const paths = ["00-index", "operating-procedure", "gates-and-modes", "model-routing"].map(name =>
    `.github/skills/squad/references/${name}.md`);
  const resources = paths.map(path => {
    const parts: string[] = [];
    let start = 1;
    for (let page = 0; page < 50; page++) {
      const value = options.bundle.read(path, start, 40);
      parts.push(value.content);
      if (!value.truncated) return { path, sha256: value.sha256, content: parts.join("\n") };
      start = value.lastLine + 1;
    }
    throw new Error("Pinned dispatch references exceeded bounded reads.");
  });
  return {
    script: "Get-SquadDispatchBrief", execution: "native-scribe", accounting: "upstream-schema-estimates-only",
    changedPaths: [], output: JSON.stringify({
      operation: "full-dispatch-references", routing: options.routing.mode, economyBriefExecuted: false, resources,
    }),
  };
}

/** Ordinary ranked/manual handoffs retain upstream schema; they never run the economy-only mutator. */
export async function nativeUpstreamHandoff(
  options: NativeScribeOptions, record: UpstreamHistoryRecord | undefined,
  context: UpstreamProcedureContext, orchestration: UpstreamHistoryRecord["consumption"],
  helpers: readonly UpstreamHistoryRecord[],
): Promise<UpstreamScriptResult> {
  const statePath = `${ROOT}/state.json`;
  const stateFile = await options.store.get(options.tenantId, options.project, statePath);
  if (!stateFile) throw new Error("Native Scribe requires genuine upstream state.");
  const state: unknown = JSON.parse(stateFile.content);
  assertState(state);
  const turn = state.turn + 1;
  if (!Number.isSafeInteger(turn)) throw new Error("Native Scribe turn counter exceeds its safe bound.");
  const timestamp = new Date().toISOString();
  const entries = [...(record ? [record] : []), ...helpers];
  const grouped = new Map<string, { agent: string; entries: string[] }>();
  for (const entry of entries) {
    if ((!options.roster.some(role => role.agent === entry.agent) &&
        !["RPI Researcher", "Squad Challenger"].includes(entry.agent)) || entry.stageId.includes("\n") ||
        Object.values(entry.consumption).some(value => typeof value === "number" && (!Number.isFinite(value) || value < 0))) {
      throw new Error("Native Scribe handoff has an unverified agent or invalid usage.");
    }
    const deliverable = await options.store.get(options.tenantId, options.project, entry.deliverable);
    if (!deliverable) throw new Error("Native Scribe history names an unstored deliverable.");
    const path = `${ROOT}/history/${entry.agent.replace(/ /g, "-")}.md`;
    const existing = await options.store.get(options.tenantId, options.project, path);
    if (existing?.content.split(/\r?\n/).some(header => /^###\s+\S+\s+(.+)$/.exec(header)?.[1] === entry.stageId)) {
      throw new Error("Native Scribe history already records this exact stage; replay is refused.");
    }
    const group = grouped.get(path) ?? { agent: entry.agent, entries: [] };
    group.entries.push(`### ${timestamp} ${line(entry.stageId)}\n\n* Turn: ${turn}\n* Request: ${line(entry.request)}\n* Deliverable: ${entry.deliverable}\n* Outcome: ${line(entry.outcome)}\n\n#### Consumption\n\n\`\`\`json\n${JSON.stringify(entry.consumption, null, 2)}\n\`\`\`\n`);
    grouped.set(path, group);
  }
  const scribePath = `${ROOT}/history/Squad-Scribe.md`;
  const scribe = grouped.get(scribePath) ?? { agent: "Squad Scribe", entries: [] };
  scribe.entries.push(`### ${timestamp} ${context.runId}-orchestration-${turn}\n\n* Turn: ${turn}\n* Request: Coordinator usage and native Scribe handoff.\n* Deliverable: ${statePath}\n* Outcome: Native Scribe persisted upstream state/history; no scripted handoff claimed.\n\n#### Consumption — Orchestration\n\n\`\`\`json\n${JSON.stringify(orchestration, null, 2)}\n\`\`\`\n`);
  grouped.set(scribePath, scribe);
  const pending: { path: string; content: string; baseline?: SquadArtifact }[] = [];
  for (const [path, group] of grouped) {
    const baseline = await options.store.get(options.tenantId, options.project, path);
    if (baseline && !baseline.content.includes(`# History: ${group.agent}`)) throw new Error("History has no matching upstream agent header.");
    const prefix = baseline?.content ?? `# History: ${group.agent}\n\n`;
    pending.push({ path, baseline, content: `${prefix}${prefix.endsWith("\n") ? "" : "\n"}\n${group.entries.join("\n")}` });
  }
  state.turn = turn;
  state.updated = timestamp;
  state.activeRoles = [...new Set(context.stages.map(stage => stage.request.role))];
  state.currentRun.sessionModel = context.model;
  pending.push({ path: statePath, baseline: stateFile, content: `${JSON.stringify(state, null, 2)}\n` });
  for (const entry of pending) {
    const current = await options.store.get(options.tenantId, options.project, entry.path);
    if (current?.etag !== entry.baseline?.etag) throw new Error("Native Scribe baseline changed before transaction.");
  }
  const committed: string[] = [];
  for (const entry of pending) await write(options, entry.path, entry.content, entry.baseline, committed);
  return {
    script: "Write-SquadHandoff", execution: "native-scribe", accounting: "upstream-schema-estimates-only",
    changedPaths: committed, output: JSON.stringify({ operation: "native-scribe-handoff", routing: options.routing.mode,
      handoffScriptExecuted: false, atomic: false, turn, histories: entries.map(entry => entry.stageId),
      stateSha256: hash(pending[pending.length - 1].content) }),
  };
}

/** Cost admission without a configured ceiling changes only the closed preflight state via CAS. */
export async function nativeUpstreamNoCeilingPreflight(options: NativeScribeOptions, runId: string): Promise<UpstreamScriptResult> {
  const path = `${ROOT}/state.json`;
  const baseline = await options.store.get(options.tenantId, options.project, path);
  if (!baseline) throw new Error("Native preflight state is missing.");
  const state: unknown = JSON.parse(baseline.content);
  assertState(state);
  if (state.currentRun.costPreflight.ceilingUsd !== null) {
    throw new Error("Native preflight cannot waive a configured cost ceiling.");
  }
  state.currentRun.costPreflight = {
    ...state.currentRun.costPreflight, runId, roundId: `round-${state.turn}`, decision: "not-requested",
    reason: "No cost ceiling configured.",
  };
  const committed: string[] = [];
  const content = `${JSON.stringify(state, null, 2)}\n`;
  if (content !== baseline.content) await write(options, path, content, baseline, committed);
  return { script: "Set-SquadCostPreflight", execution: "native-scribe", accounting: "upstream-schema-estimates-only",
    changedPaths: committed, output: JSON.stringify({ operation: "native-no-ceiling-preflight", runId, stateSha256: hash(content), decisionEntryAdded: false }) };
}
