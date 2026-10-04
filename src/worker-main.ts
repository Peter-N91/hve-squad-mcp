/**
 * Live worker bootstrap (deployed ACA Job only) — WI-1b4-WORKER.
 *
 * Drives approved async runs off the request path so a run may exceed the 240s
 * HTTP ingress ceiling. It binds to the SAME cross-replica run-state + approval
 * store as the web tier (via {@link buildRunStateStack}), so an operator approval
 * recorded on the web tier is visible here. Like `server-http.ts`, this is the
 * only worker entry that pulls in the live-only managed-identity credential; tests
 * inject fakes and never import it.
 *
 * The worker requires the `table` backend (shared, cross-replica) — enforced by
 * operator-config — so a single-replica `file` deployment keeps the poll-drives
 * behavior and does NOT run a worker.
 */
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

import { loadOperatorConfig, type OperatorConfig } from "./config/operator-config.js";
import { EmbeddedCoordinator } from "./engine/embedded.js";
import { EphemeralWorkspaceManager } from "./engine/workspace.js";
import { GateKeeper, TenantQuotaTracker } from "./engine/gates.js";
import { RunWorker, WORKER_EXECUTION_OPTIONS } from "./engine/run-worker.js";
import { AzureOpenAIBackend, modelPricingFromEnvironment } from "./engine/backends/azure-openai.js";
import { createManagedIdentityTokenProvider } from "./engine/backends/managed-identity-credential.js";
import { RedactingLogger } from "./observability/logger.js";
import { buildRunStateStack, buildSquadMemoryStack } from "./server-http.js";
import { AutoMemory } from "./engine/auto-memory.js";
import { MemoryBackedArtifactStore } from "./engine/artifact-store.js";
import { SquadRunRecorder } from "./engine/squad-run-recorder.js";

/** Default seconds between worker ticks. */
const DEFAULT_WORKER_INTERVAL_MS = 5000;

/** Hash-only evidence from naturally scheduled jobs; never starts a model run. */
export function workerDiagnosticRuntime(read: (url: URL) => Uint8Array = readFileSync) {
  return Object.fromEntries([
    "./engine/backends/provider-validation.js", "./engine/backends/azure-openai.js", "./worker-main.js",
  ].map(path => [path, createHash("sha256").update(read(new URL(path, import.meta.url))).digest("hex")]));
}

/** Build a {@link RunWorker} bound to the shared cross-replica run-state stack. */
export function buildWorker(
  config: OperatorConfig,
  env: NodeJS.ProcessEnv = process.env,
  logger: RedactingLogger = new RedactingLogger({ name: "hve-squad-mcp-worker" }),
): RunWorker {
  const stack = buildRunStateStack(config, logger);
  if (!stack) {
    throw new Error("The worker requires the remote pipeline to be enabled (SQUAD_MCP_REMOTE_PIPELINE_ENABLED=true).");
  }

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

  const memoryStack = buildSquadMemoryStack(config, logger);
  const artifactStore = config.enableArtifacts && config.memoryAutoEnabled && memoryStack
    ? new MemoryBackedArtifactStore(memoryStack.memoryStore) : undefined;
  const coordinator = new EmbeddedCoordinator({
    ...WORKER_EXECUTION_OPTIONS,
    backend,
    workspaceManager: new EphemeralWorkspaceManager(),
    quota: new TenantQuotaTracker({
      concurrency: config.tenantConcurrency,
      monthlyCeilingUsd: config.tenantMonthlyCostCeilingUsd,
    }),
    gates: new GateKeeper({ advisoryAutopilotEnabled: config.advisoryAutopilotEnabled }),
    runStateStore: stack.runStateStore,
    approvals: stack.approvals,
    autoMemory: config.memoryAutoEnabled && memoryStack
      ? new AutoMemory({ store: memoryStack.memoryStore, defaultProject: config.memoryDefaultProject, logger })
      : undefined,
    runRecorder: artifactStore ? new SquadRunRecorder({ store: artifactStore, logger }) : undefined,
    researchArtifacts: artifactStore,
    logger,
  });

  return new RunWorker({ coordinator, logger, batchSize: 1 });
}

/** Start the live worker. Runs a single drain pass when `SQUAD_MCP_WORKER_ONCE=true`
 * (the scheduled ACA Job model), otherwise loops until SIGTERM (continuous model). */
export async function mainWorker(): Promise<void> {
  const logger = new RedactingLogger({ name: "hve-squad-mcp-worker" });
  try {
    logger.info("Provider diagnostic runtime", { schemaVersion: 2, moduleSha256: workerDiagnosticRuntime() });
  } catch {
    logger.warn("Provider diagnostic runtime hashes unavailable");
  }
  const config = loadOperatorConfig();
  const worker = buildWorker(config, process.env, logger);

  if ((process.env.SQUAD_MCP_WORKER_ONCE ?? "").trim().toLowerCase() === "true") {
    const result = await worker.tickOnce();
    logger.info("hve-squad MCP worker tick complete", { ...result });
    return;
  }

  const intervalMs = Number(process.env.SQUAD_MCP_WORKER_INTERVAL_MS ?? DEFAULT_WORKER_INTERVAL_MS);
  const controller = new AbortController();
  process.on("SIGTERM", () => controller.abort());
  process.on("SIGINT", () => controller.abort());
  logger.info("hve-squad MCP worker started", { intervalMs });
  await worker.runForever(intervalMs, controller.signal);
  logger.info("hve-squad MCP worker stopped");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  mainWorker().catch((error: unknown) => {
    process.stderr.write(`[hve-squad-mcp-worker] fatal: ${String(error)}\n`);
    process.exit(1);
  });
}
