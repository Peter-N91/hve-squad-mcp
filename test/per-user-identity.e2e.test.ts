/**
 * End-to-end per-user GitHub identity through the real HTTP handler, run store,
 * stage-executor wiring and worker drive path. Only the leaf systems are faked
 * (Entra signature check, GitHub token source, Copilot entitlement check).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { UserPrincipal } from "../src/auth/entra.js";
import { withUserStoragePartition } from "../src/auth/user-storage-partition.js";
import { DurableRunStateStore } from "../src/engine/durable-run-state.js";
import { RunStoreApprovalChannel } from "../src/engine/gates.js";
import { perUserRunPreflight, perUserStageExecutor } from "../src/engine/copilot/per-user-executor.js";
import { PerUserCopilotCredentials, type UserTokenGrant } from "../src/engine/copilot/user-credentials.js";
import { UserIdentityGate, type GitHubLinkFacade } from "../src/transports/user-identity-gate.js";
import type { HttpResponseLike } from "../src/transports/http-core.js";
import { buildHarness, callTool, initializeSession } from "./conformance/support/harness.js";
import { bearer, FakeJwtVerifier, TEST_AUDIENCE } from "./conformance/support/fake-auth.js";
import { scriptedStageExecutor } from "./helpers/scripted-stage-executor.js";

const COWORK_AUDIENCE = "api://hve-squad-mcp-test-cowork";
const TOKEN_STORE_CLIENT = "ab3be6b7-f5df-413d-ac2d-abf1e3fd9c0b";
const STUDIO_CLIENT = "11111111-1111-1111-1111-111111111111";
const TENANT = "aaaaaaaa-1111-4111-8111-111111111111";
const EXECUTION_TOOLS = new Set(["squad_research", "squad_review", "squad_plan", "squad_architect", "squad_run", "squad_federate"]);

class LinkError extends Error {
  constructor(readonly code: string) { super(code); }
}

function text(res: HttpResponseLike): string {
  const result = (res.body as { result?: { content?: { text: string }[] } }).result;
  return result?.content?.map((c) => c.text).join("\n") ?? "";
}
const isError = (res: HttpResponseLike) => Boolean((res.body as { result?: { isError?: boolean } }).result?.isError);

function build(dir: string) {
  const grants = new Map<string, UserTokenGrant>();
  const verifier = new FakeJwtVerifier();
  const store = new DurableRunStateStore({ baseDir: dir });
  const approvals = new RunStoreApprovalChannel(store);
  const entitled = new Set<string>();
  const verifiedTokens: string[] = [];
  const credentials = new PerUserCopilotCredentials({
    tokens: {
      async tokenFor(principal: UserPrincipal, options) {
        const grant = grants.get(principal.objectId);
        if (!grant) throw new LinkError("github_connection_required");
        if (options.expectedGithubUserId !== undefined && options.expectedGithubUserId !== grant.githubUserId) {
          throw new LinkError("github_identity_changed");
        }
        if (options.expectedLinkGeneration && options.expectedLinkGeneration !== grant.linkGeneration) {
          throw new LinkError("github_identity_changed");
        }
        return grant;
      },
    },
    verifier: {
      async verify(token) {
        verifiedTokens.push(token);
        return entitled.has(token) ? { models: ["gpt-5"] } : { models: [] };
      },
    },
  });
  const link: GitHubLinkFacade = {
    async begin(principal) {
      return { url: `https://mcp.example.invalid/github/link/start?nonce=n-${principal.objectId}`, expiresAt: Date.now() + 600_000 };
    },
    async status(principal) {
      const grant = grants.get(principal.objectId);
      return grant ? { linked: true, githubLogin: `gh-${grant.githubUserId}`, githubUserId: grant.githubUserId } : { linked: false };
    },
    async unlink(principal) { grants.delete(principal.objectId); },
  };
  const usedTokens: Array<{ runId: string; token: string }> = [];
  const harness = buildHarness({
    verifier,
    audiences: [TEST_AUDIENCE, COWORK_AUDIENCE],
    allowedClientsByAudience: { [COWORK_AUDIENCE]: [TOKEN_STORE_CLIENT], [TEST_AUDIENCE]: [STUDIO_CLIENT] },
    runStateStore: store,
    approvals,
    userIdentity: new UserIdentityGate({ link, credentials, executionTools: EXECUTION_TOOLS }),
    runPreflight: perUserRunPreflight(credentials),
    stageExecutorFactory: (_workspace, _project, runId) =>
      perUserStageExecutor({
        runs: store,
        credentials,
        runId,
        build: ({ tokenProvider }) => {
          const real = scriptedStageExecutor(harness.backend);
          return {
            execute: async (...args) => {
              const granted = await tokenProvider({ reason: "initial" });
              usedTokens.push({ runId, token: granted.kind === "token" ? granted.accessToken : "" });
              return real.execute(...args);
            },
          };
        },
      }),
  });
  const grant = (objectId: string, githubUserId: number, version = 1): string => {
    const accessToken = `ghu_user_${githubUserId}_v${version}_0000000000`;
    grants.set(objectId, {
      accessToken, expiresInSeconds: 28_000, githubUserId, credentialVersion: version,
      linkGeneration: `synthetic-generation-${githubUserId}`,
    });
    entitled.add(accessToken);
    return accessToken;
  };
  return { harness, verifier, store, grants, grant, usedTokens, verifiedTokens, entitled };
}

function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "squad-per-user-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function registerUsers(verifier: FakeJwtVerifier) {
  // Alice arrives through Cowork, Bob through Copilot Studio; sub differs per client app.
  verifier.register({ token: "alice", tenantId: TENANT, subject: "oid-alice", sub: "sub-alice-cowork", scopes: ["Squad.Run", "Squad.Research", "Squad.Plan"], audience: COWORK_AUDIENCE, azp: TOKEN_STORE_CLIENT });
  verifier.register({ token: "bob", tenantId: TENANT, subject: "oid-bob", sub: "sub-bob-studio", scopes: ["Squad.Run", "Squad.Research", "Squad.Plan"], audience: TEST_AUDIENCE, azp: STUDIO_CLIENT });
  verifier.register({ token: "alice-studio", tenantId: TENANT, subject: "oid-alice", sub: "sub-alice-studio", scopes: ["Squad.Run", "Squad.Research", "Squad.Plan"], audience: TEST_AUDIENCE, azp: STUDIO_CLIENT });
  verifier.register({ token: "daemon", tenantId: TENANT, subject: "svc", scopes: ["Squad.Run", "Squad.Research"], audience: TEST_AUDIENCE, azp: STUDIO_CLIENT, appOnly: true });
  verifier.register({ token: "operator", tenantId: TENANT, subject: "oid-operator", scopes: ["Squad.Operate"], audience: TEST_AUDIENCE, azp: STUDIO_CLIENT });
}

test("per-user flow: connect tool, unlinked refusal, two hosts and two users run as themselves", async () => {
  await withDir(async (dir) => {
    const t = build(dir);
    registerUsers(t.verifier);
    const aliceSession = await initializeSession(t.harness.handler, "alice");
    const bobSession = await initializeSession(t.harness.handler, "bob");

    // tools/list advertises the three connection tools to a signed-in caller.
    const list = await t.harness.handler.handle({
      method: "POST", path: "/mcp",
      headers: { origin: "https://copilotstudio.microsoft.com", authorization: bearer("alice"), "mcp-session-id": aliceSession, "content-type": "application/json" },
      body: { jsonrpc: "2.0", id: 9, method: "tools/list", params: {} },
    });
    const names = ((list.body as { result: { tools: { name: string }[] } }).result.tools).map((tool) => tool.name);
    for (const expected of ["squad_github_status", "squad_github_connect", "squad_github_disconnect"]) {
      assert.ok(names.includes(expected), `${expected} is listed`);
    }

    // Unlinked: refused with a typed code, nothing started.
    const refused = await callTool(t.harness.handler, { token: "alice", sessionId: aliceSession, name: "squad_research", args: { request: "map the options" } });
    assert.equal(isError(refused), true);
    assert.match(text(refused), /^github_connection_required:/);
    assert.equal(t.harness.backend.callCount, 0);
    assert.equal(t.usedTokens.length, 0);

    // The connect tool returns a bound one-time link and no credential.
    const connect = await callTool(t.harness.handler, { token: "alice", sessionId: aliceSession, name: "squad_github_connect", args: {} });
    assert.match(text(connect), /github\/link\/start\?nonce=n-oid-alice/);
    assert.doesNotMatch(text(connect), /ghu_|gho_/);

    // Both link, then each runs as their own GitHub user.
    const aliceToken = t.grant("oid-alice", 111);
    const bobToken = t.grant("oid-bob", 222);
    const status = await callTool(t.harness.handler, { token: "alice", sessionId: aliceSession, name: "squad_github_status", args: {} });
    assert.match(text(status), /Connected as GitHub user gh-111/);
    assert.doesNotMatch(text(status), /ghu_/);

    const aliceRun = await callTool(t.harness.handler, { token: "alice", sessionId: aliceSession, name: "squad_plan", args: { request: "map the options" } });
    const bobRun = await callTool(t.harness.handler, { token: "bob", sessionId: bobSession, name: "squad_plan", args: { request: "map the options" } });
    assert.equal(isError(aliceRun), false);
    assert.equal(isError(bobRun), false);
    const tokens = t.usedTokens.map((entry) => entry.token);
    assert.ok(tokens.includes(aliceToken), "Alice's own token was used");
    assert.ok(tokens.includes(bobToken), "Bob's own token was used");
    assert.equal(new Set(t.usedTokens.map((entry) => entry.runId)).size, 2, "two separate runs");
    for (const entry of t.usedTokens) {
      const run = await t.store.get(entry.runId);
      const expected = entry.token === aliceToken ? "oid-alice" : "oid-bob";
      assert.equal(run?.owner?.objectId, expected, "the run is pinned to the user whose token it used");
    }
  });
});

test("the same person is one identity from Cowork and from Copilot Studio", async () => {
  await withDir(async (dir) => {
    const t = build(dir);
    registerUsers(t.verifier);
    const token = t.grant("oid-alice", 111);
    const coworkSession = await initializeSession(t.harness.handler, "alice");
    const studioSession = await initializeSession(t.harness.handler, "alice-studio");
    await callTool(t.harness.handler, { token: "alice", sessionId: coworkSession, name: "squad_plan", args: { request: "from cowork" } });
    await callTool(t.harness.handler, { token: "alice-studio", sessionId: studioSession, name: "squad_plan", args: { request: "from studio" } });
    assert.equal(t.usedTokens.length, 2);
    assert.ok(t.usedTokens.every((entry) => entry.token === token));
  });
});

test("an app-only caller cannot run as anyone and cannot connect", async () => {
  await withDir(async (dir) => {
    const t = build(dir);
    registerUsers(t.verifier);
    t.grant("svc", 999);
    const session = await initializeSession(t.harness.handler, "daemon");
    const run = await callTool(t.harness.handler, { token: "daemon", sessionId: session, name: "squad_research", args: { request: "x" } });
    assert.match(text(run), /^delegated_user_required:/);
    const connect = await callTool(t.harness.handler, { token: "daemon", sessionId: session, name: "squad_github_connect", args: {} });
    assert.equal(isError(connect), true);
    assert.equal(t.usedTokens.length, 0);
  });
});

test("a user whose GitHub account has no Copilot access is refused with a distinct code", async () => {
  await withDir(async (dir) => {
    const t = build(dir);
    registerUsers(t.verifier);
    const token = t.grant("oid-bob", 222);
    t.entitled.delete(token);
    const session = await initializeSession(t.harness.handler, "bob");
    const res = await callTool(t.harness.handler, { token: "bob", sessionId: session, name: "squad_research", args: { request: "x" } });
    assert.match(text(res), /^copilot_entitlement_missing:/);
    assert.equal(t.usedTokens.length, 0);
  });
});

test("another user in the same tenant cannot poll, answer or drive a user's run", async () => {
  await withDir(async (dir) => {
    const t = build(dir);
    registerUsers(t.verifier);
    t.grant("oid-alice", 111);
    t.grant("oid-bob", 222);
    const aliceSession = await initializeSession(t.harness.handler, "alice");
    const bobSession = await initializeSession(t.harness.handler, "bob");

    const started = await callTool(t.harness.handler, { token: "alice", sessionId: aliceSession, name: "squad_run", args: { request: "improve caching" } });
    const runId = text(started).match(/"runId":\s*"([^"]+)"/)?.[1];
    assert.ok(runId);
    assert.equal((await t.store.get(runId))?.owner?.objectId, "oid-alice");

    const bobPoll = await callTool(t.harness.handler, { token: "bob", sessionId: bobSession, name: "squad_status", args: { runId } });
    assert.doesNotMatch(text(bobPoll), /improve caching|## Squad/);
    assert.match(JSON.stringify(bobPoll.body), /not.found|cross.tenant|denied|unknown/i);
    assert.equal(t.usedTokens.length, 0, "Bob's poll never drove Alice's run");

    const direct = await t.harness.embedded.getRunStatus(runId, { auth: withUserStoragePartition({ tenantId: TENANT, subject: "oid-bob", objectId: "oid-bob", tokenKind: "delegated", scopes: [], audience: "x" }) });
    assert.equal(direct, undefined);
    const own = await t.harness.embedded.getRunStatus(runId, { auth: withUserStoragePartition({ tenantId: TENANT, subject: "oid-alice", objectId: "oid-alice", tokenKind: "delegated", scopes: [], audience: "x" }) });
    assert.equal(own?.status, "held");
  });
});

test("an approved run resumed by the worker path uses its owner's token, and an account switch blocks it", async () => {
  await withDir(async (dir) => {
    const t = build(dir);
    registerUsers(t.verifier);
    const aliceToken = t.grant("oid-alice", 111);
    const session = await initializeSession(t.harness.handler, "alice");
    const started = await callTool(t.harness.handler, { token: "alice", sessionId: session, name: "squad_run", args: { request: "improve caching" } });
    const runId = text(started).match(/"runId":\s*"([^"]+)"/)?.[1]!;

    const approve = await t.harness.handler.handle({
      method: "POST", path: "/admin/approve",
      headers: { authorization: bearer("operator"), "content-type": "application/json" },
      body: { runId },
    });
    assert.equal(approve.status, 200);

    // Alice relinks to a different GitHub account before the worker picks the run up.
    t.grant("oid-alice", 999, 2);
    const blocked = await t.harness.embedded.driveClaimable(runId);
    assert.ok(blocked);
    assert.equal(blocked.outcome, "held");
    assert.equal(blocked.reason, "github_identity_changed");
    assert.doesNotMatch(JSON.stringify(blocked), /ghu_/);
    assert.equal(t.usedTokens.length, 0, "no stage ran under the new GitHub account");
    const afterBlock = await t.store.get(runId);
    assert.equal(afterBlock?.status, "running", "the run is still resumable, not failed");
    assert.match(afterBlock?.holdReason ?? "", /github_identity_changed/);
    assert.ok((afterBlock?.leaseExpiresAt ?? 0) > Date.now(), "identity failure backs off rather than spinning the worker");
    assert.equal((await t.store.listClaimable()).some(row => row.runId === runId), false);

    // Restore the exact original connection snapshot, not a browser relink
    // (which creates a new generation and cannot revive this run).
    t.grants.set("oid-alice", {
      accessToken: aliceToken, expiresInSeconds: 28_000, githubUserId: 111, credentialVersion: 3,
      linkGeneration: "synthetic-generation-111",
    });
    t.entitled.add(aliceToken);
    // Advance the identity retry lease without blindly releasing an active worker.
    await t.store.update(runId, { leaseExpiresAt: 0 });
    const done = await t.harness.embedded.pollRun(runId, { auth: withUserStoragePartition({ tenantId: TENANT, subject: "oid-alice", objectId: "oid-alice", tokenKind: "delegated", scopes: [], audience: "x" }) });
    assert.ok(done);
    assert.ok(t.usedTokens.length > 0);
    assert.ok(t.usedTokens.every((entry) => entry.token === aliceToken));
  });
});

test("with per-user identity off, the previous single-identity behavior is unchanged", async () => {
  const verifier = new FakeJwtVerifier();
  const harness = buildHarness({ verifier });
  verifier.register({ token: "legacy", tenantId: TENANT, subject: "u", scopes: ["Squad.Research"] });
  const session = await initializeSession(harness.handler, "legacy");
  const res = await callTool(harness.handler, { token: "legacy", sessionId: session, name: "squad_research", args: { request: "x" } });
  assert.equal(isError(res), false);
  const list = await harness.handler.handle({
    method: "POST", path: "/mcp",
    headers: { origin: "https://copilotstudio.microsoft.com", authorization: bearer("legacy"), "mcp-session-id": session, "content-type": "application/json" },
    body: { jsonrpc: "2.0", id: 9, method: "tools/list", params: {} },
  });

  const names = ((list.body as { result: { tools: { name: string }[] } }).result.tools).map((tool) => tool.name);
  assert.ok(!names.some((name) => name.startsWith("squad_github_")));
});

test("a cold worker reads the saved owner and persisted approval without borrowing the polling user's identity", async () => {
  await withDir(async dir => {
    const web = build(dir);
    registerUsers(web.verifier);
    const aliceToken = web.grant("oid-alice", 111);
    const session = await initializeSession(web.harness.handler, "alice");
    const started = await callTool(web.harness.handler, {
      token: "alice", sessionId: session, name: "squad_run", args: { request: "improve caching" },
    });
    const runId = text(started).match(/"runId":\s*"([^"]+)"/)?.[1];
    assert.ok(runId);
    const approved = await web.harness.handler.handle({
      method: "POST", path: "/admin/approve",
      headers: { authorization: bearer("operator"), "content-type": "application/json" }, body: { runId },
    });
    assert.equal(approved.status, 200);
    const worker = build(dir);
    worker.grant("oid-alice", 111);
    worker.grant("oid-bob", 222);
    const result = await worker.harness.embedded.driveClaimable(runId);
    assert.equal(result?.outcome, "completed");
    assert.ok(worker.usedTokens.length > 0);
    assert.ok(worker.usedTokens.every(call => call.token === aliceToken));
    assert.equal(web.usedTokens.length, 0);
    assert.equal((await worker.store.get(runId))?.owner?.authorityTenantId, TENANT);
  });
});

test("rollback to service mode cannot execute a queued per-user run with a shared credential", async () => {
  await withDir(async dir => {
    const user = build(dir);
    const queued = await user.store.create({
      tenantId: "private-partition", toolId: "squad_run",
      owner: { objectId: "alice", authorityTenantId: TENANT, githubUserId: 111 },
    });
    const service = buildHarness({ runStateStore: new DurableRunStateStore({ baseDir: dir }) });
    const result = await service.embedded.driveClaimable(queued.runId);
    assert.equal(result?.outcome, "denied");
    assert.equal(result?.reason, "per_user_identity_disabled");
    assert.equal(service.backend.callCount, 0);
    assert.equal((await user.store.get(queued.runId))?.failureReason, "per_user_identity_disabled");
  });
});

test("per-user workers never infer an owner for legacy ownerless queued work", async () => {
  await withDir(async dir => {
    const user = build(dir);
    user.grant("oid-alice", 111);
    const legacy = await user.store.create({ tenantId: TENANT, toolId: "squad_run" });
    const result = await user.harness.embedded.driveClaimable(legacy.runId);
    assert.equal(result?.reason, "legacy_run_requires_owner_migration");
    assert.equal(user.usedTokens.length, 0);
    assert.equal(user.harness.backend.callCount, 0);
  });
});
