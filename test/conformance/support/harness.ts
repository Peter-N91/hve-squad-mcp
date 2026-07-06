/**
 * Conformance harness — assembles the REAL remote stack with the suite's fakes.
 *
 * This is the seam the council required: the unit and conformance suites inject
 * fakes and run WITHOUT live Azure. It mirrors the production wiring in
 * `server-http.ts` (router -> EntraAuthenticator -> EmbeddedCoordinator ->
 * SessionStore -> HttpMcpHandler) but substitutes the live-only dependencies —
 * the `jose` JWKS verifier and the `@azure/identity` managed-identity credential —
 * with a {@link FakeJwtVerifier} and a {@link MockModelBackend}. Everything else
 * (the auth/scope/session/gate/workspace/redaction logic under test) is the real
 * production code path.
 */
import { loadCatalog } from "../../../src/catalog/catalog.js";
import { ToolRouter } from "../../../src/router/router.js";
import { EntraAuthenticator } from "../../../src/auth/entra.js";
import { EmbeddedCoordinator } from "../../../src/engine/embedded.js";
import { EphemeralWorkspaceManager, type WorkspaceManager } from "../../../src/engine/workspace.js";
import { GateKeeper, InMemoryApprovalChannel, TenantQuotaTracker, type HumanApprovalChannel } from "../../../src/engine/gates.js";
import type { RunStateStore } from "../../../src/engine/run-state.js";
import { RedactingLogger } from "../../../src/observability/logger.js";
import { SessionStore } from "../../../src/transports/session-store.js";
import {
  HttpMcpHandler,
  type HttpRequestLike,
  type HttpResponseLike,
} from "../../../src/transports/http-core.js";
import type { PptxRenderService } from "../../../src/engine/render/pptx-render-service.js";
import { MockModelBackend } from "./mock-backend.js";
import { FakeJwtVerifier, TEST_AUDIENCE, TEST_ISSUER, bearer } from "./fake-auth.js";
import { createCapturingLogger } from "./log-capture.js";

const DEFAULT_ORIGIN = "https://copilotstudio.microsoft.com";

export interface HarnessOptions {
  verifier?: FakeJwtVerifier;
  backend?: MockModelBackend;
  logger?: RedactingLogger;
  /** Captured log lines paired with `logger`; defaults to the harness sink. */
  lines?: string[];
  audience?: string;
  allowedIssuers?: string[];
  allowedTenants?: string[];
  allowedOrigins?: string[];
  concurrency?: number;
  monthlyCeilingUsd?: number;
  workspaceManager?: WorkspaceManager;
  runStateStore?: RunStateStore;
  quota?: TenantQuotaTracker;
  gates?: GateKeeper;
  approvals?: HumanApprovalChannel;
  /** Whether the async pipeline surface is exposed (default true in the harness). */
  pipelineExposed?: boolean;
  /** Optional PPTX render service; when set, squad_render_pptx is exposed. */
  renderService?: PptxRenderService;
}

export interface Harness {
  handler: HttpMcpHandler;
  embedded: EmbeddedCoordinator;
  backend: MockModelBackend;
  verifier: FakeJwtVerifier;
  authenticator: EntraAuthenticator;
  logger: RedactingLogger;
  /** Captured log lines (empty when a caller supplied its own logger without lines). */
  lines: string[];
  sessions: SessionStore;
  router: ToolRouter;
  quota: TenantQuotaTracker;
  workspaceManager: WorkspaceManager;
  approvals: HumanApprovalChannel;
}

/** Build the full HTTP handler stack with fakes injected. */
export function buildHarness(options: HarnessOptions = {}): Harness {
  const capturing = createCapturingLogger();
  const logger = options.logger ?? capturing.logger;
  const lines = options.lines ?? (options.logger ? [] : capturing.lines);
  const verifier = options.verifier ?? new FakeJwtVerifier();
  const backend = options.backend ?? new MockModelBackend();
  const router = new ToolRouter(loadCatalog());

  const authenticator = new EntraAuthenticator({
    audience: options.audience ?? TEST_AUDIENCE,
    allowedIssuers: options.allowedIssuers ?? [TEST_ISSUER],
    allowedTenants: options.allowedTenants ?? [],
    verifier,
    logger,
  });

  const workspaceManager = options.workspaceManager ?? new EphemeralWorkspaceManager();
  const quota =
    options.quota ??
    new TenantQuotaTracker({
      concurrency: options.concurrency ?? 4,
      monthlyCeilingUsd: options.monthlyCeilingUsd ?? 500,
    });
  const gates = options.gates ?? new GateKeeper();
  const approvals = options.approvals ?? new InMemoryApprovalChannel();

  const embedded = new EmbeddedCoordinator({
    backend,
    workspaceManager,
    quota,
    gates,
    runStateStore: options.runStateStore,
    approvals,
    logger,
  });

  const sessions = new SessionStore({ idleMs: 5 * 60 * 1000 });

  const handler = new HttpMcpHandler({
    router,
    authenticator,
    embedded,
    sessions,
    allowedOrigins: options.allowedOrigins ?? [DEFAULT_ORIGIN],
    logger,
    // Tests exercise the full remote surface by default; a test can pass
    // pipelineExposed:false to assert the safe hero-only default.
    pipelineExposed: options.pipelineExposed ?? true,
    renderService: options.renderService,
  });

  return {
    handler,
    embedded,
    backend,
    verifier,
    authenticator,
    logger,
    lines,
    sessions,
    router,
    quota,
    workspaceManager,
    approvals,
  };
}

const JSON_HEADERS: Record<string, string> = { "content-type": "application/json" };

/** Initialize a session and return the minted `Mcp-Session-Id`. */
export async function initializeSession(
  handler: HttpMcpHandler,
  token: string,
  origin = DEFAULT_ORIGIN,
): Promise<string> {
  const res = await handler.handle({
    method: "POST",
    path: "/mcp",
    headers: { origin, authorization: bearer(token), ...JSON_HEADERS },
    body: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
  });
  const sessionId = res.headers["Mcp-Session-Id"];
  if (!sessionId) {
    throw new Error(`initialize did not mint a session id (status ${res.status})`);
  }
  return sessionId;
}

export interface CallToolInput {
  token: string;
  sessionId: string;
  name: string;
  args: Record<string, unknown>;
  origin?: string;
  id?: number;
}

/** Issue a `tools/call` and return the raw HTTP-like response. */
export function callTool(handler: HttpMcpHandler, input: CallToolInput): Promise<HttpResponseLike> {
  const req: HttpRequestLike = {
    method: "POST",
    path: "/mcp",
    headers: {
      origin: input.origin ?? DEFAULT_ORIGIN,
      authorization: bearer(input.token),
      "mcp-session-id": input.sessionId,
      ...JSON_HEADERS,
    },
    body: {
      jsonrpc: "2.0",
      id: input.id ?? 2,
      method: "tools/call",
      params: { name: input.name, arguments: input.args },
    },
  };
  return handler.handle(req);
}

/** Extract the concatenated text content from a `tools/call` response body. */
export function resultText(res: HttpResponseLike): string {
  const body = res.body as { result?: { content?: { text?: string }[] } } | undefined;
  return (body?.result?.content ?? []).map((c) => c.text ?? "").join("\n");
}
