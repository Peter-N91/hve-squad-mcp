/**
 * Assembles per-user GitHub identity from operator config: the link service
 * (store, sealing, GitHub OAuth, Entra browser sign-in), the per-user Copilot
 * credentials, the transport gate and the engine preflight.
 *
 * Imported only by the live bootstrap (it pulls in `jose` through the verifier),
 * like server-http.ts; tests assemble the same pieces with fakes.
 */
import type { PerUserGithubConfig } from "./config/operator-config.js";
import { createJoseVerifier } from "./auth/jose-verifier.js";
import { PrincipalVault } from "./auth/principal-vault.js";
import type { CopilotEntitlementVerifier } from "./engine/copilot/copilot-credentials.js";
import { perUserRunPreflight } from "./engine/copilot/per-user-executor.js";
import { PerUserCopilotCredentials, type UserIdentityStatus } from "./engine/copilot/user-credentials.js";
import {
  EntraBrowserSignIn,
  FileGitHubLinkStore,
  GitHubLinkService,
  GitHubOAuthClient,
  type GitHubLinkStore,
  type LinkFlowStore,
} from "./github-link/index.js";
import type { RedactingLogger } from "./observability/logger.js";
import type { ReadinessProbe, ReadinessReport } from "./transports/readiness.js";
import { UserIdentityGate, type GitHubLinkFacade } from "./transports/user-identity-gate.js";
import type { HttpRequestLike, HttpResponseLike } from "./transports/http-core.js";
import type { RunState } from "./engine/run-state.js";

/** Catalog tools that run Copilot-backed work for the caller and need an admitted user. */
export const COPILOT_EXECUTION_TOOLS: ReadonlySet<string> = new Set([
  "squad_research", "squad_review", "squad_plan", "squad_architect", "squad_run", "squad_federate",
]);

export interface PerUserStack {
  service: GitHubLinkService;
  credentials: PerUserCopilotCredentials;
  gate: UserIdentityGate;
  linkRoutes: (req: HttpRequestLike) => Promise<HttpResponseLike | undefined>;
  runPreflight: ReturnType<typeof perUserRunPreflight>;
  /** Verify the exact saved user/account/generation, not a process-wide identity cache. */
  statusForRun(run: Pick<RunState, "tenantId" | "owner">): UserIdentityStatus | undefined | Promise<UserIdentityStatus | undefined>;
  tokenProviderForRun(run: Pick<RunState, "tenantId" | "owner">): ReturnType<PerUserCopilotCredentials["tokenProviderFor"]>;
}

export interface PerUserStackDeps {
  verifier: CopilotEntitlementVerifier;
  logger?: RedactingLogger;
  /** Shared stores for multi-replica deployments; the file store is used when absent. */
  linkStore?: GitHubLinkStore;
  flowStore?: LinkFlowStore;
  fetchImpl?: typeof fetch;
}

export function githubCredentialVault(config: PerUserGithubConfig): PrincipalVault {
  return new PrincipalVault(config.linkKeyId, {
    ...Object.fromEntries(Object.entries(config.previousLinkKeys).map(([id, key]) => [id, Buffer.from(key, "base64")])),
    [config.linkKeyId]: Buffer.from(config.linkKeyBase64, "base64"),
  });
}

export function buildPerUserStack(config: PerUserGithubConfig, deps: PerUserStackDeps): PerUserStack {
  if (!config.enabled) throw new Error("Per-user GitHub identity is not enabled.");
  if (config.linkStore.kind === "table" && !deps.linkStore) {
    throw new Error("The table link store must be supplied by the bootstrap (managed identity token).");
  }
  const tenant = encodeURIComponent(config.entra.tenantId);
  const service = new GitHubLinkService({
    store: deps.linkStore ?? new FileGitHubLinkStore(config.linkStore.kind === "file" ? config.linkStore.dir : ""),
    cipher: githubCredentialVault(config),
    oauth: new GitHubOAuthClient({
      clientId: config.github.clientId,
      clientSecret: config.github.clientSecret,
      webBaseUrl: config.github.webBaseUrl,
      apiBaseUrl: config.github.apiBaseUrl,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    }),
    entra: new EntraBrowserSignIn({
      authorizeEndpoint: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
      tokenEndpoint: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
      clientId: config.entra.clientId,
      clientSecret: config.entra.clientSecret,
      verifier: createJoseVerifier({
        jwksUri: `https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`,
        issuer: `https://login.microsoftonline.com/${config.entra.tenantId}/v2.0`,
      }),
      allowedTenantIds: [config.entra.tenantId],
      issuerForTenant: (tid) => `https://login.microsoftonline.com/${tid}/v2.0`,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    }),
    publicBaseUrl: config.publicBaseUrl,
    secureCookies: config.publicBaseUrl.startsWith("https://"),
    ...(deps.flowStore ? { flowStore: deps.flowStore } : {}),
    ...(deps.logger ? { logger: deps.logger } : {}),
  });
  const credentials = new PerUserCopilotCredentials({
    tokens: service, verifier: deps.verifier, verifyCacheMs: 0,
    githubHost: new URL(config.github.webBaseUrl).hostname,
  });
  const link: GitHubLinkFacade = {
    begin: async (principal) => {
      const begun = await service.begin(principal);
      return { url: begun.startUrl, expiresAt: begun.expiresAt };
    },
    status: (principal) => service.status(principal),
    unlink: async (principal) => { await service.unlink(principal); },
  };
  const ownerOf = (run: Pick<RunState, "tenantId" | "owner">) =>
    run.owner ? { tenantId: run.owner.authorityTenantId ?? run.tenantId, objectId: run.owner.objectId } : undefined;
  return {
    service,
    credentials,
    gate: new UserIdentityGate({ link, credentials, executionTools: COPILOT_EXECUTION_TOOLS }),
    linkRoutes: (req) => service.handleHttp(req),
    runPreflight: perUserRunPreflight(credentials),
    statusForRun: (run) => {
      const principal = ownerOf(run);
      return principal ? credentials.verifyFor(principal, {
        githubUserId: run.owner?.githubUserId, linkGeneration: run.owner?.linkGeneration,
      }) : undefined;
    },
    tokenProviderForRun: (run) => {
      const principal = ownerOf(run);
      if (!principal) throw new Error("A per-user run has no owner; refusing to fall back to a shared identity.");
      return credentials.tokenProviderFor(principal, {
        githubUserId: run.owner?.githubUserId, linkGeneration: run.owner?.linkGeneration,
      });
    },
  };
}

/**
 * Readiness when identity is per user: only the shared sandbox runtime is checked.
 * An unlinked user is a normal state for one caller, not a reason to fail the instance.
 */
export class SandboxReadiness implements ReadinessProbe {
  constructor(private readonly runtime: { ping?(): Promise<unknown> }) {}

  async prepare(): Promise<ReadinessReport> {
    return this.check();
  }

  async check(): Promise<ReadinessReport> {
    if (!this.runtime.ping) return { ready: true, checks: { sandboxRuntime: { ok: true, reason: "No liveness probe available." } } };
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.runtime.ping(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timed out")), 3_000); timer.unref(); }),
      ]);
      return { ready: true, checks: { sandboxRuntime: { ok: true, reason: "Sandbox runtime answered." } } };
    } catch (error) {
      return { ready: false, checks: { sandboxRuntime: { ok: false, reason: `Sandbox runtime unreachable: ${error instanceof Error ? error.message : String(error)}` } } };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
