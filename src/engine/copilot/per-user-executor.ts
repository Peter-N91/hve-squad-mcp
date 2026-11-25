/**
 * Stage executor that runs each stage as the run's own GitHub user.
 *
 * The factory the engine calls is synchronous and the owner lives on the run
 * record, so the wrapper resolves it lazily on the first `execute`, proves the
 * owner's Copilot access, and only then builds the real executor with a
 * `gitHubTokenProvider` bound to that owner. Resuming a run, whether from a poll
 * or from the background worker, therefore always uses the credential of the
 * person who started it, and a run with no owner never falls back to a shared one.
 */
import type { UserPrincipal } from "../../auth/entra.js";
import { userStoragePartition } from "../../auth/user-storage-partition.js";
import type { AdvisoryStageExecutor } from "../research-runtime.js";
import { StageBlockedError } from "../research-runtime.js";
import type { RunState, RunStateStore } from "../run-state.js";
import {
  userIdentityMessage,
  type PerUserCopilotCredentials,
  type UserIdentityStatus,
} from "./user-credentials.js";

export interface PerUserExecutorDeps {
  runs: Pick<RunStateStore, "get">;
  credentials: PerUserCopilotCredentials;
  runId: string;
  /** Build the real executor for a verified owner. */
  build(owner: {
    run: RunState;
    principal: UserPrincipal;
    githubUserId?: number;
    identity: UserIdentityStatus;
    tokenProvider: ReturnType<PerUserCopilotCredentials["tokenProviderFor"]>;
  }): AdvisoryStageExecutor;
}

/**
 * Guard for the engine's claim path: prove the run owner's linked GitHub account
 * is still the one the run started with and still has Copilot access. Wired as
 * `EmbeddedCoordinator`'s `runPreflight`, so both a status poll and the
 * background worker stop before any stage runs and leave the run resumable.
 */
export function perUserRunPreflight(credentials: PerUserCopilotCredentials) {
  return async (run: { tenantId: string; owner?: { objectId: string; authorityTenantId?: string; githubUserId?: number; linkGeneration?: string } }): Promise<
    { ok: true } | { ok: false; code: string; reason: string }
  > => {
    if (!run.owner?.authorityTenantId || !run.owner.linkGeneration ||
        !Number.isSafeInteger(run.owner.githubUserId) || (run.owner.githubUserId ?? 0) <= 0) return {
      ok: false, code: "delegated_user_required",
      reason: "This run has no complete verified user/account/connection binding. Start a new run; ownership cannot be inferred.",
    };
    if (run.owner.authorityTenantId && run.tenantId !== userStoragePartition({
      tenantId: run.owner.authorityTenantId, objectId: run.owner.objectId,
    })) {
      return { ok: false, code: "run_identity_binding_invalid", reason: "The saved run owner does not match its private storage partition." };
    }
    const status = await credentials.verifyFor(
      { tenantId: run.owner.authorityTenantId ?? run.tenantId, objectId: run.owner.objectId },
      { githubUserId: run.owner.githubUserId, linkGeneration: run.owner.linkGeneration },
    );
    return status.ready ? { ok: true } : { ok: false, code: status.code ?? "copilot_verification_failed", reason: status.reason };
  };
}

export function perUserStageExecutor(deps: PerUserExecutorDeps): AdvisoryStageExecutor {
  let inner: AdvisoryStageExecutor | undefined;
  return {
    async execute(...args) {
      if (!inner) {
        const run = await deps.runs.get(deps.runId);
        if (!run?.owner) {
          throw new StageBlockedError("github_connection_required", userIdentityMessage("github_connection_required"));
        }
        const checked = await perUserRunPreflight(deps.credentials)(run);
        if (!checked.ok) throw new StageBlockedError(checked.code, checked.reason);
        const principal: UserPrincipal = { tenantId: run.owner.authorityTenantId ?? run.tenantId, objectId: run.owner.objectId };
        const pin = { githubUserId: run.owner.githubUserId, linkGeneration: run.owner.linkGeneration };
        const identity = await deps.credentials.verifyFor(principal, pin);
        if (!identity.ready) {
          throw new StageBlockedError(identity.code ?? "copilot_verification_failed", identity.reason);
        }
        inner = deps.build({
          run,
          principal,
          githubUserId: run.owner.githubUserId,
          identity,
          tokenProvider: deps.credentials.tokenProviderFor(principal, pin),
        });
      }
      return inner.execute(...args);
    },
  };
}
