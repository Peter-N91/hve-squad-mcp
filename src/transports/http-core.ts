/**
 * Streamable HTTP `/mcp` core handler (SEC-8, SEC-1, SEC-2, PROD-1).
 *
 * A transport-pure handler: it takes a plain request shape and returns a plain
 * response shape, so the entire remote surface — Origin/CORS handling, Entra
 * auth, identity-bound sessions, per-tool scope gating, the hero-tool filter, and
 * JSON-RPC routing into the embedded engine — is unit-testable in-process with no
 * socket, no network, and no live Azure. The socket binding (`http.ts`) is a thin
 * adapter over this.
 *
 * Security ordering (each gate runs before the next does any work):
 *   1. Path + method shape.
 *   2. SEC-8 — Origin allow-list (strict; never `*`) and CORS (echoes the specific
 *      Origin, never wildcard-with-credentials).
 *   3. SEC-1 — Entra auth: no anonymous `/mcp`; audience-bound token.
 *   4. SEC-8 — identity-bound session id for every non-initialize request.
 *   5. PROD-1 — only the hero tools are listed/callable over HTTP.
 *   6. SEC-2 — per-tool scope authorization before dispatch.
 *
 * HTTPS is assumed to be terminated at the Container App ingress (the deployment
 * is HTTPS-only); this handler never serves plaintext and emits no protocol over
 * a non-TLS listener (see `http.ts`).
 */
import {
  isAdvisoryExposed,
  isRemotelyExposed,
  isMemoryExposed,
  SQUAD_STATUS_TOOL,
  SQUAD_RENDER_PPTX_TOOL,
  SQUAD_MEMORY_READ_TOOL,
  SQUAD_HISTORY_TOOL,
  SQUAD_MEMORY_WRITE_TOOL,
  SQUAD_MEMORY_SYNC_TOOL,
  SQUAD_FEDERATE_TOOL,
  SQUAD_BUSINESS_PLAN_TOOL,
  SQUAD_BACKLOG_TOOL,
  isBusinessExposed,
} from "../auth/scopes.js";
import { AuthError, type AuthContext, type EntraAuthenticator } from "../auth/entra.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { ToolInputError, type ToolRouter } from "../router/router.js";
import { renderEmbeddedResult } from "../engine/render-embedded.js";
import { SERVER_NAME, SERVER_VERSION } from "../server.js";
import type { EmbeddedCoordinator } from "../engine/embedded.js";
import type { PptxRenderService } from "../engine/render/pptx-render-service.js";
import { SquadMemoryResourceProvider } from "../engine/squad-memory-resources.js";
import { isSafeMemoryPath, type SquadMemoryStore } from "../engine/squad-memory-state.js";
import { MemoryBackedArtifactStore } from "../engine/artifact-store.js";
import { SquadHistory } from "../engine/squad-history.js";
import {
  asTargetedStore,
  UnknownMemoryTargetError,
  type TargetedSquadMemoryStore,
} from "../engine/targeted-squad-memory.js";
import { businessToolSpec } from "../engine/business-tools.js";
import { BacklogContractError, parseBacklog } from "../engine/backlog-contract.js";
import type { RedactingLogger } from "../observability/logger.js";
import type { SessionStore } from "./session-store.js";

/** The MCP protocol revision this server speaks. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/**
 * Synthetic `tools/list` descriptor for the status-poll utility. `squad_status`
 * is a transport-level utility (poll a run by id), not a squad routing intent, so
 * it lives here rather than in `tools.catalog.yml` (keeping the catalog = the five
 * routing tools and the generator drift-check clean).
 */
const SQUAD_STATUS_DESCRIPTOR = {
  name: SQUAD_STATUS_TOOL,
  title: "Squad Status",
  description:
    "Poll an async squad run by its run id and return its status; when the run " +
    "is complete, return the finished squad-guided artifact.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["runId"],
    properties: {
      runId: {
        type: "string",
        description: "The server-allocated run id returned by squad_run.",
      },
    },
  },
};

/**
 * Synthetic `tools/list` descriptor for the deterministic render tool. Like
 * `squad_status`, `squad_render_pptx` is a transport-level utility rather than a
 * squad routing intent, so it lives here rather than in `tools.catalog.yml`
 * (keeping the catalog = the five routing tools and the generator drift-check
 * clean). Served only when the operator enabled the render feature.
 */
const SQUAD_RENDER_PPTX_DESCRIPTOR = {
  name: SQUAD_RENDER_PPTX_TOOL,
  title: "Squad Render PPTX",
  description:
    "Render a PowerPoint deck from content YAML and style YAML and return a " +
    "short-lived download link to the generated .pptx file. Deterministic: no " +
    "model call, no impactful action.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["contentYaml", "styleYaml"],
    properties: {
      contentYaml: {
        type: "string",
        description:
          "A YAML document with a top-level 'slides:' array; each item is one " +
          "slide's content definition.",
      },
      styleYaml: {
        type: "string",
        description: "The global style.yaml body (dimensions, layouts, defaults).",
      },
    },
  },
};

/**
 * Shape guard for the `project` partition input (a single lowercase dns-ish
 * label). It is the single source of truth for BOTH the synthetic descriptors'
 * JSON Schema `pattern` (via `.source`) and the runtime shape-check in
 * {@link HttpMcpHandler.handleToolCall}, so a caller-supplied `project` can never
 * escape its `tenantId:project` partition (SEC-3 / SEC-4).
 */
const MEMORY_PROJECT_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * The optional named-destination selector shared by every memory tool descriptor.
 *
 * Trust model: the caller may only SELECT among destinations the operator
 * declared (`SQUAD_MCP_MEMORY_TARGETS`) — it can never supply a drive id, a
 * storage account, or a path root. An unknown name is rejected before any I/O.
 * On a deployment that declared no targets the input is accepted and ignored, so
 * the same connector works against both shapes.
 */
const MEMORY_TARGET_PROPERTY = {
  type: "string",
  pattern: "^[a-z0-9][a-z0-9-]{0,63}$",
  description:
    "Optional operator-declared storage destination to use (for example a SharePoint " +
    "library). Omit to use the deployment's default destination.",
} as const;

/**
 * The JSON-RPC error code returned when `squad_memory_write` loses a
 * compare-and-swap race. It sits in the application-defined JSON-RPC server range
 * (-32000..-32099), deliberately away from the SDK's reserved -32000
 * (ConnectionClosed) / -32001 (RequestTimeout). The error `data` carries the
 * current etag so the caller can re-read and retry rather than silently clobber a
 * concurrent writer (DR-01).
 */
const MEMORY_CAS_CONFLICT_CODE = -32010;

/**
 * Synthetic `tools/list` descriptor for the shared-state broker WRITE-back tool
 * (DR-01). Like `squad_status` / `squad_render_pptx`, `squad_memory_write` is a
 * transport-level utility rather than a squad routing intent, so it lives here
 * (not in `tools.catalog.yml`, keeping the catalog = the five routing tools and
 * the generator drift-check clean). It performs a compare-and-swap write of the
 * caller's own `tenantId:project` memory and is served only when the operator
 * enabled the memory feature. Deterministic: no model call, no impactful action.
 */
const SQUAD_MEMORY_WRITE_DESCRIPTOR = {
  name: SQUAD_MEMORY_WRITE_TOOL,
  title: "Squad Memory Write",
  description:
    "Write (create or replace) one entry of the project's own squad memory under " +
    "compare-and-swap and return the new etag. Pass the prior etag as expectedEtag " +
    "to guard against clobbering a concurrent writer; omit it for a first write. " +
    "Deterministic: no model call, no impactful action.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["project", "path", "content"],
    properties: {
      project: {
        type: "string",
        pattern: MEMORY_PROJECT_PATTERN.source,
        description: "The project namespace within your tenant (lowercase dns-ish label).",
      },
      path: {
        type: "string",
        description: "The logical memory path (e.g. 'state', 'decisions', 'history/<agent>').",
      },
      content: {
        type: "string",
        description: "The full new content to persist at 'path'.",
      },
      expectedEtag: {
        type: "string",
        description: "The etag from the prior read/write; the write applies only if it still matches.",
      },
      target: MEMORY_TARGET_PROPERTY,
    },
  },
};

/**
 * Synthetic `tools/list` descriptor for the shared-state broker READ tool. It is
 * the tool-shaped read of a single memory entry (the `resources/read` surface
 * reads the same store; the tool exists so connectors that only speak tools/call
 * can read too). Same synthetic posture and feature-gating as
 * {@link SQUAD_MEMORY_WRITE_DESCRIPTOR}.
 */
const SQUAD_MEMORY_READ_DESCRIPTOR = {
  name: SQUAD_MEMORY_READ_TOOL,
  title: "Squad Memory Read",
  description:
    "Read one entry of the project's own squad memory and return its content and " +
    "etag (the etag to pass as expectedEtag on a subsequent write). Deterministic: " +
    "no model call, no impactful action.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["project", "path"],
    properties: {
      project: {
        type: "string",
        pattern: MEMORY_PROJECT_PATTERN.source,
        description: "The project namespace within your tenant (lowercase dns-ish label).",
      },
      path: {
        type: "string",
        description: "The logical memory path (e.g. 'state', 'decisions', 'history/<agent>').",
      },
      target: MEMORY_TARGET_PROPERTY,
    },
  },
};

/**
 * Synthetic `tools/list` descriptor for reading a run's own history back.
 *
 * The memory tools read KEYS a caller must already know. This reads the TREE a
 * run wrote — the plans, the PRD, the deck pointer, the backlog, the per-agent
 * history — which is what makes a run auditable after the fact rather than only
 * resumable. Deterministic: no model call, no impactful action.
 */
const SQUAD_HISTORY_DESCRIPTOR = {
  name: SQUAD_HISTORY_TOOL,
  title: "Squad History",
  description:
    "Browse and open what previous squad runs produced for a project: the squad " +
    "state, each role's deliverables, and the per-agent history. Use op='index' for " +
    "a compact picture of what exists, op='list' to enumerate a directory, and " +
    "op='read' to open one artifact. Deterministic: no model call, no impactful action.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["project"],
    properties: {
      project: {
        type: "string",
        pattern: MEMORY_PROJECT_PATTERN.source,
        description: "The project namespace within your tenant (lowercase dns-ish label).",
      },
      op: {
        type: "string",
        enum: ["index", "list", "read"],
        description: "index (default) summarizes; list enumerates a prefix; read opens one path.",
      },
      prefix: {
        type: "string",
        description: "For op='list': a directory such as '.copilot-tracking/plans'.",
      },
      path: {
        type: "string",
        description: "For op='read': the artifact path from a list result.",
      },
    },
  },
};

/**
 * Synthetic `tools/list` descriptor for the shared-state broker BATCH write-back
 * tool (WI-02 — assisted delegated write-back). Like `squad_memory_write` it is a
 * transport-level utility (not a squad routing intent), served only when the
 * operator enabled the memory feature, and carries the SAME Squad.MemoryWrite
 * scope. It applies each item under its OWN compare-and-swap: a stale
 * `expectedEtag` on one item is reported as a per-item conflict WITHOUT aborting
 * the rest, so a delegated host can flush a whole run's `.copilot-tracking/squad/`
 * artifacts in one call and reconcile only the entries that lost a race.
 * Deterministic: no model call, no impactful action.
 */
export const SQUAD_MEMORY_SYNC_DESCRIPTOR = {
  name: SQUAD_MEMORY_SYNC_TOOL,
  title: "Squad Memory Sync",
  description:
    "Flush a batch of the project's own squad-memory entries in one call. Each item " +
    "is written under its own compare-and-swap; pass the prior etag as expectedEtag to " +
    "guard against clobbering a concurrent writer (omit it for a first write). A stale " +
    "expectedEtag on one item is reported as a conflict in the results without aborting " +
    "the others. Returns a per-item result array. Deterministic: no model call, no " +
    "impactful action.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["project", "items"],
    properties: {
      project: {
        type: "string",
        pattern: MEMORY_PROJECT_PATTERN.source,
        description: "The project namespace within your tenant (lowercase dns-ish label).",
      },
      items: {
        type: "array",
        description: "The batch of memory entries to write; each is applied under its own CAS.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["path", "content"],
          properties: {
            path: {
              type: "string",
              description: "The logical memory path (e.g. 'state', 'decisions', 'history/<agent>').",
            },
            content: {
              type: "string",
              description: "The full new content to persist at 'path'.",
            },
            expectedEtag: {
              type: "string",
              description:
                "The etag from the prior read/write; this item applies only if it still matches.",
            },
          },
        },
      },
      target: MEMORY_TARGET_PROPERTY,
    },
  },
};

/**
 * Synthetic `tools/list` descriptor for the BUSINESS-PLAN tool. Business-facing
 * counterpart of the engineering advisory tools: one embedded dispatch against the
 * BRD Builder persona, returning a fixed-section business plan written
 * for a non-technical stakeholder. Advisory only — no impactful action.
 */
const SQUAD_BUSINESS_PLAN_DESCRIPTOR = {
  name: SQUAD_BUSINESS_PLAN_TOOL,
  title: "Squad Business Plan",
  description:
    "Turn an idea, brief, or opportunity into a decision-ready business plan written " +
    "in plain language for a non-technical stakeholder: summary, problem and customer, " +
    "proposed solution, value and success measures, scope, go-to-market, cost outline, " +
    "risks, milestones, and open questions. Advisory text only — nothing is created or " +
    "changed in any system.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["request"],
    properties: {
      request: {
        type: "string",
        minLength: 1,
        description: "The idea, brief, or opportunity to turn into a business plan.",
      },
      context: {
        type: "string",
        description: "Optional background: constraints, budget, audience, prior decisions.",
      },
      squad: {
        type: "string",
        pattern: MEMORY_PROJECT_PATTERN.source,
        description: "Optional federation sub-squad / workstream name; also scopes squad memory.",
      },
    },
  },
};

/**
 * Synthetic `tools/list` descriptor for the STRUCTURED BACKLOG tool. Its result is
 * a validated JSON contract (`epics → stories → tasks` plus a flattened
 * `workItems[]` with stable `ref` / `parentRef`), designed to be looped ONE ITEM
 * PER CALL into the native Azure DevOps / Jira connector. This server performs no
 * ADO/Jira write itself (ADR-0001) — it produces the plan the certified connector
 * executes on the end user's own connection.
 */
const SQUAD_BACKLOG_DESCRIPTOR = {
  name: SQUAD_BACKLOG_TOOL,
  title: "Squad Backlog",
  description:
    "Turn a request, business plan, or requirements document into a structured delivery " +
    "backlog and return it as JSON: epics, user stories with Given/When/Then acceptance " +
    "criteria, and tasks, plus a flattened 'workItems' array with stable 'ref'/'parentRef' " +
    "ids. Create the items by calling the Azure DevOps or Jira connector once per element " +
    "of 'workItems', parents first, linking children by 'parentRef'. This tool only plans — " +
    "it writes nothing to Azure DevOps or Jira.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["request"],
    properties: {
      request: {
        type: "string",
        minLength: 1,
        description: "The work, business plan, or requirements to break down into a backlog.",
      },
      context: {
        type: "string",
        description: "Optional background: existing backlog, constraints, definition of done.",
      },
      squad: {
        type: "string",
        pattern: MEMORY_PROJECT_PATTERN.source,
        description: "Optional federation sub-squad / workstream name; also scopes squad memory.",
      },
    },
  },
};

/** A transport-agnostic request (headers keyed lowercase; body pre-parsed JSON). */
export interface HttpRequestLike {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  body?: unknown;
}

/** A transport-agnostic response (body is JSON-serializable). */
export interface HttpResponseLike {
  status: number;
  headers: Record<string, string>;
  body?: unknown;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: string | number | null | undefined, result: unknown): unknown {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function rpcError(id: string | number | null | undefined, code: number, message: string, data?: unknown): unknown {
  const error: { code: number; message: string; data?: unknown } = { code, message };
  if (data !== undefined) {
    error.data = data;
  }
  return { jsonrpc: "2.0", id: id ?? null, error };
}

function asJsonRpc(body: unknown): JsonRpcRequest | undefined {
  if (!body || typeof body !== "object") {
    return undefined;
  }
  const candidate = body as Record<string, unknown>;
  if (candidate.jsonrpc !== "2.0" || typeof candidate.method !== "string") {
    return undefined;
  }
  return candidate as unknown as JsonRpcRequest;
}

export interface HttpMcpHandlerDeps {
  router: ToolRouter;
  authenticator: EntraAuthenticator;
  embedded: EmbeddedCoordinator;
  sessions: SessionStore;
  /** Strict Origin allow-list (SEC-8); never contains `*`. */
  allowedOrigins: string[];
  logger: RedactingLogger;
  /**
   * Whether the gated async pipeline (`squad_run` + `squad_status`) is exposed.
   * Default FALSE (hero-only): the pipeline surface is served only when the
   * operator has enabled it with a durable run-state + approval backend (HIGH-1).
   */
  pipelineExposed?: boolean;
  /**
   * The deterministic PPTX render service. Present only when the operator enabled
   * the render feature (`enableRenderPptx`); when absent, `squad_render_pptx` is
   * hidden from tools/list and rejected on call (like a disabled pipeline tool).
   */
  renderService?: PptxRenderService;
  /**
   * The shared-state memory broker store. Present only when the operator enabled
   * the memory feature (`enableMemory`); when absent, the resource read surface
   * and the `squad_memory_*` tools are not served (the advisory-only default).
   * Kept OPTIONAL so existing construction is unaffected (additive; the resource
   * surface + memory tools are wired in later phases).
   */
  memoryStore?: SquadMemoryStore;
  /** Whether the squad ledger is enabled, which is what `squad_history` reads. */
  artifactsEnabled?: boolean;
  /**
   * Whether the business-facing tools (`squad_business_plan`, `squad_backlog`) are
   * served. Default FALSE. They are advisory (one embedded dispatch, no impactful
   * action), so exposure is a product decision rather than a security one — but it
   * is still explicit, so the default remote surface is unchanged.
   */
  businessToolsExposed?: boolean;
}

export class HttpMcpHandler {
  private readonly router: ToolRouter;
  private readonly authenticator: EntraAuthenticator;
  private readonly embedded: EmbeddedCoordinator;
  private readonly sessions: SessionStore;
  private readonly allowedOrigins: Set<string>;
  private readonly logger: RedactingLogger;
  private readonly pipelineExposed: boolean;
  private readonly renderService?: PptxRenderService;
  private readonly memoryStore?: SquadMemoryStore;
  private readonly businessToolsExposed: boolean;
  /**
   * The named-destination view of {@link memoryStore}, present only when the
   * operator declared a target allow-list. When absent the memory tools' `target`
   * input is simply ignored (a single-destination deployment).
   */
  private readonly memoryTargets?: TargetedSquadMemoryStore;
  /**
   * The shared read surface over {@link memoryStore}. Constructed only when a
   * store was injected, so it is the single source of truth for
   * `memoryBrokerEnabled` and the `resources/*` cases (same provider the stdio
   * transport uses in `server.ts`).
   */
  private readonly memoryResources?: SquadMemoryResourceProvider;
  /**
   * Read-only browsing over the `.copilot-tracking` tree a run wrote. Present
   * only when the operator enabled the artifact ledger — without it there is no
   * tree to browse, and advertising the tool would promise an empty answer.
   */
  private readonly history?: SquadHistory;

  constructor(deps: HttpMcpHandlerDeps) {
    this.router = deps.router;
    this.authenticator = deps.authenticator;
    this.embedded = deps.embedded;
    this.sessions = deps.sessions;
    this.allowedOrigins = new Set(deps.allowedOrigins);
    this.logger = deps.logger;
    this.pipelineExposed = deps.pipelineExposed ?? false;
    this.renderService = deps.renderService;
    this.memoryStore = deps.memoryStore;
    this.businessToolsExposed = deps.businessToolsExposed ?? false;
    this.memoryTargets = asTargetedStore(deps.memoryStore);
    this.memoryResources = deps.memoryStore
      ? new SquadMemoryResourceProvider(deps.memoryStore)
      : undefined;
    this.history =
      deps.artifactsEnabled && deps.memoryStore
        ? new SquadHistory(new MemoryBackedArtifactStore(deps.memoryStore))
        : undefined;
  }

  /**
   * Whether the shared-state memory broker is active on this handler. True only
   * when the operator enabled the feature and a backing store was injected; later
   * phases serve the resource read surface and the `squad_memory_*` tools when
   * this is true (advisory-only default when false).
   */
  get memoryBrokerEnabled(): boolean {
    return this.memoryStore !== undefined;
  }

  /**
   * Whether a tool is reachable over HTTP. The advisory tools (the hero tools
   * plus `squad_plan` / `squad_architect`) are always exposed; the gated pipeline
   * (`squad_run`/`squad_status`) only when `pipelineExposed` (the operator opted
   * in with a durable backend). Default posture is advisory-only.
   */
  private isExposed(name: string): boolean {
    return this.pipelineExposed ? isRemotelyExposed(name) : isAdvisoryExposed(name);
  }

  private originAllowed(origin: string | undefined): boolean {
    // No Origin header => non-browser caller (e.g. a cloud connector); allowed.
    // An Origin header present must be on the strict allow-list (DNS-rebinding defense).
    return origin === undefined || this.allowedOrigins.has(origin);
  }

  private corsHeaders(origin: string | undefined): Record<string, string> {
    if (origin === undefined || !this.allowedOrigins.has(origin)) {
      return {};
    }
    // Echo the specific Origin (never `*`), and do NOT set Allow-Credentials —
    // auth is a bearer header, not a cookie, so wildcard-with-credentials is avoided.
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Session-Id, MCP-Protocol-Version",
      Vary: "Origin",
    };
  }

  async handle(req: HttpRequestLike): Promise<HttpResponseLike> {
    const origin = req.headers["origin"];
    const cors = this.corsHeaders(origin);

    // Out-of-band operator approval route (SEC-6). It is deliberately OFF the MCP
    // JSON-RPC surface — not in tools/list, not a tools/call — so neither a caller
    // nor model output can reach it; only an operator with the distinct approval
    // scope may release a held run through it.
    if (req.path === "/admin/approve") {
      return this.handleAdminApprove(req, origin, cors);
    }

    if (req.path !== "/mcp") {
      return { status: 404, headers: { "content-type": "application/json" }, body: { error: "not_found" } };
    }

    // CORS preflight.
    if (req.method === "OPTIONS") {
      if (!this.originAllowed(origin)) {
        return { status: 403, headers: {}, body: { error: "origin_not_allowed" } };
      }
      return { status: 204, headers: cors };
    }

    // SEC-8: strict Origin allow-list for actual requests.
    if (!this.originAllowed(origin)) {
      return { status: 403, headers: cors, body: { error: "origin_not_allowed" } };
    }

    // SEC-1: authenticate every request (no anonymous /mcp).
    let auth: AuthContext;
    try {
      auth = await this.authenticator.authenticate(req.headers["authorization"]);
    } catch (error) {
      if (error instanceof AuthError) {
        return { status: error.status, headers: cors, body: { error: error.reason } };
      }
      throw error;
    }

    const baseHeaders: Record<string, string> = {
      "content-type": "application/json",
      "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
      ...cors,
    };

    if (req.method === "DELETE") {
      this.sessions.delete(req.headers["mcp-session-id"]);
      return { status: 204, headers: baseHeaders };
    }

    if (req.method === "GET") {
      // The thin slice's hero tools are request/response; no server-initiated SSE stream.
      return {
        status: 405,
        headers: { ...baseHeaders, Allow: "POST, DELETE, OPTIONS" },
        body: rpcError(null, -32601, "Server-initiated streaming is not offered in the thin slice."),
      };
    }

    if (req.method !== "POST") {
      return { status: 405, headers: { ...baseHeaders, Allow: "POST, DELETE, OPTIONS" } };
    }

    const message = asJsonRpc(req.body);
    if (!message) {
      return { status: 400, headers: baseHeaders, body: rpcError(null, -32700, "Invalid JSON-RPC request.") };
    }

    // Notifications carry no id and expect no response body.
    if (message.id === undefined && message.method.startsWith("notifications/")) {
      return { status: 202, headers: baseHeaders };
    }

    if (message.method === "initialize") {
      const session = this.sessions.create(auth);
      return {
        status: 200,
        headers: { ...baseHeaders, "Mcp-Session-Id": session.id },
        body: rpcResult(message.id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          // Advertise `resources` ONLY when the memory broker is active; the
          // advisory-only default is byte-identical to before (DR-01 / DR-10).
          capabilities: this.memoryBrokerEnabled ? { tools: {}, resources: {} } : { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        }),
      };
    }

    // Every non-initialize request requires a valid, identity-bound session (SEC-8).
    if (!this.sessions.validate(req.headers["mcp-session-id"], auth)) {
      return {
        status: 404,
        headers: baseHeaders,
        body: rpcError(message.id, -32600, "Missing or invalid session; re-initialize."),
      };
    }

    switch (message.method) {
      case "ping":
        return { status: 200, headers: baseHeaders, body: rpcResult(message.id, {}) };
      case "tools/list":
        return {
          status: 200,
          headers: baseHeaders,
          body: rpcResult(message.id, {
            // PROD-1: the advisory tools always; the gated async pipeline (squad_run +
            // squad_status) only when the operator enabled it (pipelineExposed).
            tools: [
              ...this.router.listToolDescriptors().filter((descriptor) => this.isExposed(descriptor.name)),
              ...(this.pipelineExposed ? [SQUAD_STATUS_DESCRIPTOR] : []),
              ...(this.renderService ? [SQUAD_RENDER_PPTX_DESCRIPTOR] : []),
              // The memory broker tools appear ONLY when the operator enabled the
              // feature (a backing store injected); `isMemoryExposed` keeps the
              // projection to the classified memory tools (advisory-only default
              // is byte-identical to before).
              ...(this.memoryBrokerEnabled
                ? [
                    SQUAD_MEMORY_READ_DESCRIPTOR,
                    SQUAD_MEMORY_WRITE_DESCRIPTOR,
                    SQUAD_MEMORY_SYNC_DESCRIPTOR,
                    ...(this.history ? [SQUAD_HISTORY_DESCRIPTOR] : []),
                  ].filter((descriptor) => isMemoryExposed(descriptor.name))
                : []),
              // The business-facing tools appear ONLY when the operator enabled
              // them; the default remote surface is unchanged.
              ...(this.businessToolsExposed
                ? [SQUAD_BUSINESS_PLAN_DESCRIPTOR, SQUAD_BACKLOG_DESCRIPTOR].filter((descriptor) =>
                    isBusinessExposed(descriptor.name),
                  )
                : []),
            ],
          }),
        };
      case "tools/call":
        return this.handleToolCall(message, auth, baseHeaders);
      case "resources/list":
      case "resources/read":
      case "resources/templates/list":
        return this.handleResources(message, auth, baseHeaders);
      default:
        return {
          status: 200,
          headers: baseHeaders,
          body: rpcError(message.id, -32601, `Method not found: ${message.method}`),
        };
    }
  }

  /**
   * Out-of-band operator approval endpoint (`POST /admin/approve`). Releases a HELD
   * run so the async pipeline can proceed. This is the production caller of the
   * approval channel and the keystone that makes a deployed held `squad_run`
   * releasable. Security posture:
   *
   *   * SEC-6 — off the model/caller surface. It is not an MCP tool, not listed in
   *     tools/list, and not in the connector manifest; no `request`/`context` or
   *     model output can reach it. Only served when the operator enabled the gated
   *     pipeline (`pipelineExposed`); otherwise it 404s (the route is not revealed).
   *   * SEC-1 — authenticated (no anonymous release); SEC-8 — strict Origin
   *     allow-list. It requires NO MCP session (an operator action, not a caller
   *     conversation).
   *   * Distinct operator scope — `authorizeApproval` requires `Squad.Operate`, not
   *     `Squad.Run`, so a caller that may start/poll a run still cannot approve it.
   *   * Tenant-scoped — the engine releases only a run owned by the operator's
   *     tenant; an unknown or cross-tenant run id is denied with no leakage.
   */
  private async handleAdminApprove(
    req: HttpRequestLike,
    origin: string | undefined,
    cors: Record<string, string>,
  ): Promise<HttpResponseLike> {
    // Route exists only when the gated pipeline is exposed; otherwise do not reveal it.
    if (!this.pipelineExposed) {
      return { status: 404, headers: { "content-type": "application/json" }, body: { error: "not_found" } };
    }

    // SEC-8: strict Origin allow-list (CORS preflight answered without auth).
    if (req.method === "OPTIONS") {
      if (!this.originAllowed(origin)) {
        return { status: 403, headers: {}, body: { error: "origin_not_allowed" } };
      }
      return { status: 204, headers: { ...cors, "Access-Control-Allow-Methods": "POST, OPTIONS" } };
    }
    if (!this.originAllowed(origin)) {
      return { status: 403, headers: cors, body: { error: "origin_not_allowed" } };
    }
    if (req.method !== "POST") {
      return { status: 405, headers: { ...cors, Allow: "POST, OPTIONS" }, body: { error: "method_not_allowed" } };
    }

    const baseHeaders: Record<string, string> = { "content-type": "application/json", ...cors };

    // SEC-1: authenticate the operator (no anonymous release).
    let auth: AuthContext;
    try {
      auth = await this.authenticator.authenticate(req.headers["authorization"]);
    } catch (error) {
      if (error instanceof AuthError) {
        return { status: error.status, headers: baseHeaders, body: { error: error.reason } };
      }
      throw error;
    }

    // Distinct high-privilege operator scope (NOT Squad.Run).
    try {
      this.authenticator.authorizeApproval(auth);
    } catch (error) {
      if (error instanceof AuthError) {
        return { status: error.status, headers: baseHeaders, body: { error: error.reason } };
      }
      throw error;
    }

    const runId =
      typeof (req.body as Record<string, unknown> | undefined)?.runId === "string"
        ? ((req.body as Record<string, unknown>).runId as string)
        : "";
    if (runId.length === 0) {
      return { status: 400, headers: baseHeaders, body: { error: "invalid_run_id" } };
    }

    try {
      // Tenant-scoped release; records approver + timestamp via the auditable channel.
      const result = await this.embedded.approveRun(runId, { auth });
      if (!result.ok) {
        // No leakage: unknown vs cross-tenant are indistinguishable to the operator.
        return { status: 404, headers: baseHeaders, body: { error: result.reason } };
      }
      return {
        status: 200,
        headers: baseHeaders,
        body: { approved: true, runId, approver: result.record.approver, at: result.record.at },
      };
    } catch (error) {
      this.logger.error("operator approval failed", { error: String(error) });
      return { status: 500, headers: baseHeaders, body: { error: "internal_error" } };
    }
  }

  /**
   * Handle the read-only `resources/*` surface (shared-state broker — DR-01 /
   * DR-04). Security ordering mirrors `tools/call`:
   *   1. Method-not-found when the broker is off (advisory-only default), so a
   *      token that never enabled memory sees NO resource surface at all.
   *   2. SEC-2 default-deny — require the `Squad.Memory` read scope BEFORE any
   *      store read (a token missing it is denied via the existing authorizer).
   *   3. Delegate to the shared {@link SquadMemoryResourceProvider}, keyed on
   *      `auth.tenantId` from the validated Entra token — NEVER caller input
   *      (SEC-3 tenant isolation).
   *
   * An unknown/malformed URI or a missing entry surfaces the provider's single
   * generic {@link McpError} (no leakage); any other failure is logged scrubbed
   * and returned as a generic internal error.
   */
  private async handleResources(
    message: JsonRpcRequest,
    auth: AuthContext,
    baseHeaders: Record<string, string>,
  ): Promise<HttpResponseLike> {
    if (!this.memoryResources) {
      return {
        status: 200,
        headers: baseHeaders,
        body: rpcError(message.id, -32601, `Method not found: ${message.method}`),
      };
    }

    // SEC-2: fail-closed on the Squad.Memory read scope BEFORE any store read.
    try {
      this.authenticator.authorizeTool(auth, SQUAD_MEMORY_READ_TOOL);
    } catch (error) {
      if (error instanceof AuthError) {
        return { status: error.status, headers: baseHeaders, body: { error: error.reason } };
      }
      throw error;
    }

    try {
      switch (message.method) {
        case "resources/list": {
          const resources = await this.memoryResources.list(auth.tenantId);
          return { status: 200, headers: baseHeaders, body: rpcResult(message.id, { resources }) };
        }
        case "resources/templates/list": {
          const resourceTemplates = this.memoryResources.templates();
          return { status: 200, headers: baseHeaders, body: rpcResult(message.id, { resourceTemplates }) };
        }
        case "resources/read": {
          const uri =
            typeof (message.params as Record<string, unknown> | undefined)?.uri === "string"
              ? ((message.params as Record<string, unknown>).uri as string)
              : "";
          const result = await this.memoryResources.read(auth.tenantId, uri);
          return { status: 200, headers: baseHeaders, body: rpcResult(message.id, result) };
        }
        default:
          return {
            status: 200,
            headers: baseHeaders,
            body: rpcError(message.id, -32601, `Method not found: ${message.method}`),
          };
      }
    } catch (error) {
      if (error instanceof McpError) {
        // Provider errors are already generic (no-leakage) — pass code + message.
        return { status: 200, headers: baseHeaders, body: rpcError(message.id, error.code, error.message) };
      }
      this.logger.error("resource dispatch failed", { method: message.method, error: String(error) });
      return {
        status: 200,
        headers: baseHeaders,
        body: rpcError(message.id, -32603, "The squad encountered an internal error handling this request."),
      };
    }
  }

  private async handleToolCall(
    message: JsonRpcRequest,
    auth: AuthContext,
    baseHeaders: Record<string, string>,
  ): Promise<HttpResponseLike> {
    const params = message.params ?? {};
    const name = typeof params.name === "string" ? params.name : "";
    const args = params.arguments;

    // squad_memory_read / squad_memory_write are the synthetic shared-state broker
    // tools (not catalog tools). They are served only when the operator enabled
    // the memory feature (a backing store injected), are fail-closed on their own
    // dedicated scopes (Squad.Memory for read, Squad.MemoryWrite for write —
    // checked BEFORE any store access, default-deny), and land NO impactful action
    // (no model call, no gate, no run state — the same posture as squad_render_pptx).
    // The store key is ALWAYS <auth.tenantId>:<project> with tenantId from the
    // validated token (never caller input) and project shape-checked, so a caller
    // can never escape its own partition (SEC-3 tenant isolation, SEC-4 traversal).
    if (isMemoryExposed(name)) {
      if (!this.memoryStore) {
        return {
          status: 200,
          headers: baseHeaders,
          body: rpcError(message.id, -32601, `Unknown or unavailable tool: ${name}`),
        };
      }
      // SEC-2: fail-closed on the tool's dedicated scope BEFORE any store access.
      try {
        this.authenticator.authorizeTool(auth, name);
      } catch (error) {
        if (error instanceof AuthError) {
          return { status: error.status, headers: baseHeaders, body: { error: error.reason } };
        }
        throw error;
      }
      const record = (args as Record<string, unknown> | undefined) ?? {};
      const project = typeof record.project === "string" ? record.project : "";
      const path = typeof record.path === "string" ? record.path : "";
      // Resolve the operator-declared destination BEFORE any I/O. A caller may
      // only select among declared targets; an unknown name is rejected here and
      // never falls back silently to the default (which would write a caller's
      // memory somewhere it did not ask for). On a deployment with no declared
      // targets `memoryTargets` is undefined and the input is ignored.
      const requestedTarget = typeof record.target === "string" ? record.target : undefined;
      let store: SquadMemoryStore = this.memoryStore;
      if (this.memoryTargets) {
        try {
          store = this.memoryTargets.resolve(requestedTarget);
        } catch (error) {
          if (error instanceof UnknownMemoryTargetError) {
            return {
              status: 200,
              headers: baseHeaders,
              body: rpcError(
                message.id,
                -32602,
                `Unknown memory target. Available targets: ${this.memoryTargets.targetNames().join(", ")}.`,
              ),
            };
          }
          throw error;
        }
      }
      // Shape-check `project` (a single partition segment) and `path` (the SEC-4
      // traversal guard) BEFORE the store — a bad value never reaches a foreign
      // partition or the filesystem.
      if (!MEMORY_PROJECT_PATTERN.test(project)) {
        return {
          status: 200,
          headers: baseHeaders,
          body: rpcError(
            message.id,
            -32602,
            `${name} requires a 'project' matching ${MEMORY_PROJECT_PATTERN.source}.`,
          ),
        };
      }

      // squad_memory_sync is the BATCH write-back (WI-02): apply each item under
      // its OWN compare-and-swap and return a per-item result. A stale
      // `expectedEtag` on one item is reported as a conflict WITHOUT aborting the
      // others (a delegated host reconciles only the losers), and a structurally
      // invalid item (unsafe path / non-string content) fails that ONE item too.
      // It shares the write scope + tenant-isolation posture of the single write
      // above; the whole call is rejected only when `items` itself is not an array.
      if (name === SQUAD_MEMORY_SYNC_TOOL) {
        const items = Array.isArray(record.items) ? record.items : undefined;
        if (!items) {
          return {
            status: 200,
            headers: baseHeaders,
            body: rpcError(message.id, -32602, "squad_memory_sync requires an 'items' array."),
          };
        }
        const results: { path: string; ok: boolean; etag?: string; conflict?: boolean }[] = [];
        for (const raw of items) {
          const item = (raw as Record<string, unknown> | undefined) ?? {};
          const itemPath = typeof item.path === "string" ? item.path : "";
          const content = typeof item.content === "string" ? item.content : undefined;
          const expectedEtag = typeof item.expectedEtag === "string" ? item.expectedEtag : undefined;
          // SEC-4 traversal guard + shape-check BEFORE the store; a bad item is
          // marked failed (not a conflict) and never aborts the rest of the batch.
          if (!isSafeMemoryPath(itemPath) || content === undefined) {
            results.push({ path: itemPath, ok: false });
            continue;
          }
          try {
            const result = await store.write(auth.tenantId, project, itemPath, content, expectedEtag);
            if (result.ok) {
              results.push({ path: itemPath, ok: true, etag: result.etag });
            } else {
              // Lost the CAS race: a per-item conflict the caller re-reads and retries.
              results.push({ path: itemPath, ok: false, conflict: true });
            }
          } catch (error) {
            // Never surface raw error text (could echo content/a secret); log scrubbed.
            this.logger.error("memory sync item failed", { tool: name, error: String(error) });
            results.push({ path: itemPath, ok: false });
          }
        }
        return {
          status: 200,
          headers: baseHeaders,
          body: rpcResult(message.id, { project, results }),
        };
      }

      // squad_history reads the TREE rather than a key, so it is handled before
      // the single-path guard below: `index` and `list` carry no `path` at all.
      if (name === SQUAD_HISTORY_TOOL) {
        if (!this.history) {
          return {
            status: 200,
            headers: baseHeaders,
            body: rpcError(message.id, -32601, `Unknown or unavailable tool: ${name}`),
          };
        }
        const op = typeof record.op === "string" ? record.op : "index";
        try {
          if (op === "read") {
            const artifact = await this.history.read(auth.tenantId, project, path);
            return {
              status: 200,
              headers: baseHeaders,
              body: artifact
                ? rpcResult(message.id, { project, ...artifact })
                : rpcError(message.id, -32602, `No artifact at '${path}' in project '${project}'.`),
            };
          }
          if (op === "list") {
            const prefix = typeof record.prefix === "string" ? record.prefix : undefined;
            const entries = await this.history.list(auth.tenantId, project, prefix);
            return {
              status: 200,
              headers: baseHeaders,
              body: rpcResult(message.id, { project, prefix: prefix ?? null, entries }),
            };
          }
          const index = await this.history.index(auth.tenantId, project);
          return { status: 200, headers: baseHeaders, body: rpcResult(message.id, { project, ...index }) };
        } catch (error) {
          // An unsafe path is rejected by the store; never echo raw error text.
          this.logger.error("squad history failed", { tool: name, op, error: String(error) });
          return {
            status: 200,
            headers: baseHeaders,
            body: rpcError(message.id, -32602, `${name} rejected the request (check 'path'/'prefix').`),
          };
        }
      }

      if (!isSafeMemoryPath(path)) {
        return {
          status: 200,
          headers: baseHeaders,
          body: rpcError(message.id, -32602, `${name} requires a safe 'path' (no traversal).`),
        };
      }
      if (name === SQUAD_MEMORY_WRITE_TOOL) {
        const content = typeof record.content === "string" ? record.content : undefined;
        if (content === undefined) {
          return {
            status: 200,
            headers: baseHeaders,
            body: rpcError(message.id, -32602, "squad_memory_write requires string 'content'."),
          };
        }
        const expectedEtag = typeof record.expectedEtag === "string" ? record.expectedEtag : undefined;
        try {
          // CAS read-modify-write: pass `expectedEtag` through; on a lost race the
          // store reports the conflict (never a silent clobber — DR-01).
          const result = await store.write(auth.tenantId, project, path, content, expectedEtag);
          if (result.ok) {
            return {
              status: 200,
              headers: baseHeaders,
              body: rpcResult(message.id, { project, path, etag: result.etag }),
            };
          }
          // Lost the CAS race: a retryable conflict error carrying the current
          // etag so the caller can re-read and retry with a fresh token.
          return {
            status: 200,
            headers: baseHeaders,
            body: rpcError(
              message.id,
              MEMORY_CAS_CONFLICT_CODE,
              "squad_memory_write lost a compare-and-swap race; re-read and retry with the current etag.",
              { conflict: true, currentEtag: result.current?.etag },
            ),
          };
        } catch (error) {
          // Never surface raw error text (could echo content/a secret); log scrubbed.
          this.logger.error("memory write failed", { tool: name, error: String(error) });
          return {
            status: 200,
            headers: baseHeaders,
            body: rpcResult(message.id, {
              isError: true,
              content: [{ type: "text", text: "The squad encountered an internal error handling this request." }],
            }),
          };
        }
      }

      // squad_memory_read: return the entry content (and its etag for the next
      // write) scoped to the caller's tenantId:project.
      try {
        const entry = await store.read(auth.tenantId, project, path);
        if (!entry) {
          return {
            status: 200,
            headers: baseHeaders,
            body: rpcError(message.id, -32602, `No memory entry at '${path}'.`),
          };
        }
        return {
          status: 200,
          headers: baseHeaders,
          body: rpcResult(message.id, {
            project: entry.project,
            path: entry.path,
            content: entry.content,
            etag: entry.etag,
            updatedAt: entry.updatedAt,
          }),
        };
      } catch (error) {
        this.logger.error("memory read failed", { tool: name, error: String(error) });
        return {
          status: 200,
          headers: baseHeaders,
          body: rpcResult(message.id, {
            isError: true,
            content: [{ type: "text", text: "The squad encountered an internal error handling this request." }],
          }),
        };
      }
    }

    // squad_business_plan / squad_backlog are the synthetic BUSINESS tools (not
    // catalog tools). They are served only when the operator enabled the feature,
    // are fail-closed on their own least-privilege scopes (Squad.Business /
    // Squad.Backlog), and land NO impactful action: each runs ONE embedded
    // advisory dispatch and returns text (or, for the backlog, a validated JSON
    // contract). The ADO/Jira WRITE remains the native certified connector's job
    // on the end user's own connection (ADR-0001 trust boundary).
    if (isBusinessExposed(name)) {
      const spec = this.businessToolsExposed ? businessToolSpec(name) : undefined;
      if (!spec) {
        return {
          status: 200,
          headers: baseHeaders,
          body: rpcError(message.id, -32601, `Unknown or unavailable tool: ${name}`),
        };
      }
      // SEC-2: fail-closed scope BEFORE any model call.
      try {
        this.authenticator.authorizeTool(auth, name);
      } catch (error) {
        if (error instanceof AuthError) {
          return { status: error.status, headers: baseHeaders, body: { error: error.reason } };
        }
        throw error;
      }
      const record = (args as Record<string, unknown> | undefined) ?? {};
      const requestText = typeof record.request === "string" ? record.request.trim() : "";
      if (requestText.length === 0) {
        return {
          status: 200,
          headers: baseHeaders,
          body: rpcError(message.id, -32602, `${name} requires a non-empty 'request'.`),
        };
      }
      const coordinatorRequest = {
        toolId: name,
        request: requestText,
        context: typeof record.context === "string" ? record.context : undefined,
        squad: typeof record.squad === "string" ? record.squad : undefined,
      };
      try {
        const result = await this.embedded.handleBusiness(spec, coordinatorRequest, { auth });
        if (!spec.structured || result.outcome !== "completed" || !result.artifact) {
          return { status: 200, headers: baseHeaders, body: rpcResult(message.id, renderEmbeddedResult(result)) };
        }
        // The structured tool's whole value is a machine-readable result, so the
        // server validates the model's JSON rather than handing prose to the agent.
        // A malformed payload is an explicit, retryable error — never half-parsed
        // JSON the orchestrator would turn into malformed work items.
        try {
          const backlog = parseBacklog(result.artifact);
          return { status: 200, headers: baseHeaders, body: rpcResult(message.id, backlog) };
        } catch (error) {
          if (error instanceof BacklogContractError) {
            this.logger.error("backlog contract invalid", { tool: name, reason: error.message });
            return {
              status: 200,
              headers: baseHeaders,
              body: rpcResult(message.id, {
                isError: true,
                content: [
                  {
                    type: "text",
                    text:
                      "The backlog could not be produced in a structured form. Ask again with " +
                      "a more specific request, or narrow the scope.",
                  },
                ],
              }),
            };
          }
          throw error;
        }
      } catch (error) {
        // Never surface raw error text (could echo a prompt); log scrubbed.
        this.logger.error("business dispatch failed", { tool: name, error: String(error) });
        return {
          status: 200,
          headers: baseHeaders,
          body: rpcResult(message.id, {
            isError: true,
            content: [{ type: "text", text: "The squad encountered an internal error handling this request." }],
          }),
        };
      }
    }

    // squad_render_pptx is the synthetic deterministic render utility (not a
    // catalog tool). It is served only when the operator enabled render, is
    // fail-closed on its own Squad.Render scope, and lands NO impactful action
    // (no gate, no run state). The caller's tenant scopes the blob path.
    if (name === SQUAD_RENDER_PPTX_TOOL) {
      if (!this.renderService) {
        return {
          status: 200,
          headers: baseHeaders,
          body: rpcError(message.id, -32601, `Unknown or unavailable tool: ${name}`),
        };
      }
      // SEC-2: fail-closed scope BEFORE any render work.
      try {
        this.authenticator.authorizeTool(auth, name);
      } catch (error) {
        if (error instanceof AuthError) {
          return { status: error.status, headers: baseHeaders, body: { error: error.reason } };
        }
        throw error;
      }
      const record = (args as Record<string, unknown> | undefined) ?? {};
      const contentYaml = typeof record.contentYaml === "string" ? record.contentYaml : "";
      const styleYaml = typeof record.styleYaml === "string" ? record.styleYaml : "";
      if (contentYaml.length === 0 || styleYaml.length === 0) {
        return {
          status: 200,
          headers: baseHeaders,
          body: rpcError(message.id, -32602, "squad_render_pptx requires string contentYaml and styleYaml."),
        };
      }
      try {
        const result = await this.renderService.render({ contentYaml, styleYaml }, { tenantId: auth.tenantId });
        return { status: 200, headers: baseHeaders, body: rpcResult(message.id, result) };
      } catch (error) {
        // Never surface raw error text (could echo a header/secret); log scrubbed.
        this.logger.error("render dispatch failed", { tool: name, error: String(error) });
        return {
          status: 200,
          headers: baseHeaders,
          body: rpcResult(message.id, {
            isError: true,
            content: [{ type: "text", text: "The squad encountered an internal error handling this request." }],
          }),
        };
      }
    }

    // squad_status is the synthetic poll utility (not a catalog tool). It is
    // tenant-scoped and read/advance-only; it never starts new work of its own.
    // Only served when the operator enabled the pipeline surface (HIGH-1).
    if (name === SQUAD_STATUS_TOOL && this.pipelineExposed) {
      try {
        this.authenticator.authorizeTool(auth, name);
      } catch (error) {
        if (error instanceof AuthError) {
          return { status: error.status, headers: baseHeaders, body: { error: error.reason } };
        }
        throw error;
      }
      const runId = typeof (args as Record<string, unknown> | undefined)?.runId === "string"
        ? ((args as Record<string, unknown>).runId as string)
        : "";
      if (runId.length === 0) {
        return { status: 200, headers: baseHeaders, body: rpcError(message.id, -32602, "squad_status requires a string runId.") };
      }
      try {
        const result = await this.embedded.pollRun(runId, { auth });
        return { status: 200, headers: baseHeaders, body: rpcResult(message.id, renderEmbeddedResult(result)) };
      } catch (error) {
        this.logger.error("status poll failed", { tool: name, error: String(error) });
        return {
          status: 200,
          headers: baseHeaders,
          body: rpcResult(message.id, {
            isError: true,
            content: [{ type: "text", text: "The squad encountered an internal error handling this request." }],
          }),
        };
      }
    }

    const tool = this.router.getTool(name);
    // PROD-1: only exposed/known tools are callable over HTTP.
    if (!tool || !this.isExposed(name)) {
      return {
        status: 200,
        headers: baseHeaders,
        body: rpcError(message.id, -32601, `Unknown or unavailable tool: ${name}`),
      };
    }

    // SEC-2: per-tool scope authorization.
    try {
      this.authenticator.authorizeTool(auth, name);
    } catch (error) {
      if (error instanceof AuthError) {
        return { status: error.status, headers: baseHeaders, body: { error: error.reason } };
      }
      throw error;
    }

    // Input validation against the authored JSON Schema.
    try {
      this.router.validateInput(name, args);
    } catch (error) {
      if (error instanceof ToolInputError) {
        return { status: 200, headers: baseHeaders, body: rpcError(message.id, -32602, error.message) };
      }
      throw error;
    }

    const coordinatorRequest = this.router.toCoordinatorRequest(tool, args);
    try {
      // Dispatch by tool class:
      //   * squad_run / squad_federate — the gated async ADVISORY pipelines: START
      //     them (returns a held run id); the pipeline proceeds only after
      //     out-of-band approval, driven by squad_status. Both are catch-all tools
      //     with `gates: true`, so the human gate carries across the boundary
      //     identically; squad_federate additionally persists its federation inputs
      //     (squad / init / promote) so they survive approve -> poll.
      //   * squad_plan / squad_architect — advisory tools: a single-stage embedded
      //     advisory dispatch (no impactful action, no gate), returned synchronously.
      //   * the hero tools (squad_research / squad_review) — synchronous single
      //     embedded dispatch, unchanged.
      const result =
        tool.id === "squad_run" || tool.id === SQUAD_FEDERATE_TOOL
          ? await this.embedded.startHttpRun(tool, coordinatorRequest, { auth })
          : tool.id === "squad_plan" || tool.id === "squad_architect"
            ? await this.embedded.handleAdvisory(tool, coordinatorRequest, { auth })
            : await this.embedded.handle(tool, coordinatorRequest, { auth });
      return { status: 200, headers: baseHeaders, body: rpcResult(message.id, renderEmbeddedResult(result)) };
    } catch (error) {
      // Never surface the raw error text (could echo a prompt); log scrubbed, return generic.
      this.logger.error("embedded dispatch failed", { tool: name, error: String(error) });
      return {
        status: 200,
        headers: baseHeaders,
        body: rpcResult(message.id, {
          isError: true,
          content: [{ type: "text", text: "The squad encountered an internal error handling this request." }],
        }),
      };
    }
  }
}
