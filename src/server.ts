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
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { loadCatalog, type ToolCatalog } from "./catalog/catalog.js";
import type { CoordinatorEngine, EngineResult } from "./engine/coordinator-engine.js";
import { DelegatedCoordinator } from "./engine/delegated.js";
import { FileSquadMemoryStore } from "./engine/backends/file-squad-memory.js";
import {
  LOCAL_MEMORY_TENANT,
  SQUAD_MEMORY_URI_SCHEME,
  SquadMemoryResourceProvider,
  SquadMemorySubscriptionRegistry,
} from "./engine/squad-memory-resources.js";
import {
  isSafeMemoryPath,
  isSafeMemorySegment,
  type SquadMemoryStore,
} from "./engine/squad-memory-state.js";
import { SQUAD_MEMORY_SYNC_TOOL } from "./auth/scopes.js";
import { SQUAD_MEMORY_SYNC_DESCRIPTOR } from "./transports/http-core.js";
import { ToolInputError, ToolRouter } from "./router/router.js";
import { createStdioTransport } from "./transports/stdio.js";

export const SERVER_NAME = "hve-squad-mcp";
/**
 * The version reported in the MCP `initialize` handshake (`serverInfo.version`).
 *
 * Kept in step with `package.json` by a drift check in `test/generator.test.ts`
 * rather than read from disk at runtime: the runtime container image copies only
 * `dist/`, `tools.catalog.yml`, `generated/`, and the cast bundle — there is no
 * `package.json` beside them — so a runtime read would resolve differently in the
 * image than in development. A constant plus a failing test is the cheaper and
 * more honest guarantee.
 */
export const SERVER_VERSION = "0.2.9";

export interface CreateServerOptions {
  catalog?: ToolCatalog;
  engine?: CoordinatorEngine;
  /**
   * The shared-state memory broker store (shared-state broker — DR-01 / DR-10).
   * OPTIONAL and off by default: when provided, `createSquadServer` advertises the
   * `resources` capability and registers the read-only `resources/*` handlers,
   * delegating to a {@link SquadMemoryResourceProvider}. When omitted, the server
   * is byte-identical to the advisory-only default (no `resources` capability, no
   * handlers) — additive, so existing callers are unaffected.
   */
  memoryStore?: SquadMemoryStore;
}

export interface SquadServer {
  server: Server;
  router: ToolRouter;
  engine: CoordinatorEngine;
  /**
   * The stdio live-resource-push subscription registry (WI-01, stdio ONLY).
   * Present ONLY when a `memoryStore` was injected; otherwise `undefined` (no
   * `resources` surface is advertised at all). A memory write path calls its
   * `onWrite(uri)` hook to emit a single `notifications/resources/updated` to any
   * subscriber. Reusable by the Phase 4 `squad_memory_sync` tool.
   */
  memorySubscriptions?: SquadMemorySubscriptionRegistry;
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
  // Inject the optional memory broker into the delegated engine so the charter's
  // stateContext carries a bounded prior-context digest (Step 4.1). With no store
  // this is `{ memoryStore: undefined }` — byte-identical to the Phase 0 default.
  const engine = options.engine ?? new DelegatedCoordinator({ memoryStore: options.memoryStore });

  // The resource read surface is advertised + registered ONLY when a memory store
  // is injected (DR-10: never advertise an unbacked resource surface). With no
  // store the capabilities + handlers are byte-identical to the advisory default.
  // When a store IS injected on THIS (stdio) path, we additionally advertise
  // `resources.subscribe` (WI-01, stdio ONLY) so a duplex client (VS Code) can
  // watch a memory URI and receive `notifications/resources/updated` on a write.
  // The HTTP transport (`http-core.ts`) is POST-only and NEVER advertises this
  // (CON-1: Copilot Studio cannot consume a server stream — it stays poll-on-read).
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: options.memoryStore
        ? { tools: {}, resources: { subscribe: true } }
        : { tools: {} },
    },
  );

  // The stdio write-back tool (WI-02, Phase 4) + its live-push registry are wired
  // ONLY when a memory store is injected. `memorySubscriptions` is declared up
  // front so the CallTool handler below can call its `onWrite` hook after a
  // successful sync item; the resource block further down assigns it.
  const memoryStore = options.memoryStore;
  let memorySubscriptions: SquadMemorySubscriptionRegistry | undefined;

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    // The synthetic `squad_memory_sync` batch write-back tool is advertised ONLY
    // when a store is injected (DR-10: never advertise an unbacked tool); with no
    // store the list is byte-identical to the advisory-only default.
    tools: [
      ...router.listToolDescriptors(),
      ...(memoryStore ? [SQUAD_MEMORY_SYNC_DESCRIPTOR] : []),
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    // squad_memory_sync is the stdio batch write-back (WI-02). stdio is inside the
    // local trust boundary (no Entra token / scope check — the scope model is the
    // HTTP surface's), so it applies each item's CAS write keyed on the local
    // tenant sentinel and, after each SUCCESSFUL item, calls the subscription
    // registry's `onWrite` so a duplex subscriber gets exactly one
    // `notifications/resources/updated` per written entry. A stale expectedEtag on
    // one item is a per-item conflict that never aborts the rest of the batch.
    if (memoryStore && name === SQUAD_MEMORY_SYNC_TOOL) {
      const record = (args as Record<string, unknown> | undefined) ?? {};
      const project = typeof record.project === "string" ? record.project : "";
      if (!isSafeMemorySegment(project)) {
        throw new McpError(ErrorCode.InvalidParams, "squad_memory_sync requires a safe 'project'.");
      }
      const items = Array.isArray(record.items) ? record.items : undefined;
      if (!items) {
        throw new McpError(ErrorCode.InvalidParams, "squad_memory_sync requires an 'items' array.");
      }
      const results: { path: string; ok: boolean; etag?: string; conflict?: boolean }[] = [];
      for (const raw of items) {
        const item = (raw as Record<string, unknown> | undefined) ?? {};
        const itemPath = typeof item.path === "string" ? item.path : "";
        const content = typeof item.content === "string" ? item.content : undefined;
        const expectedEtag = typeof item.expectedEtag === "string" ? item.expectedEtag : undefined;
        // SEC-4 traversal guard + shape-check BEFORE the store; a bad item fails
        // that ONE item only and never aborts the rest of the batch.
        if (!isSafeMemoryPath(itemPath) || content === undefined) {
          results.push({ path: itemPath, ok: false });
          continue;
        }
        const result = await memoryStore.write(LOCAL_MEMORY_TENANT, project, itemPath, content, expectedEtag);
        if (result.ok) {
          results.push({ path: itemPath, ok: true, etag: result.etag });
          // Exactly one update notification per successfully-written entry, only
          // for a subscribed URI (the registry no-ops an unwatched URI).
          await memorySubscriptions?.onWrite(`${SQUAD_MEMORY_URI_SCHEME}://${project}/${itemPath}`);
        } else {
          results.push({ path: itemPath, ok: false, conflict: true });
        }
      }
      return { content: [{ type: "text", text: JSON.stringify({ project, results }, null, 2) }] };
    }

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

  // Shared read surface: the SAME provider serves stdio here and HTTP in
  // `http-core.ts`. stdio is inside the local trust boundary, so the tenant is the
  // local sentinel (no Entra token to resolve one from); the write-back tools are
  // the synthetic `squad_memory_sync` above (MCP resources themselves are read-only).
  if (memoryStore) {
    const resources = new SquadMemoryResourceProvider(memoryStore);
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: await resources.list(LOCAL_MEMORY_TENANT),
    }));
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => ({
      contents: (await resources.read(LOCAL_MEMORY_TENANT, request.params.uri)).contents,
    }));
    server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({
      resourceTemplates: resources.templates(),
    }));

    // Live resource push (WI-01, stdio ONLY). The registry tracks watched URIs;
    // its `onWrite(uri)` hook (called by a memory write path — a future stdio
    // write tool / the Phase 4 `squad_memory_sync`) emits a single
    // `notifications/resources/updated` over the duplex stdio transport for a
    // subscribed URI. `sendResourceUpdated` is the SDK helper for exactly that
    // method; the advertised `resources.subscribe` capability authorizes it.
    memorySubscriptions = new SquadMemorySubscriptionRegistry((uri) => server.sendResourceUpdated({ uri }));
    server.setRequestHandler(SubscribeRequestSchema, (request) => {
      memorySubscriptions?.subscribe(request.params.uri);
      return {};
    });
    server.setRequestHandler(UnsubscribeRequestSchema, (request) => {
      memorySubscriptions?.unsubscribe(request.params.uri);
      return {};
    });
  }

  return { server, router, engine, memorySubscriptions };
}

/** Start the server on stdio. */
export async function main(): Promise<void> {
  // Optional local memory broker: when `SQUAD_MCP_MEMORY_DIR` is set, back the
  // stdio read surface with a file store; when unset, stdio stays a no-op (no
  // `resources` advertised) — DR-10 (no unbacked resource surface).
  const memoryDir = (process.env.SQUAD_MCP_MEMORY_DIR ?? "").trim();
  const memoryStore = memoryDir.length > 0 ? new FileSquadMemoryStore({ baseDir: memoryDir }) : undefined;
  const { server, router, engine } = createSquadServer({ memoryStore });
  await server.connect(createStdioTransport());
  process.stderr.write(
    `[${SERVER_NAME}] running on stdio (mode=${engine.mode}); ` +
      `tools: ${router.toolIds.join(", ")}` +
      `${memoryStore ? "; resources: squad-memory" : ""}\n`,
  );
}

// Run only when executed directly (not when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`[${SERVER_NAME}] fatal: ${String(error)}\n`);
    process.exit(1);
  });
}
