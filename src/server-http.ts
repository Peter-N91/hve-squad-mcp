/**
 * Live HTTP server bootstrap (deployed process only).
 *
 * Wires the production stack for the remote thin slice and is the ONLY module
 * that pulls in the live-only dependencies — the `jose` JWKS verifier and the
 * `@azure/identity` managed-identity token provider. Tests never import this file
 * (they inject fakes), so the unit and conformance suites run without `jose`,
 * without `@azure/identity`, and without a live Azure endpoint.
 *
 * Every trust-relevant value comes from operator config / environment (the model
 * endpoint is allow-listed; the Origin list is strict; the audience is bound) —
 * never from a caller. Secrets arrive via managed identity, never from code.
 */
import { pathToFileURL } from "node:url";

import { loadCatalog } from "./catalog/catalog.js";
import { ToolRouter } from "./router/router.js";
import { loadOperatorConfig, type OperatorConfig } from "./config/operator-config.js";
import { EntraAuthenticator } from "./auth/entra.js";
import { createJoseVerifier } from "./auth/jose-verifier.js";
import { EmbeddedCoordinator } from "./engine/embedded.js";
import { EphemeralWorkspaceManager } from "./engine/workspace.js";
import { GateKeeper, RunStoreApprovalChannel, TenantQuotaTracker, type HumanApprovalChannel } from "./engine/gates.js";
import { DurableRunStateStore } from "./engine/durable-run-state.js";
import { AzureTableRunStateStore } from "./engine/backends/azure-table-run-state.js";
import { AesGcmFieldCipher, NullFieldCipher, type FieldCipher } from "./engine/field-cipher.js";
import type { RunStateStore } from "./engine/run-state.js";
import { AzureOpenAIBackend, type ModelPricing } from "./engine/backends/azure-openai.js";
import { AzureBlobArtifactStore } from "./engine/backends/azure-blob-artifact-store.js";
import { PythonPptxRenderBackend } from "./engine/render/python-pptx-render-backend.js";
import { PptxRenderService } from "./engine/render/pptx-render-service.js";
import { createManagedIdentityTokenProvider } from "./engine/backends/managed-identity-credential.js";
import { RedactingLogger } from "./observability/logger.js";
import { SessionStore } from "./transports/session-store.js";
import { HttpMcpHandler } from "./transports/http-core.js";
import { createHttpServer } from "./transports/http.js";

/** The Azure Storage OAuth scope for the managed-identity Table token. */
const STORAGE_SCOPE = "https://storage.azure.com/.default";

function readPricing(env: NodeJS.ProcessEnv): ModelPricing | undefined {
  const input = Number(env.SQUAD_MCP_PRICE_INPUT_PER_MTOK);
  const output = Number(env.SQUAD_MCP_PRICE_OUTPUT_PER_MTOK);
  if (Number.isFinite(input) && Number.isFinite(output)) {
    return { inputPerMTokUsd: input, outputPerMTokUsd: output };
  }
  return undefined;
}

/** The cross-replica run-state + approval stack (undefined when the pipeline is off). */
export interface RunStateStack {
  runStateStore: RunStateStore;
  approvals: HumanApprovalChannel;
}

/**
 * Build the durable run-state store + auditable approval channel from operator
 * config (WI-06). Returns `undefined` when the gated pipeline is disabled (the
 * safe hero-only default). Shared by the HTTP server and the worker so both bind
 * to the SAME cross-replica store and approval record — an approval on the web
 * tier is visible to the worker. Backends:
 *   * `file` — single-replica local directory (dev / single-instance).
 *   * `table` — Azure Table Storage with ETag CAS (multi-replica; production).
 * When an encryption key is configured, `request`/`context` are AES-256-GCM
 * encrypted at rest (MEDIUM-3).
 */
export function buildRunStateStack(
  config: OperatorConfig,
  logger: RedactingLogger,
): RunStateStack | undefined {
  if (!config.remotePipelineEnabled) {
    return undefined;
  }
  const cipher: FieldCipher =
    config.encryptionKeyBase64.length > 0
      ? AesGcmFieldCipher.fromBase64Key(config.encryptionKeyBase64)
      : new NullFieldCipher();
  const runStateStore: RunStateStore =
    config.runStateBackend === "table"
      ? new AzureTableRunStateStore({
          account: config.storageAccount,
          tableName: config.runTableName,
          getAccessToken: createManagedIdentityTokenProvider(STORAGE_SCOPE),
          cipher,
          logger,
        })
      : new DurableRunStateStore({ baseDir: config.runStateDir, cipher });
  // Store-backed approval → cross-replica release (an approval on any replica is
  // visible to all) with an auditable approver + timestamp.
  const approvals = new RunStoreApprovalChannel(runStateStore, logger);
  return { runStateStore, approvals };
}

/**
 * Assemble the {@link HttpMcpHandler} from operator config. Separated from
 * `listen` so the wiring is exercisable; in production this loads the live
 * verifier + managed-identity credential.
 */
export function buildHttpHandler(
  config: OperatorConfig,
  env: NodeJS.ProcessEnv = process.env,
  logger: RedactingLogger = new RedactingLogger({ name: "hve-squad-mcp-http" }),
): HttpMcpHandler {
  const router = new ToolRouter(loadCatalog());

  const jwksUri = (env.SQUAD_MCP_JWKS_URI ?? "").trim();
  if (jwksUri.length === 0) {
    throw new Error("SQUAD_MCP_JWKS_URI is required to validate Entra tokens (SEC-1).");
  }
  const authenticator = new EntraAuthenticator({
    audience: config.audience,
    allowedIssuers: config.allowedIssuers,
    allowedTenants: config.allowedTenants,
    verifier: createJoseVerifier({ jwksUri, issuer: config.allowedIssuers }),
    logger,
  });

  const backend = new AzureOpenAIBackend({
    endpoint: config.modelEndpoint,
    deployment: config.modelDeployment,
    apiVersion: config.modelApiVersion,
    getAccessToken: createManagedIdentityTokenProvider(),
    logger,
    pricing: readPricing(env),
  });

  // HIGH-1 / WI-06: the gated async pipeline is exposed ONLY when the operator
  // enabled it, with a durable run-state store and an auditable approval channel.
  // Otherwise the surface stays hero-only (the council-gated default).
  const stack = buildRunStateStack(config, logger);

  // The deterministic render tool is built only when the operator enabled it. It
  // reuses the Storage managed-identity token (storage.azure.com) for the Blob
  // upload + user-delegation SAS; the interpreter/scripts/brand come from config.
  const renderService = config.enableRenderPptx
    ? new PptxRenderService({
        backend: new PythonPptxRenderBackend({
          pythonPath: config.renderPythonPath,
          scriptsDir: config.renderScriptsDir,
        }),
        store: new AzureBlobArtifactStore({
          account: config.storageAccount,
          container: config.renderBlobContainer,
          getAccessToken: createManagedIdentityTokenProvider(STORAGE_SCOPE),
          logger,
        }),
        ttlMs: config.renderSasTtlMinutes * 60 * 1000,
        templatePath: config.renderBrandTemplatePath.length > 0 ? config.renderBrandTemplatePath : undefined,
      })
    : undefined;

  const embedded = new EmbeddedCoordinator({
    backend,
    workspaceManager: new EphemeralWorkspaceManager(),
    quota: new TenantQuotaTracker({
      concurrency: config.tenantConcurrency,
      monthlyCeilingUsd: config.tenantMonthlyCostCeilingUsd,
    }),
    gates: new GateKeeper(),
    runStateStore: stack?.runStateStore,
    approvals: stack?.approvals,
    // WI-1b4-WORKER: when a worker is enabled, the poll is read-only and the ACA
    // Job drives approved runs off the request path (runs may exceed 240s).
    driveOnPoll: !config.workerEnabled,
    logger,
  });

  return new HttpMcpHandler({
    router,
    authenticator,
    embedded,
    sessions: new SessionStore({ idleMs: config.sessionIdleMs }),
    allowedOrigins: config.allowedOrigins,
    logger,
    pipelineExposed: config.remotePipelineEnabled,
    renderService,
  });
}

/** Start the live HTTP server. */
export async function mainHttp(): Promise<void> {
  const logger = new RedactingLogger({ name: "hve-squad-mcp-http" });
  const config = loadOperatorConfig();
  const handler = buildHttpHandler(config, process.env, logger);
  const server = createHttpServer(handler);
  const port = Number(process.env.PORT ?? 3000);
  await new Promise<void>((resolve) => server.listen(port, resolve));
  logger.info("hve-squad MCP HTTP server listening", { port, mode: "embedded" });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  mainHttp().catch((error: unknown) => {
    process.stderr.write(`[hve-squad-mcp-http] fatal: ${String(error)}\n`);
    process.exit(1);
  });
}
