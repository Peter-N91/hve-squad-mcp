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
  GATE_INSTRUCTIONS,
  SQUAD_STATE_ROOT,
  modeInstructions,
} from "./persona.js";

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
  const blocks: string[] = [COORDINATOR_PERSONA];
  // Gating instructions are load-bearing only for the pipeline/council tools.
  if (tool.gates || tool.council.length > 0) {
    blocks.push(GATE_INSTRUCTIONS);
  }
  const modeBlock = modeInstructions(request.mode);
  if (modeBlock.length > 0) {
    blocks.push(modeBlock);
  }
  return blocks.join("\n\n");
}

function composeFramedRequest(tool: CatalogTool, request: CoordinatorRequest): string {
  const lines: string[] = [];
  if (tool.catchAll) {
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
  }
  lines.push("", `> ${request.request.replace(/\n/g, "\n> ")}`);
  if (request.context && request.context.trim().length > 0) {
    lines.push("", "Additional context:", request.context.trim());
  }
  return lines.join("\n");
}

function composeStateContext(request: CoordinatorRequest): string {
  const lines: string[] = [
    `- squad state root: \`${SQUAD_STATE_ROOT}\` (create on first use via the Squad Scribe)`,
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
