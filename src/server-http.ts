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
import { AzureTableSquadMemoryStore } from "./engine/backends/azure-table-squad-memory.js";
import { FileSquadMemoryStore } from "./engine/backends/file-squad-memory.js";
import { GraphSquadMemoryStore } from "./engine/backends/graph-squad-memory.js";
import { TargetedSquadMemoryStore } from "./engine/targeted-squad-memory.js";
import { AutoMemory } from "./engine/auto-memory.js";
import { MemoryBackedArtifactStore } from "./engine/artifact-store.js";
import { SquadRunRecorder } from "./engine/squad-run-recorder.js";
import {
  OverflowSquadMemoryStore,
  type MemoryBlobWriter,
} from "./engine/backends/overflow-squad-memory.js";
import { AesGcmFieldCipher, NullFieldCipher, type FieldCipher } from "./engine/field-cipher.js";
import type { RunStateStore } from "./engine/run-state.js";
import type { SquadMemoryStore } from "./engine/squad-memory-state.js";
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

/**
 * The Microsoft Graph OAuth scope for the managed-identity token used by the
 * SharePoint / OneDrive memory backend. The app identity needs an application
 * permission on the target drive (`Sites.Selected` scoped to the site, or
 * `Files.ReadWrite.All`) — least privilege is `Sites.Selected` plus a per-site
 * write grant, so the server can reach ONLY the library the operator designated.
 */
const GRAPH_SCOPE = "https://graph.microsoft.com/.default";

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

/** The shared-state memory broker stack (undefined when the feature is off). */
export interface SquadMemoryStack {
  memoryStore: SquadMemoryStore;
}

/**
 * Build the shared-state memory broker store from operator config. Returns
 * `undefined` when the feature is disabled (the advisory-only default), so the
 * bootstrap makes NO storage calls and the resource surface / memory tools are
 * not served. Mirrors {@link buildRunStateStack}: it selects the backend and,
 * when an encryption key is configured, encrypts `content` at rest with
 * AES-256-GCM (MEDIUM-3) — otherwise the identity cipher. The SAME store instance
 * serves both the resource read surface and the `squad_memory_write` CAS tool
 * (wired in later phases). Backends:
 *   * `file`  — single-replica local directory (dev / single-instance).
 *   * `table` — Azure Table Storage with ETag CAS (multi-replica; production).
 */
export function buildSquadMemoryStack(
  config: OperatorConfig,
  logger: RedactingLogger,
): SquadMemoryStack | undefined {
  if (!config.enableMemory) {
    return undefined;
  }
  const cipher: FieldCipher =
    config.encryptionKeyBase64.length > 0
      ? AesGcmFieldCipher.fromBase64Key(config.encryptionKeyBase64)
      : new NullFieldCipher();

  /** Build one destination from a (global or per-target) backend selection. */
  const buildBackend = (spec: {
    backend: OperatorConfig["memoryBackend"];
    dir?: string;
    storageAccount?: string;
    tableName?: string;
    driveId?: string;
    rootPath?: string;
    endpoint?: string;
    encrypt?: boolean;
  }): SquadMemoryStore => {
    if (spec.backend === "table") {
      return new AzureTableSquadMemoryStore({
        account: spec.storageAccount || config.storageAccount,
        tableName: spec.tableName || config.memoryTableName,
        getAccessToken: createManagedIdentityTokenProvider(STORAGE_SCOPE),
        cipher,
        logger,
      });
    }
    if (spec.backend === "graph") {
      return new GraphSquadMemoryStore({
        driveId: spec.driveId ?? "",
        rootPath: spec.rootPath,
        endpoint: spec.endpoint && spec.endpoint.length > 0 ? spec.endpoint : undefined,
        getAccessToken: createManagedIdentityTokenProvider(GRAPH_SCOPE),
        // A SharePoint/OneDrive destination is human-readable BY DESIGN, so it
        // stays plaintext unless the operator explicitly opts into ciphertext.
        cipher: spec.encrypt ? cipher : new NullFieldCipher(),
        logger,
      });
    }
    return new FileSquadMemoryStore({ baseDir: spec.dir || config.memoryDir, cipher });
  };

  let memoryStore: SquadMemoryStore = buildBackend({
    backend: config.memoryBackend,
    dir: config.memoryDir,
    storageAccount: config.storageAccount,
    tableName: config.memoryTableName,
    driveId: config.memoryGraphDriveId,
    rootPath: config.memoryGraphRootPath,
    endpoint: config.memoryGraphEndpoint,
    encrypt: config.memoryGraphEncrypt,
  });

  // Named destinations: when the operator declared an allow-list, the caller may
  // select among them by name (never by raw destination — SEC-3). A deployment
  // that declares none keeps the single store above and ignores `target`.
  if (config.memoryTargets.length > 0) {
    const targets = new Map<string, SquadMemoryStore>(
      config.memoryTargets.map((target) => [target.name, buildBackend(target)] as const),
    );
    memoryStore = new TargetedSquadMemoryStore({
      targets,
      defaultTarget: config.memoryDefaultTarget,
    });
  }

  // WI-03 — when the operator enables the Blob overflow channel, wrap the store so
  // over-threshold content spills to a tenant-scoped Blob (the same at-rest
  // envelope; MEDIUM-3) with a tiny pointer entity left in the primary store. Off
  // by default → the primary store's behavior is unchanged. The SAME `cipher` is
  // passed so the blob payload is byte-identical to what the primary would persist.
  if (config.memoryOverflowEnabled) {
    const blobStore = new AzureBlobArtifactStore({
      account: config.storageAccount,
      container: config.memoryOverflowContainer,
      getAccessToken: createManagedIdentityTokenProvider(STORAGE_SCOPE),
      logger,
    });
    const blob: MemoryBlobWriter = {
      put: (blobPath, bytes) => blobStore.putObject(blobPath, bytes),
      get: (blobPath) => blobStore.getObject(blobPath),
    };
    return {
      memoryStore: new OverflowSquadMemoryStore({
        primary: memoryStore,
        blob,
        cipher,
        thresholdBytes: config.memoryOverflowThresholdBytes,
      }),
    };
  }
  return { memoryStore };
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

  // The shared-state memory broker is built only when the operator enabled it
  // (off by default). The SAME store instance serves the resource read surface
  // and the write-back tool (wired in later phases).
  const memoryStack = buildSquadMemoryStack(config, logger);

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
    gates: new GateKeeper({ advisoryAutopilotEnabled: config.advisoryAutopilotEnabled }),
    runStateStore: stack?.runStateStore,
    approvals: stack?.approvals,
    // WI-1b4-WORKER: when a worker is enabled, the poll is read-only and the ACA
    // Job drives approved runs off the request path (runs may exceed 240s).
    driveOnPoll: !config.workerEnabled,
    // Deterministic server-side memory continuity. Built ONLY when the operator
    // enabled both the memory broker and auto-memory; otherwise the engine keeps
    // its previous behavior exactly (memory stays a manual tool).
    autoMemory:
      config.memoryAutoEnabled && memoryStack
        ? new AutoMemory({
            store: memoryStack.memoryStore,
            defaultProject: config.memoryDefaultProject,
            logger,
          })
        : undefined,
    // The squad ledger writes the `.copilot-tracking` tree through whichever
    // store the memory backend already selected, so an operator picks the
    // destination once. Requires auto-memory, which is what resolves the project
    // partition the tree is written under.
    runRecorder:
      config.enableArtifacts && config.memoryAutoEnabled && memoryStack
        ? new SquadRunRecorder({
            store: new MemoryBackedArtifactStore(memoryStack.memoryStore),
            // Only when the operator enabled rendering; otherwise the presenter's
            // markdown stands on its own rather than half-producing a deck.
            renderer: renderService,
            logger,
          })
        : undefined,
    logger,
  });

  return new HttpMcpHandler({
    router,
    authenticator,
    embedded,
    sessions: new SessionStore({ idleMs: config.sessionIdleMs }),
    allowedOrigins: config.allowedOrigins,
    artifactsEnabled: config.enableArtifacts,
    logger,
    pipelineExposed: config.remotePipelineEnabled,
    renderService,
    memoryStore: memoryStack?.memoryStore,
    businessToolsExposed: config.enableBusinessTools,
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
