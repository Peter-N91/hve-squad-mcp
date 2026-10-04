/**
 * Readiness for the Copilot stage executor: the server-owned GitHub identity is
 * verified for Copilot, and the sandbox runtime answers.
 */
import type { RedactingLogger } from "../../observability/logger.js";
import type { ReadinessProbe, ReadinessReport } from "../../transports/readiness.js";
import type { CopilotCredentials } from "./copilot-credentials.js";

const PING_TIMEOUT_MS = 3_000;

export class CopilotReadiness implements ReadinessProbe {
  constructor(
    private readonly credentials: CopilotCredentials,
    private readonly runtime: { ping?(): Promise<unknown> },
    private readonly logger?: RedactingLogger,
  ) {}

  async prepare(): Promise<ReadinessReport> {
    const identity = await this.credentials.verify();
    this.logger?.info("copilot identity verification", { ready: identity.ready, reason: identity.reason, models: identity.models });
    this.credentials.startMonitoring((status) => {
      const log = status.ready ? this.logger?.info.bind(this.logger) : this.logger?.error.bind(this.logger);
      log?.("copilot identity changed", { ready: status.ready, reason: status.reason });
    });
    return this.check();
  }

  async check(): Promise<ReadinessReport> {
    const identity = this.credentials.status();
    const sandbox = await this.pingRuntime();
    return {
      ready: identity.ready && sandbox.ok,
      checks: {
        copilotIdentity: {
          ok: identity.ready,
          reason: identity.reason,
          ...(!identity.ready && identity.cause === "credential" ? { fatal: true } : {}),
        },
        sandboxRuntime: sandbox,
      },
    };
  }

  private async pingRuntime(): Promise<{ ok: boolean; reason: string }> {
    if (!this.runtime.ping) return { ok: true, reason: "No liveness probe available." };
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.runtime.ping(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timed out")), PING_TIMEOUT_MS); }),
      ]);
      return { ok: true, reason: "Sandbox runtime answered." };
    } catch (error) {
      return { ok: false, reason: `Sandbox runtime unreachable: ${error instanceof Error ? error.message : String(error)}` };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
