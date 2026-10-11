import { createHash, randomUUID } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { assertSafeArtifactPath, type SquadArtifactStore } from "../artifact-store.js";
import { aggregateBackendUsage, type BackendResult, type BackendUsage } from "../model-backend.js";
import { parseTables } from "../markdown-table.js";
import { StageInputRequired } from "../research-runtime.js";
import {
  type CopilotClientPort, type CopilotSessionConfig, type CopilotSessionPort,
  type CopilotToolDefinition, type CopilotToolResult,
} from "./copilot-stage-executor.js";
import { type EconomyPick } from "./economy-routing.js";
import { copilotUsageFor } from "./copilot-usage.js";
import type { WriteScope, SessionFsProviderPort } from "./project-filesystem.js";
import type { UpstreamBundle } from "./upstream-bundle.js";
import {
  UPSTREAM_SCRIPT_PIN, type UpstreamAllowedWritePolicy, type UpstreamScriptName,
  type UpstreamScriptRequest, type UpstreamScriptResult,
} from "./upstream-script-bridge.js";

const SKILL = ".github/skills/squad/";
const CHARTER = ".github/agents/squad/squad-coordinator.agent.md";
const PROCEDURES: readonly UpstreamScriptName[] = [
  "Initialize-SquadConsumptionRates", "Resolve-SquadModelRoute", "Get-SquadDispatchBrief",
  "Measure-SquadLedger", "Write-SquadHandoff", "Set-SquadCostPreflight",
];
export const UPSTREAM_COORDINATOR_TOOLS = [
  "list_upstream_resources", "read_upstream_resource", "list_project_files", "read_project_file",
  "delegate_role_stage", "invoke_upstream_procedure", "request_human_input", "finish_upstream_run",
] as const;

export interface UpstreamRosterRole {
  role: string;
  agent: string;
  charterPath: string;
  floor: "fast" | "default" | "extended";
  /** Server-granted scope, not a scope proposed by the coordinator. */
  writeScope: WriteScope;
}
export interface UpstreamReceipt { path: string; sha256: string }
export interface UpstreamStageRequest {
  stageId: string;
  role: string;
  agent: string;
  charterPath: string;
  task: string;
  purpose: "work" | "review" | "correction" | "initialization";
  round: number;
  model: string;
  rankedModel: string;
  routeRationale: string;
  writeScope: WriteScope;
  /** Children must not inherit a generic task/shell/cloud tool blanket. */
  allowNestedDelegation: false;
  reviewsStageId?: string;
  correctsStageId?: string;
  signal: AbortSignal;
  deadlineAt: number;
  maxModelCalls: number;
}
export interface UpstreamStageResult {
  result: BackendResult;
  artifacts: UpstreamReceipt[];
  /** Trusted server-only exact plan-marker updates, never model-selected write expansion. */
  retainedUpdates?: UpstreamReceipt[];
}
export interface UpstreamHistoryRecord {
  stageId: string;
  role: string;
  agent: string;
  turn: number;
  request: string;
  deliverable: string;
  outcome: string;
  timestamp: string;
  upstreamHistoryPath: string;
  historyEntry: string;
  consumption: {
    model: string;
    model_source: "dispatch-reported" | "operator-declared";
    priced_as: string;
    model_tier: UpstreamRosterRole["floor"];
    internal_turns: number;
    input_tokens: number;
    cached_tokens: number;
    cache_write_tokens: number;
    output_tokens: number;
    basis: "estimated" | "tier-default";
  };
  /** Raw observed usage remains separate from upstream schema estimates. Never an invoice. */
  observedUsage?: BackendUsage;
}
export interface UpstreamCompletedStage {
  request: Omit<UpstreamStageRequest, "signal">;
  result: BackendResult;
  artifacts: UpstreamReceipt[];
  history?: UpstreamReceipt;
  retainedUpdates?: UpstreamReceipt[];
}
export interface UpstreamReviewVerification {
  verdict: "Pass" | "Conditional Pass" | "Fail";
  reviewerStageId: string;
  ownerStageId: string;
  /** Hashes actually read by the independent reviewer, not the model's claims. */
  readHashes: UpstreamReceipt[];
  reviewReceipt: UpstreamReceipt;
  findings: string[];
  highestSeverity?: "Critical" | "High" | "Medium" | "Low" | "None";
  /** Trusted admission state: findings-only is allowed without an approved actionable pipeline. */
  approvedActionablePipeline: boolean;
}
export interface UpstreamCoordinatorEvent {
  type: string;
  stageId?: string;
  role?: string;
  agent?: string;
  procedure?: UpstreamScriptName;
  execution?: UpstreamScriptResult["execution"];
  model?: string;
  round?: number;
  verdict?: string;
}
export interface UpstreamProcedureContext {
  runId: string;
  project: string;
  model: string;
  availableModels: readonly string[];
  stages: readonly UpstreamCompletedStage[];
  signal: AbortSignal;
}
export interface UpstreamCoordinatorCheckpoint {
  version: 1;
  sessionId: string;
  stages: UpstreamCompletedStage[];
  events: UpstreamCoordinatorEvent[];
  counters: { calls: number; procedures: number; toolCalls: number; coordinatorCompletions: number };
  coordinatorUsage: BackendUsage[];
  procedures: [UpstreamScriptName, UpstreamScriptResult][];
  measuredStageCount: number;
  failedReview?: { owner: string; reviewer: string; corrected?: string; rereviewed?: string };
  pendingTool?: { name: string; args: unknown };
  pendingStage?: Omit<UpstreamStageRequest, "signal">;
  pendingStageObservedAttempts?: number;
  pendingStageRetainedUpdates?: UpstreamReceipt[];
  completedDelegations: [string, unknown][];
}
export interface UpstreamCoordinatorOptions {
  client: CopilotClientPort;
  bundle: UpstreamBundle;
  store: SquadArtifactStore;
  tenantId: string;
  project: string;
  runId: string;
  /** The parent chooses this module only for a new project. Native/existing projects are refused. */
  projectKind: "new";
  economyConsent?: true;
  routingConsent?: true;
  routing?: UpstreamRoutingSelection;
  rosterConfirmed: true;
  roster: readonly UpstreamRosterRole[];
  coordinatorModel: string;
  availableModels: readonly string[];
  stageRunner: (request: UpstreamStageRequest) => Promise<UpstreamStageResult>;
  /** Bind to UpstreamScriptBridge.runScript. No model argument is passed to this callback. */
  procedureRunner: (
    request: UpstreamScriptRequest, policy: UpstreamAllowedWritePolicy | undefined,
    context: UpstreamProcedureContext,
  ) => Promise<UpstreamScriptResult>;
  /** Builds arguments and exact write policy from server state, never from model commands. */
  prepareProcedure: (
    name: UpstreamScriptName, context: UpstreamProcedureContext,
  ) => Promise<{ request: UpstreamScriptRequest; policy?: UpstreamAllowedWritePolicy }>;
  persistStage: (record: UpstreamHistoryRecord, context: UpstreamProcedureContext) => Promise<UpstreamReceipt>;
  verifyFinish: (reports: readonly UpstreamReceipt[], context: UpstreamProcedureContext) => Promise<UpstreamReviewVerification>;
  /** Must halt by throwing StageInputRequired (or a compatible error); never return synthetic consent. */
  requestHumanInput: (request: { question: string; reason: string }, context: UpstreamProcedureContext) => Promise<never>;
  gitHubToken?: CopilotSessionConfig["gitHubToken"];
  gitHubTokenProvider?: CopilotSessionConfig["gitHubTokenProvider"];
  signal?: AbortSignal;
  deadlineMs?: number;
  maxModelCalls?: number;
  maxProcedureCalls?: number;
  maxStages?: number;
  maxToolCalls?: number;
  onEvent?: (event: UpstreamCoordinatorEvent) => void;
  onCoordinatorUsage?: (usage: BackendUsage, reportedModel?: string, eventId?: string) => void;
  continuation?: {
    checkpoint: UpstreamCoordinatorCheckpoint;
    answer: { question: string; reason: string; answer: string; respondedBy: string; responseId: string };
  };
  /** Prompt-free server snapshot; runtime persists this only through its held-run seam. */
  onState?: (checkpoint: UpstreamCoordinatorCheckpoint) => void;
}
export interface UpstreamCoordinatorResult extends BackendResult {
  stages: UpstreamCompletedStage[];
  metadata: {
    upstreamCommit: string;
    upstreamVersion: string;
    rolloutVersion: "0.19.0-pre";
    routing: "ranked" | "economy" | "manual";
    outcome: "accepted" | "findings";
    gaps: string[];
    reports: UpstreamReceipt[];
    verification: UpstreamReviewVerification;
    events: UpstreamCoordinatorEvent[];
    productionSmokeVerified: false;
    coreHelpers?: { parentStageId: string; agent: string; path: string; sha256: string; model: string; readHashes: { path: string; sha256: string }[] }[];
  };
}
export class UpstreamCoordinatorError extends Error {
  constructor(message: string, readonly stages: readonly UpstreamCompletedStage[], readonly events: readonly UpstreamCoordinatorEvent[], cause?: unknown) {
    super(message, { cause });
    this.name = "UpstreamCoordinatorError";
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function closed(value: unknown, fields: readonly string[], required = fields): Record<string, unknown> {
  if (!object(value) || Object.keys(value).some(key => !fields.includes(key)) || required.some(key => !Object.hasOwn(value, key))) {
    throw new Error("Unknown or missing structured tool fields.");
  }
  return value;
}
function text(value: unknown, max = 8000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) throw new Error("Expected bounded nonempty text.");
  return value;
}
function path(value: unknown): string {
  const result = text(value, 500);
  assertSafeArtifactPath(result);
  if (!/\.(md|json|txt|csv|ya?ml|dot)$/i.test(result) ||
      /(?:^|\/)(?:\.env|credentials?|secrets?|tokens?|id_rsa)(?:[./_-]|$)/i.test(result)) throw new Error("Project access is limited to safe text artifacts.");
  return result;
}
function hash(content: string): string { return createHash("sha256").update(content, "utf8").digest("hex"); }
function receipt(value: UpstreamReceipt): UpstreamReceipt {
  const p = path(value.path);
  if (!/^[a-f0-9]{64}$/.test(value.sha256)) throw new Error("Invalid stored artifact hash.");
  return { path: p, sha256: value.sha256 };
}
function inputRequired(error: unknown): boolean {
  return error instanceof StageInputRequired || (error instanceof Error && error.name === "StageInputRequired" && "input" in error && "checkpoint" in error);
}
function schema(properties: Record<string, unknown>, required = Object.keys(properties)): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}
const stringSchema = { type: "string", minLength: 1, maxLength: 8000 };

export type UpstreamRoutingSelection =
  | { mode: "ranked" | "economy" }
  | { mode: "manual"; model: string };

export class UpstreamModelUnavailableError extends Error {}

export function parseUpstreamRouting(value: unknown): UpstreamRoutingSelection {
  if (!object(value) || !["ranked", "economy", "manual"].includes(String(value.mode)) ||
      Object.keys(value).some(key => key !== "mode" && key !== "model")) {
    throw new Error("Routing must explicitly select ranked, economy or manual.");
  }
  if (value.mode === "manual") {
    if (typeof value.model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(value.model)) {
      throw new Error("Manual routing requires an exact verified model ID.");
    }
    return { mode: "manual", model: value.model };
  }
  if (value.model !== undefined) throw new Error("Only manual routing accepts a fixed model.");
  return { mode: value.mode as "ranked" | "economy" };
}

/** Same pinned ranking/floor rules, but fed only integrity-checked, bounded bundle reads. */
export function selectUpstreamEconomyRoute(catalogText: string, routingText: string, role: string,
  floor: UpstreamRosterRole["floor"], available: readonly string[],
  selection: UpstreamRoutingSelection = { mode: "economy" }): EconomyPick {
  const clean = (s: string) => s.replace(/`/g, "").trim();
  const catalog = parseTables(catalogText), routing = parseTables(routingText);
  const assignment = routing.find(t => t.headers[0] === "Class" && t.headers.includes("Roles"));
  const key = role.replace(/^council-/, "");
  const cls = role.startsWith("council-") ? "council" : clean(assignment?.rows.find(row =>
    row[1].split(",").some(cell => clean(cell) === key))?.[0] ?? "implementation");
  const classes = new Map<string, string>();
  for (const table of catalog) {
    const index = table.headers.indexOf("Capability class");
    if (table.headers[0] === "Catalog ID" && index >= 0) for (const row of table.rows) classes.set(clean(row[0]), clean(row[index]));
  }
  const fits = catalog.find(t => t.headers[0] === "Catalog ID" && t.headers.includes("Blended"));
  if (!assignment || !fits || fits.headers.indexOf(cls) < 0) throw new Error("Pinned upstream model routing tables are invalid.");
  const admitted = floor === "fast" ? ["fast-lightweight", "balanced", "code-specialized"] :
    floor === "extended" ? ["frontier-reasoning"] : floor === "default" ? ["balanced", "code-specialized", "frontier-reasoning"] : [];
  if (selection.mode === "manual" && floor === "fast") admitted.push("frontier-reasoning");
  const candidates = fits.rows.map((row, order) => ({
    id: clean(row[0]), family: clean(row[1]), generation: Number(row[2]), fit: Number(row[fits.headers.indexOf(cls)]),
    cost: Number(row[fits.headers.indexOf("Blended")]), order,
  })).filter(row => available.includes(row.id) && admitted.includes(classes.get(row.id) ?? "") &&
    row.fit >= (selection.mode === "manual" ? 0 : 1) && Number.isFinite(row.cost));
  const tie = (a: typeof candidates[number], b: typeof candidates[number]) => (a.family === b.family ? b.generation - a.generation : 0) || a.order - b.order;
  const ranked = [...candidates].sort((a, b) => b.fit - a.fit || a.cost - b.cost || tie(a, b))[0];
  if (!ranked) throw new UpstreamModelUnavailableError(`No verified available ${selection.mode} model at floor ${floor} for ${role}.`);
  if (selection.mode === "manual") {
    const fixed = candidates.find(candidate => candidate.id === selection.model);
    if (!fixed) throw new UpstreamModelUnavailableError(`Manual model ${selection.model} is unavailable or cannot meet floor ${floor} for ${role}.`);
    return { role, floor, model: fixed.id, rankedModel: fixed.id, rationale: `Route: manual; fixed model; class=${cls}` };
  }
  const economical = selection.mode === "economy" &&
    ["developer", "technical-writer", "presenter", "prompt-engineer", "data-scientist"].includes(key) && cls === "implementation"
    ? candidates.filter(c => c.fit >= 2).sort((a, b) => a.cost - b.cost || b.fit - a.fit || tie(a, b))[0] : undefined;
  return { role, floor, model: (economical ?? ranked).id, rankedModel: ranked.id,
    rationale: `Route: ${selection.mode}; ${economical ? "economy pick" : "ranked pick (protected role)"}; class=${cls}` };
}

/**
 * An opt-in orchestration seam, not a second native pipeline. The immutable upstream
 * Coordinator chooses roles/order; server callbacks retain storage, approval and script authority.
 * Creating this class does not wire production credentials, admission, persistence or worker runtime.
 */
export class UpstreamCoordinator {
  constructor(private readonly options: UpstreamCoordinatorOptions) {
    if (options.projectKind !== "new" || !(options.routingConsent === true ||
        (!options.routing && options.economyConsent === true)) || options.rosterConfirmed !== true) {
      throw new Error("Full upstream orchestration requires a new project, confirmed roster and explicitly accepted routing.");
    }
    if (options.routing) parseUpstreamRouting(options.routing);
    for (const name of ["stageRunner", "procedureRunner", "prepareProcedure", "persistStage", "verifyFinish", "requestHumanInput"] as const) {
      if (typeof options[name] !== "function") throw new Error(`Missing trusted upstream seam: ${name}`);
    }
    if (!options.availableModels.includes(options.coordinatorModel)) throw new Error("Coordinator model is not verified available.");
    if (options.bundle.identity.sourceCommit !== UPSTREAM_SCRIPT_PIN || options.bundle.identity.files.length !== 1682 || options.bundle.skills().length !== 97) {
      throw new Error("Full upstream orchestration requires the complete 97-skill, 1682-file a8d863a bundle.");
    }
    for (const [name, fallback, ceiling] of [
      ["deadlineMs", 120000, 2100000], ["maxModelCalls", 24, 100], ["maxProcedureCalls", 24, 100],
      ["maxStages", 24, 100], ["maxToolCalls", 256, 1000],
    ] as const) {
      const value = options[name] ?? fallback;
      if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) throw new Error(`Invalid ${name} bound.`);
    }
  }

  async run(prompt: string): Promise<UpstreamCoordinatorResult> {
    text(prompt, 32000);
    const o = this.options;
    const restored = o.continuation?.checkpoint;
    const stages: UpstreamCompletedStage[] = structuredClone(restored?.stages ?? []);
    const events: UpstreamCoordinatorEvent[] = structuredClone(restored?.events ?? []);
    const emit = (event: UpstreamCoordinatorEvent) => { events.push(event); o.onEvent?.(event); };
    const controller = new AbortController();
    const deadlineAt = Date.now() + (o.deadlineMs ?? 120000);
    const maximumCalls = o.maxModelCalls ?? 24;
    let calls = restored ? restored.counters.calls + 1 : 1, procedures = restored?.counters.procedures ?? 0,
      toolCalls = restored?.counters.toolCalls ?? 0, busy = false, stopped = false;
    let coordinatorCompletions = restored?.counters.coordinatorCompletions ?? 0;
    let sessionCompletions = 0;
    const coordinatorUsage: BackendUsage[] = structuredClone(restored?.coordinatorUsage ?? []);
    let fatal: unknown;
    let session: CopilotSessionPort | undefined;
    let finished: UpstreamCoordinatorResult | undefined;
    let restoredAnswerServed = false;
    let failedReview: { owner: UpstreamCompletedStage; reviewer: UpstreamCompletedStage; corrected?: UpstreamCompletedStage; rereviewed?: UpstreamCompletedStage } | undefined;
    const procedureResults = new Map<UpstreamScriptName, UpstreamScriptResult>(restored?.procedures ?? []);
    let measuredStageCount = restored?.measuredStageCount ?? -1;
    let pendingTool: UpstreamCoordinatorCheckpoint["pendingTool"];
    let pendingStage: UpstreamCoordinatorCheckpoint["pendingStage"];
    let resumePendingStage = restored?.pendingStage;
    const completedDelegations = new Map<string, unknown>(restored?.completedDelegations ?? []);
    const sessionId = restored?.sessionId ?? `upstream-${o.runId}-${randomUUID()}`;
    const operationKey = (value: unknown): string => {
      const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : object(v)
        ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
      return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
    };
    const snapshot = () => o.onState?.(structuredClone({
      version: 1, sessionId, stages, events,
      counters: { calls, procedures, toolCalls, coordinatorCompletions }, coordinatorUsage,
      procedures: [...procedureResults], measuredStageCount,
      ...(failedReview ? { failedReview: { owner: failedReview.owner.request.stageId, reviewer: failedReview.reviewer.request.stageId,
        corrected: failedReview.corrected?.request.stageId, rereviewed: failedReview.rereviewed?.request.stageId } } : {}),
      pendingTool, pendingStage, completedDelegations: [...completedDelegations],
    } satisfies UpstreamCoordinatorCheckpoint));
    const context = (): UpstreamProcedureContext => ({
      runId: o.runId, project: o.project, model: o.coordinatorModel,
      availableModels: [...o.availableModels], stages: structuredClone(stages), signal: controller.signal,
    });
    const check = () => {
      if (stopped || controller.signal.aborted || Date.now() >= deadlineAt) throw new Error("Upstream run cancelled or deadline exhausted.");
      if (calls > maximumCalls) throw new Error("Upstream cumulative model-call budget exhausted.");
      if (fatal) throw fatal;
    };
    const setFatal = (error: unknown) => {
      fatal ??= error;
      controller.abort(error);
      void session?.abort().catch(() => undefined);
    };
    const cancel = () => setFatal(o.signal?.reason ?? new Error("Upstream run cancelled."));
    o.signal?.addEventListener("abort", cancel, { once: true });
    if (o.signal?.aborted) cancel();
    const readResource = (resource: string): string => {
      const chunks: string[] = [];
      let start = 1, expectedHash: string | undefined, characters = 0;
      for (let window = 0; window < 40; window++) {
        const part = o.bundle.read(resource, start, 40);
        if (expectedHash && expectedHash !== part.sha256) throw new Error("Upstream contract changed during bounded reads.");
        expectedHash = part.sha256;
        characters += part.content.length;
        if (characters > 256000) throw new Error("Coordinator contract exceeds its bounded resource budget.");
        chunks.push(part.content);
        if (!part.truncated) return chunks.join("\n");
        start = part.lastLine + 1;
      }
      throw new Error("Coordinator contract exceeds its bounded resource windows.");
    };
    const verified = async (raw: UpstreamReceipt): Promise<UpstreamReceipt> => {
      const r = receipt(raw);
      const stored = await o.store.get(o.tenantId, o.project, r.path);
      if (!stored || hash(stored.content) !== r.sha256) throw new Error(`Missing or changed stored artifact: ${r.path}`);
      return r;
    };
    const within = (p: string, scope: WriteScope) => scope.exactPaths.includes(p) || scope.prefixes.some(prefix => p.startsWith(prefix));
    const roster = new Map<string, UpstreamRosterRole>();
    const picks = new Map<string, EconomyPick>();
    try {
      check();
      if (restored) {
        if (restored.version !== 1 || !o.client.resumeSession || !/^upstream-[A-Za-z0-9._:-]+$/.test(sessionId)) throw new Error("Coordinator continuation has no safe SDK resume port/session identity.");
        if (Object.values(restored.counters).some(n => !Number.isSafeInteger(n) || n < 0) ||
            !Number.isInteger(restored.measuredStageCount) || restored.measuredStageCount < -1 || restored.measuredStageCount > stages.length) throw new Error("Coordinator continuation counters are invalid.");
        const latestArtifacts = new Map(stages.flatMap(stage => [...stage.artifacts, ...(stage.retainedUpdates ?? [])].map(a => [a.path, a] as const)));
        for (const update of restored.pendingStageRetainedUpdates ?? []) {
          if (restored.pendingStage?.role !== "developer" || !stages.some(s => s.request.role === "lead" && s.artifacts.some(a => a.path === update.path))) throw new Error("Pending plan-marker update is not an assigned Lead artifact.");
          latestArtifacts.set(update.path, update);
        }
        for (const artifact of latestArtifacts.values()) await verified(artifact);
        for (const stage of stages) {
          if (!stage.history) throw new Error("Continuation contains an uncommitted completed stage.");
          const history = await o.store.get(o.tenantId, o.project, stage.history.path);
          if (!history?.content.includes(stage.request.stageId)) throw new Error("Continuation dispatch history was removed or changed.");
        }
        if (restored.failedReview) {
          const find = (id: string) => { const stage = stages.find(s => s.request.stageId === id); if (!stage) throw new Error("Continuation review state is inconsistent."); return stage; };
          failedReview = { owner: find(restored.failedReview.owner), reviewer: find(restored.failedReview.reviewer),
            ...(restored.failedReview.corrected ? { corrected: find(restored.failedReview.corrected) } : {}),
            ...(restored.failedReview.rereviewed ? { rereviewed: find(restored.failedReview.rereviewed) } : {}) };
        }
      }
      const charter = readResource(CHARTER);
      const charterMetadata = parseYaml(/^---\r?\n([\s\S]*?)\r?\n---/.exec(charter)?.[1] ?? "") as { agents?: unknown };
      const cast = parseTables(readResource(SKILL + "references/roster-catalog.md"));
      const roles = cast.find(table => table.headers[0] === "Role" && table.headers[1].startsWith("Primary Agent"));
      for (const raw of o.roster) {
        const binding = structuredClone(raw);
        const row = roles?.rows.find(row => row[0].trim() === binding.role);
        const allowedAgents = row ? [row[1].trim(), ...row[2].split(",").map(a => a.trim())] : [];
        if (roster.has(binding.role) || !allowedAgents.includes(binding.agent) ||
            !Array.isArray(charterMetadata.agents) || !charterMetadata.agents.includes(binding.agent)) throw new Error("Unmapped or duplicate confirmed roster role.");
        if (!binding.charterPath.startsWith(".github/agents/") || !binding.charterPath.endsWith(".agent.md")) throw new Error("Invalid deployed charter resource.");
        const agentCharter = readResource(binding.charterPath);
        const frontmatter = parseYaml(/^---\r?\n([\s\S]*?)\r?\n---/.exec(agentCharter)?.[1] ?? "") as { name?: unknown; "disable-model-invocation"?: unknown };
        if (frontmatter.name !== binding.agent || frontmatter["disable-model-invocation"] === true) throw new Error("Roster agent is not dispatchable.");
        for (const p of binding.writeScope.exactPaths) path(p);
        for (const prefix of binding.writeScope.prefixes) {
          if (!prefix.endsWith("/")) throw new Error("Write prefixes require a canonical directory boundary.");
          path(prefix + "scope.md");
        }
        roster.set(binding.role, binding);
      }
      const catalogText = readResource(SKILL + "references/model-catalog.md");
      const routingText = readResource(SKILL + "references/model-routing.md");
      readResource(SKILL + "references/entry-schemas.md");
      for (const binding of roster.values()) {
        picks.set(binding.role, selectUpstreamEconomyRoute(catalogText, routingText, binding.role, binding.floor, o.availableModels, o.routing));
      }
      const contractPaths = [
        CHARTER, SKILL + "SKILL.md", ...["00-index", "profiles-and-packs", "operating-procedure", "gates-and-modes",
          "model-routing", "model-catalog", "economy-mode", "scribe-payload-template"].map(name => SKILL + `references/${name}.md`),
        ".github/instructions/squad/squad-floor.instructions.md",
      ];
      const contract = contractPaths.map(p => `\nResource: ${p}\n${readResource(p)}`).join("\n") +
        "\nServer Scribe adapter: The rate seeder, compact dispatch brief, scripted handoff and cost-preflight mutator are economy-only. Ranked/manual Init copies the pinned cold rate template and validates it with a genuine read-only ledger measurement. Those modes read full dispatch references and use native Scribe/history/state CAS transactions with explicit provenance; the logical operation names do not imply that the refused scripts ran. The adapter never changes routing to economy, resets calibration, or claims a refused script executed.";
      const tools: CopilotToolDefinition[] = [];
      const register = (name: typeof UPSTREAM_COORDINATOR_TOOLS[number], parameters: Record<string, unknown>,
        action: (args: unknown) => Promise<unknown>, mutation = false, terminal = false) => {
        tools.push({
          name, description: name === "finish_upstream_run"
            ? "Finish after final ledger reconciliation and independent review. reportPaths contains ONLY canonical paths returned in the CURRENT owner's artifacts receipts. Never include review artifacts, temporary executor paths or prior-run outputs. Owner finish_stage complete/ready plus persisted handoff is sufficient; acceptance comes from the independent review, not a new owner status."
            : `Server-controlled ${name}; only the supplied closed schema is accepted.`,
          parameters, skipPermission: true, ...(terminal ? { isTerminal: true } : {}),
          handler: async (args): Promise<CopilotToolResult> => {
            try {
              if (finished) throw new Error("Upstream run already finished; further tools are refused.");
              check();
              if (++toolCalls > (o.maxToolCalls ?? 256)) { setFatal(new Error("Upstream tool-call budget exhausted.")); check(); }
              if (mutation && busy) throw new Error("Concurrent orchestration mutations are refused.");
              if (mutation) busy = true;
              if (mutation) { pendingTool = { name, args: structuredClone(args) }; snapshot(); }
              try {
                const key = operationKey(args);
                if (name === "delegate_role_stage" && completedDelegations.has(key)) {
                  pendingTool = undefined; snapshot();
                  return { resultType: "success", textResultForLlm: JSON.stringify(completedDelegations.get(key)) };
                }
                const result = await action(args);
                if (name === "delegate_role_stage") completedDelegations.set(key, structuredClone(result));
                if (mutation) { pendingTool = undefined; pendingStage = undefined; }
                snapshot();
                check();
                return { resultType: "success", textResultForLlm: JSON.stringify(result) };
              } finally { if (mutation) busy = false; }
            } catch (error) {
              if (inputRequired(error)) setFatal(error);
              emit({ type: `tool.failed:${name}` });
              return { resultType: "failure", textResultForLlm: error instanceof Error ? error.message : "Upstream tool failed." };
            }
          },
        });
      };
      register("list_upstream_resources", schema({ prefix: { type: "string", maxLength: 500 }, offset: { type: "integer", minimum: 0 } }, []), async raw => {
        const a = closed(raw, ["prefix", "offset"], []);
        const prefix = a.prefix === undefined ? "" : text(a.prefix, 500);
        const offset = a.offset ?? 0;
        if (!Number.isSafeInteger(offset) || Number(offset) < 0) throw new Error("Invalid list offset.");
        const paths = o.bundle.paths(prefix);
        return { paths: paths.slice(Number(offset), Number(offset) + 100), total: paths.length, nextOffset: Number(offset) + 100 < paths.length ? Number(offset) + 100 : null };
      });
      register("read_upstream_resource", schema({ path: stringSchema, start: { type: "integer", minimum: 1 }, maxLines: { type: "integer", minimum: 1, maximum: 400 } }, ["path"]), async raw => {
        const a = closed(raw, ["path", "start", "maxLines"], ["path"]);
        const resource = text(a.path, 500);
        if ((a.start !== undefined && typeof a.start !== "number") || (a.maxLines !== undefined && typeof a.maxLines !== "number")) throw new Error("Resource ranges require integer numbers.");
        // Loading specialist instructions is role work; the coordinator activates squad only.
        if (resource.startsWith(".github/skills/") && !resource.startsWith(SKILL)) throw new Error("Only delegated specialists may activate specialist skills.");
        return o.bundle.read(resource, a.start === undefined ? 1 : Number(a.start), a.maxLines === undefined ? 160 : Number(a.maxLines));
      });
      register("list_project_files", schema({ prefix: { type: "string", maxLength: 500 }, offset: { type: "integer", minimum: 0 } }, []), async raw => {
        const a = closed(raw, ["prefix", "offset"], []);
        const prefix = a.prefix === undefined ? ".copilot-tracking/" : text(a.prefix, 500);
        if (prefix.endsWith("/")) path(prefix + "list.md"); else path(prefix);
        const offset = a.offset ?? 0;
        if (!Number.isSafeInteger(offset) || Number(offset) < 0) throw new Error("Invalid list offset.");
        const files = (await o.store.list(o.tenantId, o.project, prefix)).filter(f => { try { path(f.path); return true; } catch { return false; } });
        return { files: files.slice(Number(offset), Number(offset) + 100), total: files.length };
      });
      register("read_project_file", schema({ path: stringSchema, start: { type: "integer", minimum: 1 }, maxLines: { type: "integer", minimum: 1, maximum: 400 } }, ["path"]), async raw => {
        const a = closed(raw, ["path", "start", "maxLines"], ["path"]);
        const p = path(a.path), start = a.start ?? 1, count = a.maxLines ?? 160;
        if (!Number.isSafeInteger(start) || Number(start) < 1 || !Number.isSafeInteger(count) || Number(count) < 1 || Number(count) > 400) throw new Error("Invalid bounded project read.");
        const file = await o.store.get(o.tenantId, o.project, p);
        if (!file) throw new Error("Project artifact does not exist.");
        const lines = file.content.split(/\r?\n/), content = lines.slice(Number(start) - 1, Number(start) - 1 + Number(count)).join("\n");
        if (content.length > 64000) throw new Error("Project resource window exceeds 64000 characters.");
        return { path: p, sha256: hash(file.content), content, totalLines: lines.length, firstLine: start };
      });
      register("invoke_upstream_procedure", schema({ name: { type: "string", enum: PROCEDURES } }), async raw => {
        const a = closed(raw, ["name"]);
        if (!PROCEDURES.includes(a.name as UpstreamScriptName)) throw new Error("Script is not allowlisted.");
        const name = a.name as UpstreamScriptName;
        if (restored && ["Initialize-SquadConsumptionRates", "Resolve-SquadModelRoute", "Get-SquadDispatchBrief"].includes(name) && procedureResults.has(name)) return procedureResults.get(name);
        if (++procedures > (o.maxProcedureCalls ?? 24)) { setFatal(new Error("Upstream procedure budget exhausted.")); check(); }
        emit({ type: "procedure.attempted", procedure: name });
        try {
          const c = context();
          const prepared = await o.prepareProcedure(name, c);
          if (prepared.request.script !== name) throw new Error("Trusted procedure factory returned the wrong script.");
          if (name === "Initialize-SquadConsumptionRates" && (prepared.request as Extract<UpstreamScriptRequest, { script: "Initialize-SquadConsumptionRates" }>).args.mode !== (o.routing?.mode ?? "economy")) throw new Error("Procedure routing differs from the confirmed project mode.");
          if (name === "Resolve-SquadModelRoute" && (prepared.request as Extract<UpstreamScriptRequest, { script: "Resolve-SquadModelRoute" }>).args.mode !== (o.routing?.mode ?? "economy")) throw new Error("Procedure routing cannot override the confirmed project mode.");
          const result = await o.procedureRunner(prepared.request, prepared.policy, c);
          check();
          if (result.script !== name || result.accounting !== "upstream-schema-estimates-only") throw new Error("Procedure receipt does not match the trusted upstream script contract.");
          procedureResults.set(name, result);
          if (name === "Measure-SquadLedger") measuredStageCount = stages.length;
          emit({ type: "procedure.completed", procedure: name, execution: result.execution });
          return result;
        } catch (error) { emit({ type: "procedure.failed", procedure: name }); setFatal(error); throw error; }
      }, true);
      register("delegate_role_stage", schema({
        role: stringSchema, agent: stringSchema, task: stringSchema,
        purpose: { type: "string", enum: ["work", "review", "correction", "initialization"] },
        reviewsStageId: stringSchema, correctsStageId: stringSchema,
      }, ["role", "agent", "task", "purpose"]), async raw => {
        const a = closed(raw, ["role", "agent", "task", "purpose", "reviewsStageId", "correctsStageId"], ["role", "agent", "task", "purpose"]);
        const binding = roster.get(text(a.role, 200));
        if (!binding || a.agent !== binding.agent) throw new Error("Dispatch must name an exact confirmed roster role and agent.");
        if (!["work", "review", "correction", "initialization"].includes(String(a.purpose))) throw new Error("Invalid stage purpose.");
        const purpose = a.purpose as UpstreamStageRequest["purpose"];
        if (purpose === "review" && binding.role !== "tester") throw new Error("Closing review must use the protected roster tester role, never a discounted implementation substitute.");
        if (purpose === "initialization" && binding.agent !== "Squad Scribe") throw new Error("Only Squad Scribe may initialize state.");
        if (purpose !== "initialization" && ["Initialize-SquadConsumptionRates", "Resolve-SquadModelRoute", "Get-SquadDispatchBrief"].some(name => !procedureResults.has(name as UpstreamScriptName))) throw new Error("Run the upstream rate, routing and brief procedures before work.");
        const reviewsStageId = a.reviewsStageId === undefined ? undefined : text(a.reviewsStageId, 200);
        const correctsStageId = a.correctsStageId === undefined ? undefined : text(a.correctsStageId, 200);
        if ((purpose === "review") !== !!reviewsStageId || (purpose === "correction") !== !!correctsStageId) throw new Error("Review/correction require exact original stage references only.");
        const reviewed = reviewsStageId ? stages.find(s => s.request.stageId === reviewsStageId && s.history) : undefined;
        if (reviewsStageId && (!reviewed || reviewed.request.agent === binding.agent ||
            reviewed.artifacts.some(r => within(r.path, binding.writeScope)))) throw new Error("Review must independently read a completed owner and cannot write its artifacts.");
        let round = 1;
        if (failedReview && purpose !== "initialization") {
          if (purpose === "correction") {
            if (failedReview.corrected || correctsStageId !== failedReview.owner.request.stageId ||
                binding.role !== failedReview.owner.request.role || binding.agent !== failedReview.owner.request.agent) throw new Error("Only one correction by the explicit original owner is allowed.");
            round = 2;
          } else if (purpose === "review") {
            if (!failedReview.corrected || failedReview.rereviewed || reviewsStageId !== failedReview.corrected.request.stageId ||
                binding.role !== failedReview.reviewer.request.role || binding.agent !== failedReview.reviewer.request.agent) throw new Error("Only the same independent reviewer may rereview the corrected owner once.");
            round = 2;
          } else throw new Error("Failed review requires the original owner's correction and independent rereview, not substitute roles.");
        } else if (purpose === "correction") throw new Error("Correction requires a recorded failed review.");
        if (stages.length >= (o.maxStages ?? 24)) { setFatal(new Error("Upstream stage budget exhausted.")); check(); }
        // Reserve one provider call per child; observed attempts debit the remaining shared budget.
        const resumedRequest = resumePendingStage && restored?.pendingTool?.name === "delegate_role_stage" &&
          operationKey(raw) === operationKey(restored.pendingTool.args) ? resumePendingStage : undefined;
        if (!resumedRequest && ++calls > maximumCalls) { setFatal(new Error("Upstream model-call budget exhausted.")); check(); }
        const pick = picks.get(binding.role)!;
        const model = purpose === "correction" ? pick.rankedModel : pick.model;
        const request: UpstreamStageRequest = {
          stageId: resumedRequest?.stageId ?? randomUUID(), ...binding, task: text(a.task), purpose, round, model,
          rankedModel: pick.rankedModel, routeRationale: purpose === "correction" ? `${pick.rationale}; original owner correction` : pick.rationale,
          allowNestedDelegation: false, ...(reviewsStageId ? { reviewsStageId } : {}), ...(correctsStageId ? { correctsStageId } : {}),
          signal: controller.signal, deadlineAt, maxModelCalls: maximumCalls - calls + 1,
        };
        if (resumedRequest && (resumedRequest.role !== binding.role || resumedRequest.agent !== binding.agent || resumedRequest.model !== model)) throw new Error("Pending stage continuation no longer matches its confirmed role/model.");
        pendingStage = structuredClone({ ...request, signal: undefined }) as UpstreamCoordinatorCheckpoint["pendingStage"];
        if (pendingStage) delete (pendingStage as unknown as { signal?: unknown }).signal;
        resumePendingStage = undefined;
        snapshot();
        emit({ type: resumedRequest ? "stage.resumed" : purpose === "correction" ? "stage.escalated" : "stage.attempted", stageId: request.stageId, role: binding.role, agent: binding.agent, model, round });
        try {
          const response = await o.stageRunner({ ...request, writeScope: structuredClone(request.writeScope) });
          check();
          const attemptCount = response.result.usage?.attemptCount ?? response.result.usage?.completionCount ?? 1;
          if (!Number.isSafeInteger(attemptCount) || attemptCount < 0) throw new Error("Invalid observed child attempt count.");
          calls += Math.max(0, attemptCount - (resumedRequest ? restored?.pendingStageObservedAttempts ?? 0 : 1));
          const { signal: _signal, ...savedRequest } = request;
          const completed: UpstreamCompletedStage = { request: savedRequest, result: structuredClone(response.result), artifacts: [] };
          stages.push(completed);
          if (response.result.model && response.result.model !== model) throw new Error("Child deviated from the server-resolved model route; protected review routes cannot be lowered.");
          for (const rawReceipt of response.artifacts) {
            if (!within(path(rawReceipt.path), binding.writeScope)) throw new Error("Child artifact escaped its assigned write scope.");
            completed.artifacts.push(await verified(rawReceipt));
          }
          if (response.retainedUpdates?.length) {
            completed.retainedUpdates = [];
            for (const update of response.retainedUpdates) {
              if (binding.role !== "developer" || !stages.some(s => s !== completed && s.request.role === "lead" && s.artifacts.some(a => a.path === update.path))) throw new Error("Only trusted exact markers in this run's existing Lead plan may be retained as input updates.");
              completed.retainedUpdates.push(await verified(update));
            }
          }
          if (!completed.artifacts.length) throw new Error("Stage returned no actual stored deliverable.");
          if (calls > maximumCalls) throw new Error("Observed child attempts exceeded the upstream model budget.");
          const usage = response.result.usage;
          const numeric = (n: number | undefined) => Number.isFinite(n) && n! >= 0 ? n! : 0;
          const consumption: UpstreamHistoryRecord["consumption"] = {
            model: response.result.model ?? model, model_source: response.result.model ? "dispatch-reported" : "operator-declared",
            priced_as: response.result.model ?? model, model_tier: binding.floor,
            internal_turns: numeric(usage?.completionCount), input_tokens: Math.max(0, numeric(usage?.inputTokens) - numeric(usage?.cacheReadTokens)),
            cached_tokens: numeric(usage?.cacheReadTokens), cache_write_tokens: numeric(usage?.cacheWriteTokens),
            output_tokens: numeric(usage?.outputTokens), basis: usage?.inputTokens === undefined || usage?.outputTokens === undefined ? "tier-default" : "estimated",
          };
          const timestamp = new Date().toISOString();
          const record: UpstreamHistoryRecord = {
            stageId: request.stageId, role: binding.role, agent: binding.agent, turn: stages.length, request: request.task,
            deliverable: completed.artifacts[0].path, outcome: response.result.finishReason, timestamp,
            upstreamHistoryPath: `.copilot-tracking/squad/history/${binding.agent}.md`, consumption,
            observedUsage: usage,
            historyEntry: `### ${timestamp} ${request.stageId}\n\n* Turn: ${stages.length}\n* Request: ${request.task.replace(/\r?\n/g, " ")}\n* Deliverable: \`${completed.artifacts[0].path}\`\n* Outcome: ${response.result.finishReason}\n\n#### Consumption\n\n\`\`\`json\n${JSON.stringify(consumption, null, 2)}\n\`\`\`\n\n* **Requested model** — ${model}\n* **Effective model** — ${consumption.model}\n* **Route rationale** — ${request.routeRationale}\n* **Model deviation** — ${consumption.model === model ? "none" : "provider-reported model differs"}\n* Unreported token values use upstream tier-default estimates; not an invoice.\n`,
          };
          completed.history = await verified(await o.persistStage(record, context()));
          const stored = await o.store.get(o.tenantId, o.project, completed.history.path);
          if (!stored?.content.includes(`# History: ${binding.agent}`) || !stored.content.includes(record.stageId) ||
              !stored.content.includes("#### Consumption")) throw new Error("Persistence omitted the genuine upstream history entry.");
          if (purpose === "correction" && failedReview) failedReview.corrected = completed;
          if (purpose === "review" && failedReview) failedReview.rereviewed = completed;
          emit({ type: "stage.completed", stageId: request.stageId, role: binding.role, agent: binding.agent, model, round });
          return { stageId: request.stageId, result: response.result, artifacts: completed.artifacts, history: completed.history };
        } catch (error) { emit({ type: "stage.failed", stageId: request.stageId, role: binding.role, agent: binding.agent }); setFatal(error); throw error; }
      }, true);
      register("request_human_input", schema({ question: stringSchema, reason: stringSchema }), async raw => {
        const a = closed(raw, ["question", "reason"]);
        const answer = o.continuation?.answer;
        if (answer && !restoredAnswerServed && restored?.pendingTool?.name === "request_human_input" &&
            operationKey(raw) === operationKey(restored.pendingTool.args) && a.question === answer.question && a.reason === answer.reason) {
          restoredAnswerServed = true;
          emit({ type: "approval.response-restored" });
          return { answer: answer.answer, respondedBy: answer.respondedBy, responseId: answer.responseId };
        }
        emit({ type: "approval.required" });
        try { await o.requestHumanInput({ question: text(a.question), reason: text(a.reason) }, context()); }
        catch (error) { setFatal(error); throw error; }
        const error = new Error("Human-input callback returned without a StageInputRequired halt.");
        setFatal(error);
        throw error;
      }, true);
      register("finish_upstream_run", schema({
        outcome: { type: "string", enum: ["accepted", "findings"] }, summary: stringSchema,
        gaps: { type: "array", maxItems: 30, items: stringSchema }, reportPaths: { type: "array", minItems: 1, maxItems: 30,
          description: "Only canonical current-owner artifact paths from delegate_role_stage receipts. Exclude reviewer artifacts and staged executor aliases.", items: stringSchema },
      }), async raw => {
        const a = closed(raw, ["outcome", "summary", "gaps", "reportPaths"]);
        if (!["accepted", "findings"].includes(String(a.outcome)) || !Array.isArray(a.gaps) || a.gaps.length > 30 ||
            !Array.isArray(a.reportPaths) || !a.reportPaths.length || a.reportPaths.length > 30) throw new Error("Invalid finish contract.");
        const gaps = a.gaps.map(g => text(g)), summary = text(a.summary);
        const reports: UpstreamReceipt[] = [];
        for (const rawPath of a.reportPaths) {
          const p = path(rawPath);
          const author = [...stages].reverse().find(s => s.history && s.request.purpose !== "review" &&
            [...s.artifacts, ...(s.retainedUpdates ?? [])].some(r => r.path === p));
          const r = [...(author?.artifacts ?? []), ...(author?.retainedUpdates ?? [])].find(r => r.path === p);
          if (!r) throw new Error(`Invalid reportPaths entry ${p}. Use only canonical artifacts paths from a CURRENT persisted non-review owner stage: ${JSON.stringify(stages.filter(s => s.history && s.request.purpose !== "review").flatMap(s => s.artifacts.map(r => r.path)))}. Exclude reviewer artifacts and temporary executor aliases. A complete/ready owner with persisted handoff is already valid; do not dispatch another owner merely to invent an accepted finish_stage status.`);
          reports.push(await verified(r));
        }
        if (new Set(reports.map(r => r.path)).size !== reports.length) throw new Error("Duplicate finish report.");
        if (!procedureResults.has("Measure-SquadLedger") || measuredStageCount !== stages.length) throw new Error("Run upstream ledger reconciliation after the final persisted stage before finishing.");
        const review = await o.verifyFinish(structuredClone(reports), context());
        check();
        if (!["Pass", "Conditional Pass", "Fail"].includes(review.verdict) || typeof review.approvedActionablePipeline !== "boolean" ||
            !Array.isArray(review.readHashes) || !Array.isArray(review.findings)) throw new Error("Invalid trusted review verification.");
        const owner = stages.find(s => s.history && s.request.stageId === review.ownerStageId);
        const reviewer = stages.find(s => s.history && s.request.stageId === review.reviewerStageId);
        if (!owner || !reviewer || reviewer.request.purpose !== "review" || reviewer.request.reviewsStageId !== owner.request.stageId ||
            reviewer.request.agent === owner.request.agent || reports.some(r => within(r.path, { exactPaths: reviewer.request.writeScope.exactPaths, prefixes: reviewer.request.writeScope.prefixes }))) throw new Error("Finish requires an independent review of the exact completed owner.");
        if (!reports.every(report => [...owner.artifacts, ...(owner.retainedUpdates ?? [])].some(r => report.path === r.path && report.sha256 === r.sha256))) throw new Error("Review does not identify every report's original author.");
        const reviewReceipt = await verified(review.reviewReceipt);
        if (!reviewer.artifacts.some(r => r.path === reviewReceipt.path && r.sha256 === reviewReceipt.sha256)) throw new Error("Review has no genuine stored reviewer receipt.");
        for (const r of reports) {
          if (!review.readHashes.some(read => read.path === r.path && read.sha256 === r.sha256)) throw new Error("Independent review did not read the final report hash.");
          await verified(r); // Detect modification during the verification callback as well.
        }
        emit({ type: "review.verified", stageId: reviewer.request.stageId, verdict: review.verdict });
        const bad = review.verdict !== "Pass" || review.highestSeverity === "Critical" || review.highestSeverity === "High";
        if (bad && !failedReview) failedReview = { owner, reviewer };
        if (a.outcome === "accepted" && bad) {
          throw new Error(failedReview?.corrected ? "Rereview did not Pass; no automatic acceptance. Report findings and an honest gap or request human input." :
            `Review ${review.verdict}; dispatch one correction by original role ${owner.request.role} (${owner.request.agent}) on its ranked pick, then rereview with ${reviewer.request.role}.`);
        }
        if (failedReview && a.outcome === "accepted" && (!failedReview.corrected || !failedReview.rereviewed || reviewer !== failedReview.rereviewed)) throw new Error("Acceptance after a failed review requires the one correction and exact rereview.");
        if (a.outcome === "findings" && (review.approvedActionablePipeline || !gaps.length)) throw new Error("Findings-only requires no approved actionable pipeline and an explicit honest gap.");
        if (a.outcome === "accepted" && gaps.length) throw new Error("Accepted output cannot conceal unresolved gaps.");
        finished = {
          text: summary, backendId: "copilot-sdk", model: o.coordinatorModel, finishReason: "stop",
          usage: aggregateBackendUsage([...coordinatorUsage, ...stages.flatMap(s => s.result.usage ? [s.result.usage] : [])]),
          stages: structuredClone(stages),
          metadata: { upstreamCommit: o.bundle.identity.sourceCommit, upstreamVersion: o.bundle.identity.declaredVersion, rolloutVersion: "0.19.0-pre",
            routing: o.routing?.mode ?? "economy", outcome: a.outcome as "accepted" | "findings", gaps, reports,
            verification: structuredClone(review), events: [...events], productionSmokeVerified: false },
        };
        return { finished: true, outcome: a.outcome, reports };
      }, true, true);
      const denied = async (): Promise<never> => { throw new Error("Coordinator filesystem access is denied; use bounded project tools."); };
      const fs: SessionFsProviderPort = {
        readFile: denied, writeFile: denied, appendFile: denied, exists: denied, stat: denied,
        mkdir: denied, readdir: denied, readdirWithTypes: denied, rm: denied, rename: denied,
      };
      const config: CopilotSessionConfig = {
        sessionId, model: o.coordinatorModel,
        systemMessage: { mode: "append", content: `${contract}\n\nServer adapter contract:\nUse the authentic Init → Route → Decide → Handoff procedure above, not a fixed native Research/Plan loop. Choose only confirmed roster agents; do not perform role work inline. The bridge replaces runSubagent/task with delegate_role_stage and PowerShell with invoke_upstream_procedure(name only). Script arguments, write policies, identity, admission and approvals are server-owned. The user explicitly confirmed routing=${o.routing?.mode ?? "economy"}; neither caller text nor a model can change that persisted choice. Ranked uses fit-first picks; economy permits only eligible implementation discounts; manual keeps the chosen fixed model for stages, corrections and helpers. Before work, invoke Initialize-SquadConsumptionRates, Resolve-SquadModelRoute, Get-SquadDispatchBrief. Run Measure-SquadLedger after the persisted stage histories. Ordinary state writes belong to Scribe and trusted handoff persistence. request_human_input always halts. Finish only with stored reports and an independent exact-hash Pass; a Fail requires one original-owner correction and rereview on the server-selected route, or findings with honest gaps when no actionable pipeline is approved. No generic task, shell, editing, tracker, cloud or arbitrary tools are available. All specialist skills remain available to assigned children through the immutable bundle, never activated inline by the coordinator.\nConfirmed roster:\n${JSON.stringify([...roster.values()])}` },
        availableTools: [...UPSTREAM_COORDINATOR_TOOLS], tools, customAgents: [],
        hooks: {
          onPreToolUse: input => ({ permissionDecision: !finished && !stopped && !controller.signal.aborted && input.sessionId === config.sessionId &&
            (UPSTREAM_COORDINATOR_TOOLS as readonly string[]).includes(input.toolName) ? "allow" : "deny",
          permissionDecisionReason: "Only the server's coordinator tool allowlist is available; no generic/nested tools." }),
          onPostToolUse: async () => undefined,
        },
        onPermissionRequest: () => ({ kind: "reject", feedback: "Coordinator has no direct filesystem/shell/cloud permission." }),
        fileSystem: fs, workingDirectory: "/workspace", streaming: false,
        ...(o.gitHubToken ? { gitHubToken: o.gitHubToken } : {}),
        ...(o.gitHubTokenProvider ? { gitHubTokenProvider: o.gitHubTokenProvider } : {}),
      };
      let rejectStopped!: (reason: unknown) => void;
      const stopPromise = new Promise<never>((_, reject) => { rejectStopped = reject; });
      const onAbort = () => rejectStopped(fatal ?? new Error("Upstream run cancelled."));
      controller.signal.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => setFatal(new Error("Upstream coordinator deadline exhausted.")), Math.max(1, deadlineAt - Date.now()));
      let unsubscribe: (() => void) | undefined;
      try {
        const creating = restored ? o.client.resumeSession!(sessionId, config) : o.client.createSession(config);
        void creating.then(created => { if (controller.signal.aborted) { void created.abort().catch(() => undefined); void created.disconnect().catch(() => undefined); } }, () => undefined);
        session = await Promise.race([creating, stopPromise]);
        if (fatal) throw fatal;
        if (controller.signal.aborted) throw new Error("Upstream run cancelled.");
        unsubscribe = session.on(event => {
          if (event.type === "assistant.usage") {
            coordinatorCompletions++;
            if (++sessionCompletions > 1 && ++calls > maximumCalls) setFatal(new Error("Upstream coordinator model-call budget exhausted."));
            const data = event.data ?? {};
            const observed = copilotUsageFor(data);
            coordinatorUsage.push(observed);
            o.onCoordinatorUsage?.(observed, typeof data.model === "string" ? data.model : undefined, event.id);
          }
          emit({ type: `runtime.${event.type}` });
          snapshot();
        });
        snapshot();
        const resumePrompt = o.continuation
          ? `Resume the held upstream turn, not a new run. Completed dispatches and their histories are restored; do not repeat them. Server-held response to exactly ${JSON.stringify({ question: o.continuation.answer.question, reason: o.continuation.answer.reason })}: ${JSON.stringify({ answer: o.continuation.answer.answer, respondedBy: o.continuation.answer.respondedBy, responseId: o.continuation.answer.responseId })}. This answer grants only its stated scope, not unrelated business approvals. ${restored?.pendingStage ? "Reinvoke the exact pending delegate_role_stage operation to resume its existing stage; do not replace or restart it." : ""}\nOriginal request:\n${prompt}`
          : prompt;
        await Promise.race([session.sendAndWait({ prompt: resumePrompt }, Math.max(1, deadlineAt - Date.now())), stopPromise]);
        check();
        if (!finished) throw new Error("Upstream coordinator stopped without a verified terminal finish.");
        // The runtime may emit final provider usage after the terminal tool returns.
        finished.usage = aggregateBackendUsage([...coordinatorUsage, ...stages.flatMap(s => s.result.usage ? [s.result.usage] : [])]);
        finished.metadata.events = [...events];
        return finished;
      } finally {
        stopped = true;
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", onAbort);
        unsubscribe?.();
        void session?.abort().catch(() => undefined);
        void session?.disconnect().catch(() => undefined);
      }
    } catch (error) {
      if (inputRequired(fatal ?? error)) throw fatal ?? error;
      throw new UpstreamCoordinatorError(error instanceof Error ? error.message : "Upstream coordinator failed.", structuredClone(stages), [...events], fatal ?? error);
    } finally {
      stopped = true;
      controller.abort();
      o.signal?.removeEventListener("abort", cancel);
    }
  }
}
