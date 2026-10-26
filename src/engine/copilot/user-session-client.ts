import type { CopilotClientPort, CopilotSessionConfig, CopilotSessionPort } from "./copilot-stage-executor.js";
import type { PerUserStack } from "../../server-per-user.js";
import type { RunState } from "../run-state.js";
import { StageBlockedError } from "../research-runtime.js";

/** Bound to one saved run, never to whichever user happens to poll it later. */
export function userSessionClient(
  client: CopilotClientPort,
  users: Pick<PerUserStack, "runPreflight" | "tokenProviderForRun">,
  run: RunState,
): CopilotClientPort {
  const verify = async () => {
    const result = await users.runPreflight(run);
    if (!result.ok) throw new StageBlockedError(result.code, result.reason);
  };
  const wrap = async (config: CopilotSessionConfig, resumeId?: string): Promise<CopilotSessionPort> => {
    await verify();
    const original = config.hooks.onPreToolUse;
    const guarded: CopilotSessionConfig = {
      ...config,
      gitHubToken: undefined,
      gitHubTokenProvider: users.tokenProviderForRun(run),
      hooks: {
        ...config.hooks,
        onPreToolUse: async input => {
          await verify();
          return original(input);
        },
      },
    };
    const session = resumeId
      ? await client.resumeSession!(resumeId, guarded)
      : await client.createSession(guarded);
    return {
      ...session,
      ...(session.runServerCommand ? {
        runServerCommand: async (command: string) => {
          await verify();
          return session.runServerCommand!(command);
        },
      } : {}),
      sendAndWait: async (...args) => {
        await verify();
        let checking = false;
        let denied: unknown;
        const monitor = setInterval(() => {
          if (checking) return;
          checking = true;
          void verify().catch(error => {
            denied = error;
            return session.abort();
          }).catch(() => {
            // The original identity failure is surfaced after the turn settles.
          }).finally(() => { checking = false; });
        }, 15_000);
        monitor.unref();
        try {
          const result = await session.sendAndWait(...args);
          if (denied) throw denied;
          await verify();
          return result;
        } catch (error) {
          if (denied) throw denied;
          throw error;
        } finally {
          clearInterval(monitor);
        }
      },
    };
  };
  return {
    createSession: config => wrap(config),
    ...(client.resumeSession ? { resumeSession: (id: string, config: CopilotSessionConfig) => wrap(config, id) } : {}),
    ...(client.ping ? { ping: () => client.ping!() } : {}),
  };
}
