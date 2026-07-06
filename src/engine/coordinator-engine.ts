/**
 * The CoordinatorEngine seam — the headless-invocation interface that lets one
 * codebase serve both an HVE host (VS Code, delegated) and non-HVE hosts (the
 * remote surfaces, embedded, added in Phase 1) without forking the Coordinator.
 *
 * Phase 0 ships only the `DelegatedCoordinator`. Phase 1's `EmbeddedCoordinator`
 * implements this same interface, so the union below grows but the seam does
 * not change.
 */
import type { CatalogTool } from "../catalog/catalog.js";

/** A normalized tool invocation, derived from validated MCP tool-call args. */
export interface CoordinatorRequest {
  /** The tool id that was invoked (e.g. `squad_research`). */
  toolId: string;
  /** The user's request text (required). */
  request: string;
  /** Optional squad profile hint. */
  profile?: string;
  /** Optional model-tier hint (`fast` | `default`). */
  tier?: string;
  /** Optional Member Name to pick a specific named member. */
  owner?: string;
  /** Optional autonomy mode (`autonomous` | `autopilot`). */
  mode?: string;
  /** Optional free-form context. */
  context?: string;
}

/** The routing decision attached to a tool, surfaced back to the host. */
export interface MatchedRouting {
  /** The routing intent row matched (or `*` for the catch-all pipeline). */
  routingIntent: string;
  /** The primary role/agent dispatched for this intent. */
  role: string;
  /** The autonomy tier applied. */
  tier: string;
  /** Whether the role may run in parallel with other independent roles. */
  parallelEligible: boolean;
  /** Council member agents engaged for go/no-go reviews (may be empty). */
  council: string[];
  /** True for the full classify-and-dispatch pipeline. */
  catchAll: boolean;
  /** True when Implementation/Human gates apply. */
  gates: boolean;
}

/**
 * Result of delegated execution. Runs no model: it returns the context the
 * calling host needs to run its OWN runSubagent/task loop.
 */
export interface DelegatedResult {
  kind: "delegated";
  /** Coordinator persona + the squad instruction context relevant to the intent. */
  systemPrompt: string;
  /** The matched routing decision. */
  matchedRouting: MatchedRouting;
  /** The request, framed as a dispatch instruction for the host. */
  framedRequest: string;
  /** Where squad state lives and per-turn inputs (profile/tier/owner/mode). */
  stateContext: string;
}

/**
 * The engine result union. Phase 1 adds an `EmbeddedResult` member (finished
 * artifacts) without changing the seam.
 */
export type EngineResult = DelegatedResult;

/** The execution-mode seam implemented by Delegated (Phase 0) and Embedded (Phase 1). */
export interface CoordinatorEngine {
  /** Which execution mode this engine implements. */
  readonly mode: "delegated" | "embedded";
  /** Handle one validated tool invocation. */
  handle(tool: CatalogTool, request: CoordinatorRequest): Promise<EngineResult>;
}
