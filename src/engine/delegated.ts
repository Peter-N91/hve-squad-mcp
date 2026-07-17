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
  FEDERATION_COORDINATOR_PERSONA,
  FEDERATION_DETECTION_NOTE,
  GATE_INSTRUCTIONS,
  modeInstructions,
  squadStateRoot,
} from "./persona.js";

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
  return blocks.join("\n\n");
}

function composeFramedRequest(tool: CatalogTool, request: CoordinatorRequest): string {
  const lines: string[] = [];
  if (isFederationTool(tool)) {
    if (request.init) {
      lines.push(
        "Acting as the Squad Federation Coordinator, run Federation Init Mode",
        "(propose -> confirm -> create): discover the repo, propose a set of named",
        "sub-squads (each seeded from a profile), require a unique lower-kebab-case",
        "name per sub-squad, and create the registry plus each sub-squad. Then route",
        "the request below. Do NOT do the work inline.",
      );
    } else if (request.squad) {
      lines.push(
        `Acting as the Squad Federation Coordinator, route this request to the ` +
          `**${request.squad}** sub-squad and run its normal per-turn protocol scoped ` +
          "to `.copilot-tracking/squad/members/" + request.squad + "/`. Do NOT do the work inline.",
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

function composeStateContext(request: CoordinatorRequest): string {
  const stateRoot = squadStateRoot(request.squad);
  const lines: string[] = [
    `- squad state root: \`${stateRoot}\` (create on first use via the Squad Scribe)`,
    `- sub-squad: ${request.squad ?? "(none / plain squad; resolve from meta-routing in a federation)"}`,
    `- profile: ${request.profile ?? "(coordinator discovers / proposes)"}`,
    `- tier: ${request.tier ?? "(cost-first default)"}`,
    `- owner: ${request.owner ?? "(role-only dispatch)"}`,
    `- mode: ${request.mode ?? "(interactive)"}`,
  ];
  return lines.join("\n");
}

/** Phase 0 delegated execution engine. Runs no model. */
export class DelegatedCoordinator implements CoordinatorEngine {
  readonly mode = "delegated" as const;

  handle(tool: CatalogTool, request: CoordinatorRequest): Promise<DelegatedResult> {
    const result: DelegatedResult = {
      kind: "delegated",
      systemPrompt: composeSystemPrompt(tool, request),
      matchedRouting: toMatchedRouting(tool),
      framedRequest: composeFramedRequest(tool, request),
      stateContext: composeStateContext(request),
    };
    return Promise.resolve(result);
  }
}
