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
import { isAdvisoryExposed, isRemotelyExposed, SQUAD_STATUS_TOOL, SQUAD_RENDER_PPTX_TOOL } from "../auth/scopes.js";
import { AuthError, type AuthContext, type EntraAuthenticator } from "../auth/entra.js";
import { ToolInputError, type ToolRouter } from "../router/router.js";
import { renderEmbeddedResult } from "../engine/render-embedded.js";
import { SERVER_NAME, SERVER_VERSION } from "../server.js";
import type { EmbeddedCoordinator } from "../engine/embedded.js";
import type { PptxRenderService } from "../engine/render/pptx-render-service.js";
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

function rpcError(id: string | number | null | undefined, code: number, message: string): unknown {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
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

  constructor(deps: HttpMcpHandlerDeps) {
    this.router = deps.router;
    this.authenticator = deps.authenticator;
    this.embedded = deps.embedded;
    this.sessions = deps.sessions;
    this.allowedOrigins = new Set(deps.allowedOrigins);
    this.logger = deps.logger;
    this.pipelineExposed = deps.pipelineExposed ?? false;
    this.renderService = deps.renderService;
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
          capabilities: { tools: {} },
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
            ],
          }),
        };
      case "tools/call":
        return this.handleToolCall(message, auth, baseHeaders);
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

  private async handleToolCall(
    message: JsonRpcRequest,
    auth: AuthContext,
    baseHeaders: Record<string, string>,
  ): Promise<HttpResponseLike> {
    const params = message.params ?? {};
    const name = typeof params.name === "string" ? params.name : "";
    const args = params.arguments;

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
      //   * squad_run — the gated async ADVISORY pipeline: START it (returns a held
      //     run id); the full pipeline proceeds only after out-of-band approval,
      //     driven by squad_status. The human gate carries across the boundary.
      //   * squad_plan / squad_architect — advisory tools: a single-stage embedded
      //     advisory dispatch (no impactful action, no gate), returned synchronously.
      //   * the hero tools (squad_research / squad_review) — synchronous single
      //     embedded dispatch, unchanged.
      const result =
        tool.id === "squad_run"
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
