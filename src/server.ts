/**
 * Server entrypoint for the hve-squad MCP server (Phase 0: stdio, delegated).
 *
 * Wires the authored catalog -> router (JSON Schema validation) -> the
 * CoordinatorEngine seam -> a transport. Uses the low-level MCP `Server` so the
 * raw JSON Schema authored in `tools.catalog.yml` is advertised verbatim on
 * `tools/list` and validated with Ajv on `tools/call`.
 */
import { pathToFileURL } from "node:url";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";

import { loadCatalog, type ToolCatalog } from "./catalog/catalog.js";
import type { CoordinatorEngine, EngineResult } from "./engine/coordinator-engine.js";
import { DelegatedCoordinator } from "./engine/delegated.js";
import { ToolInputError, ToolRouter } from "./router/router.js";
import { createStdioTransport } from "./transports/stdio.js";

export const SERVER_NAME = "hve-squad-mcp";
export const SERVER_VERSION = "0.1.0";

export interface CreateServerOptions {
  catalog?: ToolCatalog;
  engine?: CoordinatorEngine;
}

export interface SquadServer {
  server: Server;
  router: ToolRouter;
  engine: CoordinatorEngine;
}

/**
 * Render an engine result into MCP tool-call content. For delegated execution
 * this is the "charter contract": the persona to adopt, the matched routing,
 * the framed dispatch request, and the state context — plus a machine-readable
 * JSON block and a required-next-action footer that reinforces Dispatch
 * Discipline (do not answer inline; dispatch the matched role).
 */
export function renderEngineResult(result: EngineResult): { content: { type: "text"; text: string }[] } {
  const routing = result.matchedRouting;
  const machine = JSON.stringify(
    {
      mode: result.kind,
      matchedRouting: routing,
      framedRequest: result.framedRequest,
      stateContext: result.stateContext,
    },
    null,
    2,
  );
  const councilLine =
    routing.council.length > 0 ? routing.council.join(", ") : "(none)";
  const text = [
    "<!-- hve-squad MCP delegated charter. This is NOT a finished answer. -->",
    "",
    "## systemPrompt (adopt this persona now)",
    "",
    result.systemPrompt,
    "",
    "## matchedRouting",
    "",
    `- intent: ${routing.routingIntent}`,
    `- role: ${routing.role}`,
    `- tier: ${routing.tier}`,
    `- parallel-eligible: ${routing.parallelEligible ? "yes" : "no"}`,
    `- council: ${councilLine}`,
    `- catch-all pipeline: ${routing.catchAll ? "yes" : "no"}`,
    `- gates: ${routing.gates ? "yes" : "no"}`,
    "",
    "## framedRequest",
    "",
    result.framedRequest,
    "",
    "## stateContext",
    "",
    result.stateContext,
    "",
    "## machine-readable",
    "",
    "```json",
    machine,
    "```",
    "",
    "## REQUIRED NEXT ACTION",
    "",
    "Do NOT answer the request yourself. Acting as the Squad Coordinator above,",
    "DISPATCH the matched role via your `runSubagent`/`task` tool against the",
    "framed request, then report back only after the subagent returns.",
  ].join("\n");

  return { content: [{ type: "text", text }] };
}

/** Build the server, router, and engine without binding a transport. */
export function createSquadServer(options: CreateServerOptions = {}): SquadServer {
  const catalog = options.catalog ?? loadCatalog();
  const router = new ToolRouter(catalog);
  const engine = options.engine ?? new DelegatedCoordinator();

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: router.listToolDescriptors(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = router.getTool(name);
    if (!tool) {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
    try {
      router.validateInput(name, args);
    } catch (error) {
      if (error instanceof ToolInputError) {
        throw new McpError(ErrorCode.InvalidParams, error.message);
      }
      throw error;
    }
    const coordinatorRequest = router.toCoordinatorRequest(tool, args);
    const result = await engine.handle(tool, coordinatorRequest);
    return renderEngineResult(result);
  });

  return { server, router, engine };
}

/** Start the server on stdio. */
export async function main(): Promise<void> {
  const { server, router, engine } = createSquadServer();
  await server.connect(createStdioTransport());
  process.stderr.write(
    `[${SERVER_NAME}] running on stdio (mode=${engine.mode}); ` +
      `tools: ${router.toolIds.join(", ")}\n`,
  );
}

// Run only when executed directly (not when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`[${SERVER_NAME}] fatal: ${String(error)}\n`);
    process.exit(1);
  });
}
