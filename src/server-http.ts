import { resolveSquadGithubRoot } from "./paths.js";
import { selectEconomyModel } from "./engine/copilot/economy-routing.js";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { LocalSpecialists } from "./engine/copilot/local-specialists.js";
import { readUpstreamPublicSource, UPSTREAM_SOURCE_ORIGINS } from "./engine/copilot/upstream-source-reader.js";
import { UpstreamRunService } from "./engine/copilot/upstream-run-service.js";
import { installedUpstreamBundle } from "./engine/copilot/upstream-bundle.js";

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
import { EmbeddedCoordinator, type EmbeddedCoordinatorDeps } from "./engine/embedded.js";
import { CopilotStageExecutor } from "./engine/copilot/copilot-stage-executor.js";
import { perUserStageExecutor } from "./engine/copilot/per-user-executor.js";
import { userSessionClient } from "./engine/copilot/user-session-client.js";
import { buildPerUserStack, githubCredentialVault, SandboxReadiness, type PerUserStack } from "./server-per-user.js";
import type { GitHubLinkStore, LinkFlowStore } from "./github-link/index.js";
import { AzureTableGitHubLinkStore, AzureTableLinkFlowStore } from "./github-link/index.js";
import type { ReadinessProbe } from "./transports/readiness.js";
import { lazyCopilotSdkClient, type CopilotSdkClient } from "./engine/copilot/copilot-sdk-client.js";
import {
  CommandCredentialSource,
  CopilotCredentials,
  EnvCredentialSource,
  FileCredentialSource,
  type CopilotEntitlementVerifier,
  type CopilotIdentityStatus,
  type GitHubCredentialSource,
  type GitHubTokenProviderResult,
} from "./engine/copilot/copilot-credentials.js";
import { CopilotReadiness } from "./engine/copilot/copilot-readiness.js";
import { FileCopilotSessionStateStore } from "./engine/copilot/session-state-store.js";
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
import { AzureOpenAIBackend, modelPricingFromEnvironment } from "./engine/backends/azure-openai.js";
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
  const runBlobs = config.runStateBackend === "table" && config.memoryOverflowEnabled
    ? new AzureBlobArtifactStore({
        account: config.storageAccount,
        container: config.memoryOverflowContainer,
        getAccessToken: createManagedIdentityTokenProvider(STORAGE_SCOPE),
        logger,
      }) : undefined;
  const runStateStore: RunStateStore =
    config.runStateBackend === "table"
      ? new AzureTableRunStateStore({
          account: config.storageAccount,
          tableName: config.runTableName,
          getAccessToken: createManagedIdentityTokenProvider(STORAGE_SCOPE),
          cipher,
          logger,
          blob: runBlobs ? {
            put: (path, bytes) => runBlobs.putObject(path, bytes),
            get: (path) => runBlobs.getObject(path),
          } : undefined,
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

/** How long a driving status poll waits for its run before answering `run_already_in_flight`. */
export const POLL_DRIVE_WAIT_MS = 30_000;

/** The opt-in Copilot runtime: stage executor factory plus the readiness it depends on. */
export interface CopilotRuntime {
  stageExecutorFactory: NonNullable<EmbeddedCoordinatorDeps["stageExecutorFactory"]>;
  /** The shared GitHub identity; absent when identity is per user. */
  credentials?: CopilotCredentials;
  /** Per-user identity assembly; present when `perUserGithub` is enabled. */
  perUser?: PerUserStack;
  /** Engine guard for owned runs; present with per-user identity. */
  runPreflight?: EmbeddedCoordinatorDeps["runPreflight"];
  readiness: ReadinessProbe;
  upstreamRun?: EmbeddedCoordinatorDeps["upstreamRun"];
  localArtifactReference?: (tenantId: string, project: string, metadataPath: string) => Promise<{ downloadUrl: string; expiresAt: string; sha256: string; mediaType: string } | undefined>;
  localArtifactChunk?: (tenantId: string, project: string, metadataPath: string, offset: number) => Promise<{ base64: string; offset: number; nextOffset: number | null; totalBytes: number; sha256: string; mediaType: string } | undefined>;
}

/** The configured source of the server-owned GitHub identity. */
export function buildCopilotCredentialSource(config: OperatorConfig, env: NodeJS.ProcessEnv = process.env): GitHubCredentialSource {
  const identity = config.copilot.identity;
  if (identity.kind === "file") return new FileCredentialSource(identity.path);
  if (identity.kind === "command") return new CommandCredentialSource(identity.argv);
  return new EnvCredentialSource(identity.variable, env);
}

/**
 * Opt-in Copilot SDK stage executor (`SQUAD_MCP_STAGE_EXECUTOR=copilot`).
 * Returns `undefined` for the default built-in runtime, leaving the engine's
 * own executor in place.
 */
export function buildCopilotRuntime(
  config: OperatorConfig,
  memoryStack: SquadMemoryStack | undefined,
  options: {
    env?: NodeJS.ProcessEnv; logger?: RedactingLogger; client?: CopilotSdkClient; runStateStore?: RunStateStore;
    /** Shared multi-replica stores for the account link; the file stores are used when absent. */
    linkStore?: GitHubLinkStore; flowStore?: LinkFlowStore;
    /** Trusted dependency injection for offline host-integration tests; never an MCP argument. */
    perUserStack?: PerUserStack;
  } = {},
): CopilotRuntime | undefined {
  if (config.stageExecutor !== "copilot") {
    return undefined;
  }
  if (!memoryStack) {
    throw new Error("SQUAD_MCP_STAGE_EXECUTOR=copilot requires the squad memory broker for durable artifacts.");
  }
  if (config.copilot.upstreamRuntime && !options.runStateStore) {
    throw new Error("Full upstream execution requires the existing durable run-state and human-response store.");
  }
  const upstreamBundle = config.copilot.upstreamRuntime ? installedUpstreamBundle() : undefined;
  const client = options.client ?? lazyCopilotSdkClient({
    cliUrl: config.copilot.cliUrl,
    connectionToken: config.copilot.connectionToken,
    workspaceMount: config.copilot.sandboxWorkspace,
  });
  // Proves Copilot access for whichever token is presented: the shared one, or a user's.
  const entitlement: CopilotEntitlementVerifier = {
    async verify(token) {
      const result = await client.entitlementVerifier({
        requireFreshCredentialCheck: config.perUserGithub.enabled,
      }).verify(token);
      if (config.copilot.routing === "economy") {
        const root = resolveSquadGithubRoot();
        if (!root) throw new Error("Economy routing catalog root is unavailable.");
        const picks = ["researcher", "lead", "developer", "tester"].map(role => selectEconomyModel(root, role, "default", result.models));
        options.logger?.info("economy routing verification", { routing: "economy", picks: Object.fromEntries(picks.map(pick => [pick.role, pick.model])) });
      }
      return result;
    },
  };
  // Per-user identity replaces the shared credential entirely; the two never coexist.
  const perUserConfig = config.perUserGithub;
  let linkStore = options.linkStore;
  let flowStore = options.flowStore;
  if (perUserConfig.enabled && perUserConfig.linkStore.kind === "table") {
    // Several replicas and the worker must agree on links and on single-use flow state.
    if (!config.storageAccount) throw new Error("SQUAD_MCP_GITHUB_LINK_STORE=table requires SQUAD_MCP_STORAGE_ACCOUNT.");
    const connection = { account: config.storageAccount, getAccessToken: createManagedIdentityTokenProvider(STORAGE_SCOPE) };
    linkStore ??= new AzureTableGitHubLinkStore({ ...connection, tableName: perUserConfig.linkStore.table });
    flowStore ??= new AzureTableLinkFlowStore({
      ...connection,
      tableName: perUserConfig.linkStore.flowTable,
      cipher: githubCredentialVault(perUserConfig),
    });
  }
  const perUser = perUserConfig.enabled
    ? options.perUserStack ?? buildPerUserStack(perUserConfig, {
        verifier: entitlement,
        logger: options.logger,
        linkStore,
        flowStore,
      })
    : undefined;
  if (perUser && !options.runStateStore) {
    throw new Error("Per-user GitHub identity requires the durable run-state store: a run's owner is read from its record.");
  }
  const credentials = perUser ? undefined : new CopilotCredentials({
    source: buildCopilotCredentialSource(config, options.env),
    verifier: entitlement,
    reverifyMs: config.copilot.identityReverifyMs,
  });
  const store = new MemoryBackedArtifactStore(memoryStack.memoryStore);
  const sessionState = new FileCopilotSessionStateStore(config.copilot.sessionStateDir);
  const localBinaryStore = upstreamBundle && config.storageAccount && config.enableRenderPptx ? new AzureBlobArtifactStore({
    account: config.storageAccount, container: config.renderBlobContainer,
    getAccessToken: createManagedIdentityTokenProvider(STORAGE_SCOPE), logger: options.logger,
  }) : undefined;
  const upstreamSourceOrigins = UPSTREAM_SOURCE_ORIGINS.filter(origin =>
    !config.copilot.allowedHosts.length || config.copilot.allowedHosts.includes(new URL(origin).hostname));
  const upstreamService = upstreamBundle && options.runStateStore ? new UpstreamRunService({
    store: options.runStateStore,
    runtimeOptions: async ({ run, workspace, request }) => {
      const identity = perUser ? await perUser.statusForRun(run) : credentials!.status();
      if (!identity?.ready || !identity.modelIds?.length) throw new Error("Upstream execution requires verified Copilot model availability.");
      const gitHubTokenProvider = perUser ? perUser.tokenProviderForRun(run) : credentials!.tokenProvider;
      const proposedRouting = config.copilot.routing === "economy" ? { mode: "economy" as const } : { mode: "ranked" as const };
      return { enabled: true, client: perUser ? userSessionClient(client, perUser, run) : client, bundle: upstreamBundle, store, workspace, sessionState,
        routing: proposedRouting,
        tenantId: run.tenantId, project: request.project ?? config.memoryDefaultProject, runId: run.runId,
        // Init opens no SDK session. The runtime resolves the actual coordinator model after the user selects routing.
        modelIds: identity.modelIds, coordinatorModel: identity.modelIds[0], gitHubTokenProvider,
        profile: request.profile, mode: "autopilot", deadlineMs: 2100000, maxModelCalls: 100, maxProcedureCalls: 100,
        sourceOrigins: upstreamSourceOrigins,
        sourceReader: (source, signal) => readUpstreamPublicSource(source.target, signal, upstreamSourceOrigins),
        ...(localBinaryStore ? { localSpecialistFactory: context => new LocalSpecialists({
          port: context.port, timeoutMs: Math.max(1000, Math.min(120000, context.deadlineAt - Date.now())),
          readTextArtifact: context.readTextArtifact,
          writeBinaryArtifact: async (artifact, receipt, control) => {
            control?.signal?.throwIfAborted();
            if (createHash("sha256").update(artifact.bytes).digest("hex") !== artifact.sha256 || receipt.sha256 !== artifact.sha256) throw new Error("Specialist binary hash receipt mismatch.");
            const metadataPath = artifact.path + ".artifact.json";
            if (await store.get(run.tenantId, request.project ?? config.memoryDefaultProject, metadataPath)) throw new Error("Specialist output metadata already exists; refusing overwrite.");
            const link = await localBinaryStore.uploadSpecialistArtifact(run.tenantId, request.project ?? config.memoryDefaultProject, run.runId, basename(artifact.path), artifact.bytes, artifact.mediaType, 900000);
            control?.signal?.throwIfAborted();
            const metadata = JSON.stringify({kind:"local-specialist-artifact",path:artifact.path,sha256:artifact.sha256,bytes:artifact.bytes.byteLength,mediaType:artifact.mediaType,blobPath:link.blobPath,operation:receipt.operation,inputSha256:receipt.inputSha256},null,2);
            const written = await store.put(run.tenantId, request.project ?? config.memoryDefaultProject, metadataPath, metadata, "");
            if (!written.ok || (await store.get(run.tenantId, request.project ?? config.memoryDefaultProject, metadataPath))?.content !== metadata) throw new Error("Specialist binary metadata was not persisted exactly; uploaded blob requires operator reconciliation.");
          },
        }) } : {}),
        ...(localBinaryStore ? { getLocalArtifactReference: async (path, context) => {
          context.signal.throwIfAborted();
          const metadataPath = path + ".artifact.json";
          const stored = await store.get(run.tenantId, request.project ?? config.memoryDefaultProject, metadataPath);
          if (!stored) throw new Error("Specialist artifact metadata is absent.");
          const metadata = JSON.parse(stored.content) as {kind?:string;path?:string;sha256?:string;blobPath?:string;mediaType?:string};
          if (metadata.kind !== "local-specialist-artifact" || metadata.path !== path || !metadata.sha256 || !/^[a-f0-9]{64}$/.test(metadata.sha256) || !metadata.blobPath || !metadata.mediaType) throw new Error("Specialist artifact metadata is invalid.");
          const link = await localBinaryStore.mintSpecialistArtifactReference(run.tenantId, request.project ?? config.memoryDefaultProject, run.runId, metadata.blobPath, metadata.mediaType, 900000);
          context.signal.throwIfAborted();
          return { metadataPath, downloadUrl: link.downloadUrl, expiresAt: link.expiresAt, sha256: metadata.sha256 };
        } } : {}),
        requestHumanInput: async () => { throw new Error("Human input must be handled by the durable upstream run service."); },
        continuation: { save: async () => { throw new Error("Checkpoint must be handled by the durable upstream run service."); } },
        isActionablePipelineApproved: async () => false,
      };
    },
  }) : undefined;
  return {
    credentials,
    perUser,
    readiness: perUser ? new SandboxReadiness(client) : new CopilotReadiness(credentials!, client, options.logger),
    ...(localBinaryStore ? { localArtifactReference: async (tenantId, project, metadataPath) => {
      const stored = await store.get(tenantId, project, metadataPath);
      if (!stored) return undefined;
      const meta = JSON.parse(stored.content) as {kind?:string;path?:string;blobPath?:string;sha256?:string;mediaType?:string;bytes?:number};
      if (meta.kind !== "local-specialist-artifact") return undefined;
      if (!meta.path || metadataPath !== meta.path + ".artifact.json" || !meta.blobPath || !meta.sha256 || !meta.mediaType || !meta.bytes) throw new Error("Invalid specialist artifact metadata.");
      const runId = meta.blobPath.split("/")[3];
      const prefix = `specialists/${encodeURIComponent(tenantId)}/${project}/`;
      if (!meta.blobPath.startsWith(prefix) || !runId) throw new Error("Specialist artifact crosses project or tenant boundary.");
      const bytes = await localBinaryStore.getObject(meta.blobPath);
      if (!bytes || bytes.byteLength !== meta.bytes || createHash("sha256").update(bytes).digest("hex") !== meta.sha256) throw new Error("Stored specialist artifact does not match its immutable receipt.");
      const link = await localBinaryStore.mintSpecialistArtifactReference(tenantId, project, runId, meta.blobPath, meta.mediaType, 900000);
      return {downloadUrl:link.downloadUrl,expiresAt:link.expiresAt,sha256:meta.sha256,mediaType:meta.mediaType};
    } } : {}),
    ...(localBinaryStore ? { localArtifactChunk: async (tenantId: string, project: string, metadataPath: string, offset: number) => {
      const stored = await store.get(tenantId, project, metadataPath);
      if (!stored) return undefined;
      const meta = JSON.parse(stored.content) as {kind?:string;path?:string;blobPath?:string;sha256?:string;mediaType?:string;bytes?:number};
      if (meta.kind !== "local-specialist-artifact" || !meta.path || metadataPath !== meta.path + ".artifact.json" ||
          !meta.blobPath?.startsWith(`specialists/${encodeURIComponent(tenantId)}/${project}/`) ||
          /[?#]/.test(meta.blobPath) || !meta.sha256 || !/^[a-f0-9]{64}$/.test(meta.sha256) ||
          !Number.isSafeInteger(meta.bytes) || !meta.bytes || meta.bytes > 8000000 ||
          !["image/png","application/vnd.openxmlformats-officedocument.wordprocessingml.document"].includes(meta.mediaType ?? "")) {
        throw new Error("Invalid scoped specialist artifact metadata.");
      }
      const bytes = await localBinaryStore.getObject(meta.blobPath);
      if (!bytes || bytes.byteLength !== meta.bytes || createHash("sha256").update(bytes).digest("hex") !== meta.sha256) {
        throw new Error("Stored binary does not match its immutable receipt.");
      }
      if (!Number.isSafeInteger(offset) || offset < 0 || offset >= bytes.byteLength) throw new Error("Binary offset is outside its immutable byte range.");
      const end = Math.min(bytes.byteLength, offset + 4096);
      return {base64:Buffer.from(bytes.subarray(offset,end)).toString("base64"),offset,
        nextOffset:end < bytes.byteLength ? end : null,totalBytes:bytes.byteLength,sha256:meta.sha256,mediaType:meta.mediaType!};
    } } : {}),
    ...(upstreamService ? { upstreamRun: async (run, request, workspace, onCompletion) => {
      const result = await upstreamService.run(run, workspace, request, onCompletion);
      if (!result) return undefined;
      const common = { kind: "embedded" as const, matchedRouting: { routingIntent: "upstream", role: "Squad Coordinator", tier: "confirm", parallelEligible: false, council: [], catchAll: true, gates: true }, runId: run.runId, backendId: "copilot-sdk", artifact: result.artifact, usage: result.usage };
      if (result.status === "held") return { ...common, outcome: "held" as const, reason: "awaiting human input", humanInput: result.humanInput };
      if (result.status === "failed") return { ...common, outcome: "denied" as const, reason: result.reason };
      return { ...common, outcome: "completed" as const };
    } } : {}),
    stageExecutorFactory: (workspace, project, runId, stageOptions) => {
      const make = (
        gitHubTokenProvider: (args: { reason?: string }) => Promise<GitHubTokenProviderResult>,
        identityStatus: () => CopilotIdentityStatus,
        sessionClient = client,
      ) => new CopilotStageExecutor({
        client: sessionClient,
        workspace,
        store,
        sessionState,
        project: project ?? config.memoryDefaultProject,
        runId,
        model: config.copilot.model || undefined,
        routing: config.copilot.routing,
        gitHubTokenProvider,
        identityStatus,
        builtInTools: config.copilot.upstreamRuntime
          ? (config.copilot.tools.length ? config.copilot.tools : ["view", "create", "edit", "web_fetch"])
            .filter(name => !["bash", "glob", "grep"].includes(name))
          : config.copilot.tools.length > 0 ? config.copilot.tools : undefined,
        allowShell: config.copilot.allowShell && !config.copilot.upstreamRuntime,
        delegation: config.copilot.subagents,
        network: { allowedHosts: config.copilot.allowedHosts },
        sandboxWorkspace: config.copilot.sandboxWorkspace,
        deadlineMs: stageOptions?.deadlineMs,
        onCompletion: stageOptions?.onCompletion,
      });
      if (!perUser) return make(credentials!.tokenProvider, () => credentials!.status());
      // Per user: the owner is read from the run record when the first stage executes.
      return perUserStageExecutor({
        runs: options.runStateStore!,
        credentials: perUser.credentials,
        runId,
        build: ({ tokenProvider, identity, run }) => make(
          tokenProvider, () => identity,
          { ...client, ...userSessionClient(client, perUser, run) },
        ),
      });
    },
    ...(perUser ? { runPreflight: perUser.runPreflight } : {}),
  };
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
    audiences: config.audiences,
    allowedIssuers: config.allowedIssuers,
    allowedTenants: config.allowedTenants,
    allowedClientsByAudience: config.allowedClientsByAudience,
    requireDelegatedUser: config.perUserGithub.enabled,
    verifier: createJoseVerifier({
      jwksUri,
      issuer: config.allowedIssuers.length > 0 ? config.allowedIssuers : undefined,
    }),
    logger,
  });

  const backend = new AzureOpenAIBackend({
    endpoint: config.modelEndpoint,
    deployment: config.modelDeployment,
    api: config.modelApi,
    chatProfile: config.modelChatProfile,
    apiVersion: config.modelApiVersion,
    defaultMaxOutputTokens: config.modelMaxOutputTokens,
    reasoningEffort: config.modelReasoningEffort,
    verbosity: config.modelVerbosity,
    getAccessToken: createManagedIdentityTokenProvider(),
    logger,
    pricing: modelPricingFromEnvironment(env),
  });

  // HIGH-1 / WI-06: the gated async pipeline is exposed ONLY when the operator
  // enabled it, with a durable run-state store and an auditable approval channel.
  // Otherwise the surface stays hero-only (the council-gated default).
  const stack = buildRunStateStack(config, logger);

  // The shared-state memory broker is built only when the operator enabled it
  // (off by default). The SAME store instance serves the resource read surface
  // and the write-back tool (wired in later phases).
  const memoryStack = buildSquadMemoryStack(config, logger);
  const copilotRuntime = buildCopilotRuntime(config, memoryStack, { env, logger, runStateStore: stack?.runStateStore });

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
      ...(config.perUserGithub.enabled ? {
        userConcurrency: 1,
        userMonthlyCeilingUsd: config.tenantMonthlyCostCeilingUsd / Math.max(1, config.tenantConcurrency),
      } : {}),
    }),
    gates: new GateKeeper({ advisoryAutopilotEnabled: config.advisoryAutopilotEnabled }),
    runStateStore: stack?.runStateStore,
    runTtlMs: config.perUserGithub.enabled ? 7 * 24 * 60 * 60_000 : undefined,
    approvals: stack?.approvals,
    // WI-1b4-WORKER: when a worker is enabled, the poll is read-only and the ACA
    // Job drives approved runs off the request path (runs may exceed 240s).
    driveOnPoll: !config.workerEnabled,
    // Without a worker, a poll that claims a run returns within this budget and the
    // run continues in-process, so long stages never hold a request past the 240s
    // ingress ceiling (which MCP clients report as an unreachable connector).
    pollDriveWaitMs: config.workerEnabled ? undefined : POLL_DRIVE_WAIT_MS,
    leaseMs: config.copilot.upstreamRuntime ? 40 * 60 * 1000 : undefined,
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
    researchArtifacts:
      config.enableArtifacts && config.memoryAutoEnabled && memoryStack
        ? new MemoryBackedArtifactStore(memoryStack.memoryStore)
        : undefined,
    stageExecutorFactory: copilotRuntime?.stageExecutorFactory,
    upstreamRun: copilotRuntime?.upstreamRun,
    runPreflight: copilotRuntime?.runPreflight,
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
    readiness: copilotRuntime?.readiness,
    userIdentity: copilotRuntime?.perUser?.gate,
    linkRoutes: copilotRuntime?.perUser?.linkRoutes,
    localArtifactReference: copilotRuntime?.localArtifactReference,
    localArtifactChunk: copilotRuntime?.localArtifactChunk,
  });
}

/**
 * Verify the instance can do its work before accepting traffic. With the
 * Copilot executor that means a GitHub identity verified for Copilot; the
 * server refuses to start without one rather than serving tools that would fail.
 */
export async function prepareReadiness(handler: HttpMcpHandler, logger: RedactingLogger): Promise<void> {
  if (!handler.readiness) return;
  const report = await handler.readiness.prepare();
  const fatal = Object.entries(report.checks).filter(([, check]) => check.fatal && !check.ok);
  if (fatal.length > 0) {
    throw new Error(`Refusing to start: ${fatal.map(([name, check]) => `${name}: ${check.reason}`).join("; ")}`);
  }
  if (!report.ready) {
    // Recoverable (for example, the sandbox is not up yet): serve, report 503 at /readyz, keep retrying.
    logger.warn("starting while not ready", Object.fromEntries(Object.entries(report.checks).map(([name, check]) => [name, check.reason])));
  }
}

/** Start the live HTTP server. */
export async function mainHttp(): Promise<void> {
  const logger = new RedactingLogger({ name: "hve-squad-mcp-http" });
  const config = loadOperatorConfig();
  const handler = buildHttpHandler(config, process.env, logger);
  await prepareReadiness(handler, logger);
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
