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

import { loadOperatorConfig, type OperatorConfig } from "./config/operator-config.js";
import { EmbeddedCoordinator } from "./engine/embedded.js";
import { EphemeralWorkspaceManager } from "./engine/workspace.js";
import { GateKeeper, TenantQuotaTracker } from "./engine/gates.js";
import { RunWorker } from "./engine/run-worker.js";
import { AzureOpenAIBackend, type ModelPricing } from "./engine/backends/azure-openai.js";
import { createManagedIdentityTokenProvider } from "./engine/backends/managed-identity-credential.js";
import { RedactingLogger } from "./observability/logger.js";
import { buildRunStateStack } from "./server-http.js";

function readPricing(env: NodeJS.ProcessEnv): ModelPricing | undefined {
  const input = Number(env.SQUAD_MCP_PRICE_INPUT_PER_MTOK);
  const output = Number(env.SQUAD_MCP_PRICE_OUTPUT_PER_MTOK);
  if (Number.isFinite(input) && Number.isFinite(output)) {
    return { inputPerMTokUsd: input, outputPerMTokUsd: output };
  }
  return undefined;
}

/** Default seconds between worker ticks. */
const DEFAULT_WORKER_INTERVAL_MS = 5000;

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
    apiVersion: config.modelApiVersion,
    getAccessToken: createManagedIdentityTokenProvider(),
    logger,
    pricing: readPricing(env),
  });

  const coordinator = new EmbeddedCoordinator({
    backend,
    workspaceManager: new EphemeralWorkspaceManager(),
    quota: new TenantQuotaTracker({
      concurrency: config.tenantConcurrency,
      monthlyCeilingUsd: config.tenantMonthlyCostCeilingUsd,
    }),
    gates: new GateKeeper(),
    runStateStore: stack.runStateStore,
    approvals: stack.approvals,
    logger,
  });

  return new RunWorker({ coordinator, logger });
}

/** Start the live worker. Runs a single drain pass when `SQUAD_MCP_WORKER_ONCE=true`
 * (the scheduled ACA Job model), otherwise loops until SIGTERM (continuous model). */
export async function mainWorker(): Promise<void> {
  const logger = new RedactingLogger({ name: "hve-squad-mcp-worker" });
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
