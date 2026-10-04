/**
 * The GitHub identity the Copilot runtime uses, owned by the server.
 *
 * Sandboxes start signed out and never hold a stored login. Every Copilot
 * session instead receives its identity from the server through the SDK's
 * per-session token provider, which the runtime calls when the session starts
 * and again before the token expires. The token therefore never needs to be
 * entered in a sandbox, survives sandbox replacement, and follows rotation of
 * the underlying credential without a restart.
 *
 * The server must not claim it can run agentic work without a usable identity,
 * so {@link CopilotCredentials.verify} proves Copilot entitlement (the runtime
 * resolves the token and lists the models it may use), and the result drives
 * startup, readiness and per-stage checks. Status never contains the token.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";

/** Where the server reads the GitHub token from; re-read on every refresh. */
export interface GitHubCredentialSource {
  readonly description: string;
  read(): Promise<string>;
}

/** An environment variable, read at each acquisition. */
export class EnvCredentialSource implements GitHubCredentialSource {
  readonly description: string;
  constructor(private readonly name: string, private readonly env: NodeJS.ProcessEnv = process.env) {
    this.description = `environment variable ${name}`;
  }
  async read(): Promise<string> {
    return (this.env[this.name] ?? "").trim();
  }
}

/** A file, typically a mounted secret that the platform rotates in place. */
export class FileCredentialSource implements GitHubCredentialSource {
  readonly description: string;
  constructor(private readonly path: string) {
    this.description = `file ${path}`;
  }
  async read(): Promise<string> {
    return (await readFile(this.path, "utf8")).trim();
  }
}

/**
 * A command that prints the token, such as `gh auth token`, which reads the
 * GitHub CLI login from the OS keychain. Run without a shell; stderr and the
 * token are never logged.
 */
export class CommandCredentialSource implements GitHubCredentialSource {
  readonly description: string;
  constructor(private readonly argv: readonly string[], private readonly timeoutMs = 15_000) {
    if (argv.length === 0 || !argv[0]) throw new Error("A credential command needs an executable.");
    this.description = `command ${argv[0]}`;
  }
  read(): Promise<string> {
    const [file, ...args] = this.argv;
    return new Promise((resolve, reject) => {
      execFile(file, args, { timeout: this.timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 }, (error, stdout) => {
        if (error) {
          reject(new Error(`${this.description} failed (${(error as NodeJS.ErrnoException).code ?? "exit"})`));
          return;
        }
        resolve(String(stdout).trim());
      });
    });
  }
}

/** Proves a token can use Copilot; throws with a reason when it cannot. */
export interface CopilotEntitlementVerifier {
  verify(token: string): Promise<{ models: string[]; premiumRemainingPercent?: number }>;
}

/**
 * The sandbox runtime could not be reached, so the identity was not checked.
 * Waiting can fix this; a bad credential cannot.
 */
export class CopilotRuntimeUnavailableError extends Error {
  override readonly name = "CopilotRuntimeUnavailableError";
}

export interface CopilotIdentityStatus {
  ready: boolean;
  checkedAt?: string;
  /** Safe, token-free explanation for operators and readiness probes. */
  reason: string;
  /** Why the identity is not ready: the credential itself, or an unreachable runtime. */
  cause?: "credential" | "runtime";
  models?: number;
  premiumRemainingPercent?: number;
}

export type GitHubTokenProviderResult =
  | { kind: "token"; accessToken: string; expiresIn: number; tokenType?: string }
  | { kind: "cancelled" };

export interface CopilotCredentialsOptions {
  source: GitHubCredentialSource;
  verifier: CopilotEntitlementVerifier;
  /** How long a read token is reused before the source is consulted again. */
  cacheMs?: number;
  /**
   * Lifetime reported to the runtime for a token whose real expiry is unknown.
   * Must exceed the runtime's one-hour refresh threshold; the runtime asks again
   * before it elapses, which re-reads the source.
   */
  assumedLifetimeSeconds?: number;
  /** Interval between background re-verifications. */
  reverifyMs?: number;
  /** Interval between attempts while the identity is not verified (default 30 s, at most `reverifyMs`). */
  retryMs?: number;
  now?: () => number;
}

const TOKEN_SHAPE = /^[A-Za-z0-9_\-.]{20,512}$/;
const MIN_LIFETIME_SECONDS = 3_601;

export class CopilotCredentials {
  private cached?: { token: string; readAt: number };
  private current: CopilotIdentityStatus = { ready: false, reason: "Copilot identity not verified yet." };
  private monitor?: NodeJS.Timeout;
  private generation = 0;
  private inflight?: Promise<CopilotIdentityStatus>;

  constructor(private readonly options: CopilotCredentialsOptions) {
    if ((options.assumedLifetimeSeconds ?? 8 * 3600) < MIN_LIFETIME_SECONDS) {
      throw new Error("The assumed token lifetime must exceed one hour.");
    }
  }

  private now(): number { return this.options.now?.() ?? Date.now(); }

  /** The current token, from cache or freshly read from the source. */
  async token(fresh = false): Promise<string> {
    const cacheMs = this.options.cacheMs ?? 5 * 60_000;
    if (!fresh && this.cached && this.now() - this.cached.readAt < cacheMs) return this.cached.token;
    let token: string;
    try {
      token = await this.options.source.read();
    } catch (error) {
      throw new Error(`Could not read the GitHub token from ${this.options.source.description}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!token) throw new Error(`No GitHub token is available from ${this.options.source.description}.`);
    if (!TOKEN_SHAPE.test(token)) throw new Error(`The value from ${this.options.source.description} is not a GitHub token.`);
    this.cached = { token, readAt: this.now() };
    return token;
  }

  /** SDK `gitHubTokenProvider`: initial acquisition and pre-expiry refresh both re-read the source. */
  readonly tokenProvider = async (args: { reason?: string }): Promise<GitHubTokenProviderResult> => ({
    kind: "token",
    accessToken: await this.token(args.reason === "refresh"),
    expiresIn: this.options.assumedLifetimeSeconds ?? 8 * 3600,
  });

  /** Re-read the token and prove Copilot entitlement. Concurrent callers share one check. */
  verify(): Promise<CopilotIdentityStatus> {
    this.inflight ??= (async () => {
      const checkedAt = new Date(this.now()).toISOString();
      try {
        const token = await this.token(true);
        const result = await this.options.verifier.verify(token);
        if (result.models.length === 0) throw new Error("The identity has no Copilot models available.");
        const exhausted = result.premiumRemainingPercent !== undefined && result.premiumRemainingPercent <= 0;
        this.current = {
          ready: true,
          checkedAt,
          reason: exhausted ? "Copilot identity verified; premium request quota is exhausted." : "Copilot identity verified.",
          models: result.models.length,
          ...(result.premiumRemainingPercent !== undefined ? { premiumRemainingPercent: result.premiumRemainingPercent } : {}),
        };
      } catch (error) {
        this.cached = undefined;
        this.current = {
          ready: false,
          checkedAt,
          reason: error instanceof Error ? error.message : String(error),
          cause: error instanceof CopilotRuntimeUnavailableError ? "runtime" : "credential",
        };
      }
      return this.current;
    })().finally(() => { this.inflight = undefined; });
    return this.inflight;
  }

  /** Last verification result; not ready when it is older than two monitor intervals. */
  status(): CopilotIdentityStatus {
    const reverifyMs = this.options.reverifyMs ?? 10 * 60_000;
    if (this.current.ready && this.current.checkedAt && this.now() - Date.parse(this.current.checkedAt) > 2 * reverifyMs) {
      return { ...this.current, ready: false, reason: "Copilot identity verification is stale." };
    }
    return { ...this.current };
  }

  /**
   * Re-verify in the background so an expired or revoked login is noticed
   * without traffic, and an unverified identity (for example, a sandbox that
   * was not up yet) becomes ready soon after it can be verified.
   */
  startMonitoring(onChange?: (status: CopilotIdentityStatus) => void): void {
    this.stopMonitoring();
    const generation = this.generation;
    const reverifyMs = this.options.reverifyMs ?? 10 * 60_000;
    const retryMs = Math.min(this.options.retryMs ?? 30_000, reverifyMs);
    const schedule = () => {
      this.monitor = setTimeout(() => {
        const before = { ready: this.current.ready, reason: this.current.reason };
        void this.verify().then((status) => {
          if (generation !== this.generation) return;
          if (status.ready !== before.ready || status.reason !== before.reason) onChange?.(status);
          schedule();
        });
      }, this.current.ready ? reverifyMs : retryMs);
      this.monitor.unref();
    };
    schedule();
  }

  stopMonitoring(): void {
    this.generation += 1;
    if (this.monitor) clearTimeout(this.monitor);
    this.monitor = undefined;
  }
}
