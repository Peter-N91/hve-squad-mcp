/**
 * Adapter from the optional `@github/copilot-sdk` package to
 * {@link CopilotClientPort}. The SDK is imported on first use, so deployments
 * that keep the built-in stage runtime never load it.
 *
 * The client always connects to an already-running runtime (`copilot
 * --headless`) in a separate sandbox; it never spawns one beside the server.
 */
import { randomUUID } from "node:crypto";

import type {
  CopilotClientPort,
  CopilotSessionConfig,
  CopilotSessionEvent,
  CopilotSessionPort,
} from "./copilot-stage-executor.js";
import { type CopilotEntitlementVerifier, CopilotRuntimeUnavailableError } from "./copilot-credentials.js";

export interface CopilotSdkClientOptions {
  /** `host:port` or URL of the sandbox runtime. */
  cliUrl: string;
  /** Shared secret the sandbox runtime was started with (`COPILOT_CONNECTION_TOKEN`). */
  connectionToken: string;
  /** Absolute POSIX path where the project is mounted in the sandbox (default `/workspace`). */
  workspaceMount?: string;
}

export interface CopilotSdkClient extends CopilotClientPort {
  listModels(): Promise<string[]>;
  /** Proves a token can use Copilot without making it the runtime's account. */
  entitlementVerifier(): CopilotEntitlementVerifier;
  stop(): Promise<void>;
}

type Sdk = typeof import("@github/copilot-sdk");
type SdkClient = InstanceType<Sdk["CopilotClient"]>;
type SdkSessionConfig = Parameters<SdkClient["createSession"]>[0];

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function loadSdk(): Promise<Sdk> {
  try {
    return await import("@github/copilot-sdk");
  } catch (error) {
    throw new Error(
      "SQUAD_MCP_STAGE_EXECUTOR=copilot requires the optional @github/copilot-sdk dependency, which is not installed.",
      { cause: error },
    );
  }
}

function toSdkConfig(sdk: Sdk, config: CopilotSessionConfig): SdkSessionConfig {
  return {
    sessionId: config.sessionId,
    ...(config.model ? { model: config.model } : {}),
    systemMessage: config.systemMessage,
    availableTools: config.availableTools,
    tools: config.tools.map((tool) => sdk.defineTool(tool.name, {
      description: tool.description,
      parameters: tool.parameters,
      handler: (args) => tool.handler(args),
      skipPermission: tool.skipPermission,
      isTerminal: tool.isTerminal,
    })),
    hooks: {
      onPreToolUse: (input) => config.hooks.onPreToolUse({ toolName: input.toolName, toolArgs: input.toolArgs, sessionId: input.sessionId }),
      onPostToolUse: (input) => config.hooks.onPostToolUse({
        toolName: input.toolName,
        toolArgs: input.toolArgs,
        toolResult: input.toolResult,
        sessionId: input.sessionId,
      }),
    },
    ...(config.customAgents?.length ? { customAgents: config.customAgents } : {}),
    onPermissionRequest: (request) => config.onPermissionRequest(request as unknown as Parameters<CopilotSessionConfig["onPermissionRequest"]>[0]),
    createSessionFsProvider: () => config.fileSystem as unknown as ReturnType<NonNullable<SdkSessionConfig["createSessionFsProvider"]>>,
    ...(config.gitHubTokenProvider
      ? { gitHubTokenProvider: (args: { reason?: string }) => config.gitHubTokenProvider!({ reason: args.reason }) }
      : config.gitHubToken ? { gitHubToken: config.gitHubToken } : {}),
    workingDirectory: config.workingDirectory,
    streaming: config.streaming,
  } as SdkSessionConfig;
}

function toSessionPort(session: Awaited<ReturnType<SdkClient["createSession"]>>): CopilotSessionPort {
  return {
    on: (handler) => session.on((event) => handler(event as unknown as CopilotSessionEvent)),
    sendAndWait: async (options, timeoutMs) => {
      const event = await session.sendAndWait(options, timeoutMs);
      return event ? { data: { content: event.data.content } } : undefined;
    },
    abort: () => session.abort(),
    disconnect: () => session.disconnect(),
    runServerCommand: async (command) => {
      const result = await session.rpc.shell.executeUserRequested({ requestId: randomUUID(), command });
      return { success: result.success, output: result.output, exitCode: result.exitCode };
    },
    authStatus: async () => {
      const status = await session.rpc.gitHubAuth.getStatus();
      return { isAuthenticated: status.isAuthenticated, login: status.login, copilotPlan: status.copilotPlan, statusMessage: status.statusMessage };
    },
  };
}

/** A client that connects on first use and is shared by every stage in the process. */
export function lazyCopilotSdkClient(options: CopilotSdkClientOptions): CopilotSdkClient {
  if (!options.cliUrl.trim() || !options.connectionToken.trim()) {
    throw new Error("The Copilot sandbox URL and connection token are both required.");
  }
  let ready: Promise<{ sdk: Sdk; client: SdkClient }> | undefined;
  const connect = () => {
    ready ??= (async () => {
      const sdk = await loadSdk();
      const client = new sdk.CopilotClient({
        connection: sdk.RuntimeConnection.forUri(options.cliUrl, { connectionToken: options.connectionToken }),
        mode: "empty",
        // The server is the session filesystem: file tools see the project, and the
        // runtime's conversation state is kept server-side. A runtime accepts one
        // provider, so one sandbox serves one trusted client.
        sessionFs: { initialCwd: options.workspaceMount ?? "/workspace", sessionStatePath: "/session-state", conventions: "posix" },
        logLevel: "error",
        clientInfo: { applicationName: "hve-squad-mcp" },
      });
      try {
        await client.start();
      } catch (error) {
        // A half-open connection would keep the runtime alive and hold its provider slot.
        await client.forceStop().catch(() => undefined);
        const hint = /already the session filesystem provider/i.test(errorText(error))
          ? " The runtime is still bound to a previous server instance and never releases it; restart the sandbox together with the server."
          : "";
        throw new CopilotRuntimeUnavailableError(`Could not connect to the Copilot sandbox runtime: ${errorText(error)}${hint}`, { cause: error });
      }
      return { sdk, client };
    })().catch((error: unknown) => {
      ready = undefined;
      throw error;
    });
    return ready;
  };
  // Drop a connection that no longer answers, so the next call reconnects to a restarted sandbox.
  const discard = async (client: SdkClient) => {
    const current = await ready?.catch(() => undefined);
    if (current?.client === client) ready = undefined;
    await client.forceStop().catch(() => undefined);
  };
  const answers = async (client: SdkClient) => {
    try {
      await client.ping();
      return true;
    } catch {
      return false;
    }
  };
  return {
    async createSession(config) {
      const { sdk, client } = await connect();
      return toSessionPort(await client.createSession(toSdkConfig(sdk, config)));
    },
    async resumeSession(sessionId, config) {
      const { sdk, client } = await connect();
      const { sessionId: _ignored, ...resume } = toSdkConfig(sdk, config) as SdkSessionConfig & { sessionId?: string };
      return toSessionPort(await client.resumeSession(sessionId, resume as Parameters<SdkClient["resumeSession"]>[1]));
    },
    async listModels() {
      const { client } = await connect();
      return (await client.listModels()).map((model) => model.id);
    },
    async ping() {
      const { client } = await connect();
      try {
        return await client.ping();
      } catch (error) {
        await discard(client);
        throw new CopilotRuntimeUnavailableError(`The Copilot sandbox runtime stopped answering: ${errorText(error)}`, { cause: error });
      }
    },
    entitlementVerifier() {
      return {
        async verify(token: string) {
          const { client } = await connect();
          let models: string[];
          try {
            models = (await client.rpc.models.list({ gitHubToken: token })).models.map((model) => model.id);
          } catch (error) {
            if (await answers(client)) throw error;
            await discard(client);
            throw new CopilotRuntimeUnavailableError(`The Copilot sandbox runtime stopped answering: ${errorText(error)}`, { cause: error });
          }
          let premiumRemainingPercent: number | undefined;
          try {
            const quota = await client.rpc.account.getQuota({ gitHubToken: token });
            const premium = quota.quotaSnapshots.premium_interactions;
            if (premium && !premium.isUnlimitedEntitlement) premiumRemainingPercent = premium.remainingPercentage;
          } catch {
            // Quota is informational; entitlement is proven by the model list.
          }
          return { models, ...(premiumRemainingPercent !== undefined ? { premiumRemainingPercent } : {}) };
        },
      };
    },
    async stop() {
      if (!ready) return;
      const { client } = await ready;
      ready = undefined;
      await client.stop();
    },
  };
}
