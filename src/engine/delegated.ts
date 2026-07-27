/**
 * DelegatedCoordinator — Phase 0 execution engine.
 *
 * Per the Step 0.1 spike verdict (Question A = PASS -> delegated-primary), this
 * engine runs NO model. On a tool call it composes and returns the Coordinator
 * persona + the squad instruction context relevant to the matched intent, the
 * matched routing decision, the framed dispatch request, and the state context.
 * The VS Code host ingests this and runs its own runSubagent/task loop to
 * dispatch the cast — exactly the path the squad uses today, now reachable as a
 * model-invocable tool.
 *
 * This is the only behavior that changes between the spike's fixed sample and
 * production: routing is read from the catalog tool, and all five tools flow
 * through one implementation behind the `CoordinatorEngine` seam. Phase 1's
 * `EmbeddedCoordinator` implements the same interface.
 */
import type { CatalogTool } from "../catalog/catalog.js";
import type {
  CoordinatorEngine,
  CoordinatorRequest,
  DelegatedResult,
  MatchedRouting,
} from "./coordinator-engine.js";
import {
  COORDINATOR_PERSONA,
  FEDERATION_AUTOPILOT_NOTE,
  FEDERATION_COORDINATOR_PERSONA,
  FEDERATION_DETECTION_NOTE,
  GATE_INSTRUCTIONS,
  modeInstructions,
  squadStateRoot,
} from "./persona.js";
import { LOCAL_MEMORY_TENANT } from "./squad-memory-resources.js";
import type { SquadMemoryStore } from "./squad-memory-state.js";

/** True for the federation meta tool (routes across named sub-squads). */
function isFederationTool(tool: CatalogTool): boolean {
  return tool.role === "Squad Federation Coordinator";
}

function toMatchedRouting(tool: CatalogTool): MatchedRouting {
  return {
    routingIntent: tool.routingIntent,
    role: tool.role,
    tier: tool.tier,
    parallelEligible: tool.parallelEligible,
    council: tool.council,
    catchAll: tool.catchAll,
    gates: tool.gates,
  };
}

function composeSystemPrompt(tool: CatalogTool, request: CoordinatorRequest): string {
  const federation = isFederationTool(tool);
  const blocks: string[] = [federation ? FEDERATION_COORDINATOR_PERSONA : COORDINATOR_PERSONA];
  // Gating instructions are load-bearing only for the pipeline/council tools.
  if (tool.gates || tool.council.length > 0) {
    blocks.push(GATE_INSTRUCTIONS);
  }
  // Surface federation resolution for the federation tool, or for any tool that
  // did not pin a sub-squad (a plain repo ignores it; a federation repo needs it).
  if (federation || !request.squad) {
    blocks.push(FEDERATION_DETECTION_NOTE);
  }
  const modeBlock = modeInstructions(request.mode);
  if (modeBlock.length > 0) {
    blocks.push(modeBlock);
  }
  // A federation autopilot run with no pinned sub-squad drives the meta-pipeline
  // across sub-squads; surface the federation-level autopilot contract.
  if (federation && request.mode === "autopilot" && !request.squad) {
    blocks.push(FEDERATION_AUTOPILOT_NOTE);
  }
  return blocks.join("\n\n");
}

function composeFramedRequest(tool: CatalogTool, request: CoordinatorRequest): string {
  const lines: string[] = [];
  if (isFederationTool(tool)) {
    if (request.promote) {
      lines.push(
        "Acting as the Squad Federation Coordinator, run Federation Promotion Mode",
        "(propose -> confirm -> migrate -> seed -> route) to adopt the EXISTING single",
        "squad into a federation as its first sub-squad: read the top-level `team.md`,",
        "propose a unique lower-kebab-case sub-squad name (default from its profile), and",
        "on confirmation have the Squad Scribe relocate the whole top-level state tree",
        "into `.copilot-tracking/squad/members/<name>/` intact (append-only decision and",
        "history logs preserved) and seed the federation meta layer (`federation.md`,",
        "`meta-routing.md`, and the federation-level decisions/history). Refuse if a",
        "`federation.md` already exists or the target `members/<name>/` is taken. Then",
        "route the request below. Do NOT do the work inline.",
      );
    } else if (request.init) {
      lines.push(
        "Acting as the Squad Federation Coordinator, run Federation Init Mode when no",
        "`federation.md` exists yet (propose -> confirm -> create): discover the repo,",
        "propose a set of named sub-squads (each seeded from a profile), require a unique",
        "lower-kebab-case name per sub-squad, and create the registry plus each sub-squad.",
        "When a `federation.md` ALREADY exists, instead run Federation Expansion Mode:",
        "propose and confirm the new sub-squad, seed it under `members/<new>/`, and register",
        "it by appending its row to `federation.md` and its route to `meta-routing.md`",
        "(preserving every existing row). Then route the request below. Do NOT do the work",
        "inline.",
      );
    } else if (request.squad) {
      lines.push(
        `Acting as the Squad Federation Coordinator, route this request to the ` +
          `**${request.squad}** sub-squad and run its normal per-turn protocol scoped ` +
          "to `.copilot-tracking/squad/members/" + request.squad + "/`. Do NOT do the work inline.",
      );
    } else if (request.mode === "autopilot") {
      lines.push(
        "Acting as the Squad Federation Coordinator, run the federation-level autopilot",
        "meta-pipeline: read `federation.md` and `meta-routing.md`, order the selected",
        "sub-squads by dependency (confirm the order at the first gate), run each",
        "sub-squad's standard autopilot inner run scoped to its `members/<name>/` root,",
        "aggregate every Impactful-Action and Risk Gate to the federation level",
        "(attributed to the raising sub-squad), and end with one consolidated",
        "final-outcome validation. Never auto-release. Do NOT do the work inline.",
      );
    } else {
      lines.push(
        "Acting as the Squad Federation Coordinator, read `federation.md` and",
        "`meta-routing.md`, classify this request to the matching sub-squad(s), and run",
        "each scoped to its own `members/<name>/` root. Escalate if the target is",
        "ambiguous or unknown. Do NOT do the work inline.",
      );
    }
  } else if (tool.catchAll) {
    lines.push(
      "Acting as the Squad Coordinator, classify this request against the routing",
      "table and dispatch the matched roles through Research -> Plan -> Implement",
      "-> Review, honoring the Implementation Gate and Review Follow-Through. Do",
      "NOT answer it inline.",
    );
  } else {
    const tierNote = tool.tier === "auto" ? "auto" : `${tool.tier} (confirm before any change lands)`;
    lines.push(
      `Acting as the Squad Coordinator, dispatch the **${tool.role}** (intent: ` +
        `"${tool.routingIntent}", tier: ${tierNote}) via your runSubagent/task tool ` +
        "for this request. Do NOT perform the work inline; dispatch and report only",
      "after the subagent returns:",
    );
    if (tool.council.length > 0) {
      lines.push(
        "",
        "If this is a pre-implementation go/no-go or crosses two or more council",
        `domains, also run the council (${tool.council.join(", ")}) and record a ` +
          "Council Verdict before any implementer dispatches.",
      );
    }
    if (request.squad) {
      lines.push(
        "",
        `Scope this dispatch to the **${request.squad}** federation sub-squad ` +
          "(`.copilot-tracking/squad/members/" + request.squad + "/`).",
      );
    }
  }
  lines.push("", `> ${request.request.replace(/\n/g, "\n> ")}`);
  if (request.context && request.context.trim().length > 0) {
    lines.push("", "Additional context:", request.context.trim());
  }
  return lines.join("\n");
}

/**
 * Bound for the optional prior-context digest injected into the delegated
 * charter (Step 4.1). The digest is a BOUNDED read of the shared squad memory —
 * the delegated coordinator still runs no model — so a large decisions log or a
 * chatty per-agent history can never blow up the charter: at most the last
 * {@link PRIOR_DECISIONS_LIMIT} decision lines per project are surfaced, plus the
 * single latest line of each per-agent history.
 */
const PRIOR_DECISIONS_LIMIT = 5;

/** The last `limit` non-empty (right-trimmed) lines of a memory entry body. */
function lastNonEmptyLines(content: string, limit: number): string[] {
  const lines = content
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  return lines.slice(-limit);
}

/**
 * Compose the bounded prior-context digest lines for a `tenantId` across every
 * project in the shared store: the last {@link PRIOR_DECISIONS_LIMIT} `decisions`
 * lines and the single latest line of each `history/<agent>` entry, per project.
 * Returns the indented sub-list appended under the `- prior context …` header
 * (empty when the store holds no readable prior decisions or history). Read-only:
 * it never mutates the store.
 */
async function composePriorContextLines(
  store: SquadMemoryStore,
  tenantId: string,
): Promise<string[]> {
  const projects = await store.listProjects(tenantId);
  const lines: string[] = [];
  for (const project of [...projects].sort((a, b) => a.localeCompare(b))) {
    const entries = await store.list(tenantId, project);
    const projectLines: string[] = [];
    const decisions = entries.find((entry) => entry.path === "decisions");
    if (decisions) {
      for (const line of lastNonEmptyLines(decisions.content, PRIOR_DECISIONS_LIMIT)) {
        projectLines.push(`    - decision: ${line}`);
      }
    }
    const histories = entries
      .filter((entry) => entry.path.startsWith("history/"))
      .sort((a, b) => a.path.localeCompare(b.path));
    for (const history of histories) {
      const latest = lastNonEmptyLines(history.content, 1)[0];
      if (latest !== undefined) {
        projectLines.push(`    - history/${history.path.slice("history/".length)}: ${latest}`);
      }
    }
    if (projectLines.length > 0) {
      lines.push(`  - project \`${project}\`:`);
      lines.push(...projectLines);
    }
  }
  return lines;
}

async function composeStateContext(
  request: CoordinatorRequest,
  memory?: { readonly store: SquadMemoryStore; readonly tenantId: string },
): Promise<string> {
  const stateRoot = squadStateRoot(request.squad);
  const lines: string[] = [
    `- squad state root: \`${stateRoot}\` (create on first use via the Squad Scribe)`,
    `- sub-squad: ${request.squad ?? "(none / plain squad; resolve from meta-routing in a federation)"}`,
    `- profile: ${request.profile ?? "(coordinator discovers / proposes)"}`,
    `- tier: ${request.tier ?? "(cost-first default)"}`,
    `- owner: ${request.owner ?? "(role-only dispatch)"}`,
    `- mode: ${request.mode ?? "(interactive)"}`,
  ];
  // Optional bounded prior-context digest (Step 4.1). With NO store injected the
  // block is never appended, so the output is BYTE-IDENTICAL to the advisory-only
  // default (no regression); with a store injected AND prior entries present the
  // charter carries the prior decisions + latest per-agent history so the VS Code
  // host inherits context in the charter itself (the READ half of DR-05; the host
  // writes back via squad_memory_write per the charter footer).
  if (memory) {
    const priorLines = await composePriorContextLines(memory.store, memory.tenantId);
    if (priorLines.length > 0) {
      lines.push("- prior context (bounded digest from shared squad memory):");
      lines.push(...priorLines);
    }
  }
  return lines.join("\n");
}

/**
 * Options for {@link DelegatedCoordinator}. Every field is optional so the default
 * construction (`new DelegatedCoordinator()`) is unchanged from Phase 0.
 */
export interface DelegatedCoordinatorOptions {
  /**
   * Optional shared-state memory broker (shared-state broker — DR-01). When
   * provided, {@link composeStateContext} appends a bounded prior-decisions /
   * per-agent-history digest to the charter's state context (Step 4.1); when
   * omitted the charter is byte-identical to the advisory-only default.
   */
  readonly memoryStore?: SquadMemoryStore;
  /**
   * The tenant the prior-context digest is read under. Defaults to the stdio
   * {@link LOCAL_MEMORY_TENANT} sentinel — the delegated coordinator serves the
   * local trust boundary, where there is no Entra token to resolve a real tenant.
   */
  readonly memoryTenant?: string;
}

/** Phase 0 delegated execution engine. Runs no model. */
export class DelegatedCoordinator implements CoordinatorEngine {
  readonly mode = "delegated" as const;

  private readonly memoryStore?: SquadMemoryStore;
  private readonly memoryTenant: string;

  constructor(options: DelegatedCoordinatorOptions = {}) {
    this.memoryStore = options.memoryStore;
    this.memoryTenant = options.memoryTenant ?? LOCAL_MEMORY_TENANT;
  }

  async handle(tool: CatalogTool, request: CoordinatorRequest): Promise<DelegatedResult> {
    const memory = this.memoryStore
      ? { store: this.memoryStore, tenantId: this.memoryTenant }
      : undefined;
    return {
      kind: "delegated",
      systemPrompt: composeSystemPrompt(tool, request),
      matchedRouting: toMatchedRouting(tool),
      framedRequest: composeFramedRequest(tool, request),
      stateContext: await composeStateContext(request, memory),
    };
  }
}
