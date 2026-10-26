import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { loadOperatorConfig } from "../src/config/operator-config.js";
import { FileSquadMemoryStore } from "../src/engine/backends/file-squad-memory.js";
import type { CopilotSdkClient } from "../src/engine/copilot/copilot-sdk-client.js";
import { EphemeralRunStateStore } from "../src/engine/run-state.js";
import { StageBlockedError } from "../src/engine/research-runtime.js";
import { buildCopilotRuntime } from "../src/server-http.js";
import type { PerUserStack } from "../src/server-per-user.js";
import { PerUserCopilotCredentials } from "../src/engine/copilot/user-credentials.js";
import { perUserRunPreflight } from "../src/engine/copilot/per-user-executor.js";
import { UserIdentityGate } from "../src/transports/user-identity-gate.js";
import { ALICE, GH_ALICE, linkAs, startHarness } from "./github-link/harness.js";
import { withUserStoragePartition } from "../src/auth/user-storage-partition.js";

const LINK_KEY = Buffer.alloc(32, 7).toString("base64");
const RUN_KEY = Buffer.alloc(32, 9).toString("base64");
const SHARED_TOKEN = `gho_${"s".repeat(36)}`;

function perUserEnv(root: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    SQUAD_MCP_AUDIENCE: "api://squad", SQUAD_MCP_ENABLE_MEMORY: "true", SQUAD_MCP_MEMORY_AUTO_ENABLED: "true",
    SQUAD_MCP_ENABLE_ARTIFACTS: "true", SQUAD_MCP_MEMORY_DIR: join(root, "memory"),
    SQUAD_MCP_STAGE_EXECUTOR: "copilot", SQUAD_MCP_COPILOT_CLI_URL: "127.0.0.1:4321", SQUAD_MCP_COPILOT_CONNECTION_TOKEN: "c".repeat(32),
    SQUAD_MCP_UPSTREAM_RUNTIME_ENABLED: "false",
    SQUAD_MCP_REMOTE_PIPELINE_ENABLED: "true",
    SQUAD_MCP_RUN_STATE_DIR: join(root, "runs"),
    SQUAD_MCP_COPILOT_SESSION_STATE_DIR: join(root, "sessions"),
    SQUAD_MCP_RUN_ENCRYPTION_KEY_B64: RUN_KEY,
    SQUAD_MCP_ALLOWED_TENANTS: "22222222-2222-4222-8222-222222222222",
    SQUAD_MCP_ALLOWED_ISSUERS: "https://login.microsoftonline.com/22222222-2222-4222-8222-222222222222/v2.0",
    SQUAD_MCP_ALLOWED_CLIENTS: '{"api://squad":["33333333-3333-4333-8333-333333333333"]}',
    SQUAD_MCP_PER_USER_GITHUB_ENABLED: "true",
    SQUAD_MCP_PUBLIC_BASE_URL: "https://mcp.example.test",
    SQUAD_MCP_GITHUB_CLIENT_ID: "Iv1.testclient", SQUAD_MCP_GITHUB_CLIENT_SECRET: "gh-secret-value",
    SQUAD_MCP_LINK_ENTRA_CLIENT_ID: "11111111-1111-4111-8111-111111111111", SQUAD_MCP_LINK_ENTRA_CLIENT_SECRET: "entra-secret-value",
    SQUAD_MCP_LINK_ENTRA_TENANT_ID: "22222222-2222-4222-8222-222222222222",
    SQUAD_MCP_GITHUB_LINK_KEY_B64: LINK_KEY, SQUAD_MCP_GITHUB_LINK_DIR: join(root, "links"),
    ...extra,
  };
}

test("per-user mode needs no shared GitHub token, and rejects incomplete or unsafe configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "per-user-config-"));
  try {
    const config = loadOperatorConfig(perUserEnv(root));
    assert.equal(config.perUserGithub.enabled, true);
    assert.equal(config.perUserGithub.publicBaseUrl, "https://mcp.example.test");
    assert.deepEqual(config.perUserGithub.linkStore, { kind: "file", dir: join(root, "links") });

    // The shared token is still mandatory when per-user mode is off.
    assert.throws(() => loadOperatorConfig(perUserEnv(root, { SQUAD_MCP_PER_USER_GITHUB_ENABLED: "false" })), /requires a GitHub identity/);
    assert.equal(loadOperatorConfig(perUserEnv(root, { SQUAD_MCP_PER_USER_GITHUB_ENABLED: "false", SQUAD_MCP_COPILOT_GITHUB_TOKEN: SHARED_TOKEN })).perUserGithub.enabled, false);

    assert.throws(() => loadOperatorConfig(perUserEnv(root, { SQUAD_MCP_STAGE_EXECUTOR: "builtin", SQUAD_MCP_COPILOT_CLI_URL: "" })), /requires SQUAD_MCP_STAGE_EXECUTOR=copilot/);
    assert.throws(() => loadOperatorConfig(perUserEnv(root, { SQUAD_MCP_PUBLIC_BASE_URL: "http://mcp.example.test" })), /https origin/);
    assert.throws(() => loadOperatorConfig(perUserEnv(root, { SQUAD_MCP_PUBLIC_BASE_URL: "https://mcp.example.test/path" })), /https origin/);
    assert.throws(() => loadOperatorConfig(perUserEnv(root, { SQUAD_MCP_GITHUB_CLIENT_SECRET: "" })), /SQUAD_MCP_GITHUB_CLIENT_SECRET/);
    assert.throws(() => loadOperatorConfig(perUserEnv(root, { SQUAD_MCP_LINK_ENTRA_TENANT_ID: "" })), /SQUAD_MCP_LINK_ENTRA_TENANT_ID/);
    assert.throws(() => loadOperatorConfig(perUserEnv(root, { SQUAD_MCP_GITHUB_LINK_KEY_B64: "c2hvcnQ=" })), /32-byte key/);
    assert.throws(() => loadOperatorConfig(perUserEnv(root, { SQUAD_MCP_COPILOT_SESSION_STATE_DIR: "." })), /persistent Copilot session-state/);
    assert.throws(() => loadOperatorConfig(perUserEnv(root, { SQUAD_MCP_COPILOT_SESSION_STATE_DIR: "/" })), /persistent Copilot session-state/);
    assert.throws(() => loadOperatorConfig(perUserEnv(root, { SQUAD_MCP_RUN_ENCRYPTION_KEY_B64: LINK_KEY })), /must differ from SQUAD_MCP_RUN_ENCRYPTION_KEY_B64/);
    assert.doesNotThrow(() => loadOperatorConfig(perUserEnv(root, { SQUAD_MCP_RUN_ENCRYPTION_KEY_B64: RUN_KEY })));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the client allow-list is parsed per audience and malformed values fail at boot", async () => {
  const root = await mkdtemp(join(tmpdir(), "per-user-clients-"));
  try {
    const clients = JSON.stringify({
      "api://squad": ["AB3BE6B7-F5DF-413D-AC2D-ABF1E3FD9C0B", "11111111-1111-1111-1111-111111111111"],
      "22222222-2222-2222-2222-222222222222": ["33333333-3333-3333-3333-333333333333"],
    });
    const config = loadOperatorConfig(perUserEnv(root, { SQUAD_MCP_ALLOWED_CLIENTS: clients }));
    assert.deepEqual(config.allowedClientsByAudience["api://squad"], ["ab3be6b7-f5df-413d-ac2d-abf1e3fd9c0b", "11111111-1111-1111-1111-111111111111"]);
    assert.ok(loadOperatorConfig(perUserEnv(root)).allowedClientsByAudience["api://squad"].length);
    assert.throws(() => loadOperatorConfig(perUserEnv(root, { SQUAD_MCP_ALLOWED_CLIENTS: "not json" })), /must be JSON/);
    assert.throws(() => loadOperatorConfig(perUserEnv(root, { SQUAD_MCP_ALLOWED_CLIENTS: "[]" })), /JSON object/);
    assert.throws(() => loadOperatorConfig(perUserEnv(root, { SQUAD_MCP_ALLOWED_CLIENTS: '{"api://squad":[]}' })), /non-empty array/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the real bootstrap builds per-user identity: no shared credential, sandbox-only readiness, owner-resolved executor", async () => {
  const root = await mkdtemp(join(tmpdir(), "per-user-runtime-"));
  try {
    const config = loadOperatorConfig(perUserEnv(root));
    const fakeClient = {
      createSession: async () => { throw new Error("never reached: the stage is blocked before a session"); },
      ping: async () => ({}),
      listModels: async () => ["m"],
      stop: async () => undefined,
      entitlementVerifier: () => ({ verify: async () => { throw new Error("must not verify a shared token"); } }),
    } as unknown as CopilotSdkClient;
    const memoryStore = new FileSquadMemoryStore({ baseDir: join(root, "memory") });
    const runs = new EphemeralRunStateStore();

    assert.throws(() => buildCopilotRuntime(config, { memoryStore }, { client: fakeClient }), /requires the durable run-state store/);
    const runtime = buildCopilotRuntime(config, { memoryStore }, { client: fakeClient, runStateStore: runs });
    assert.ok(runtime?.perUser, "per-user identity is assembled");
    assert.equal(runtime.credentials, undefined, "no shared GitHub credential exists");
    assert.ok(runtime.runPreflight, "owned runs are guarded at claim time");

    const report = await runtime.readiness.prepare();
    assert.equal(report.ready, true);
    assert.deepEqual(Object.keys(report.checks), ["sandboxRuntime"], "an unlinked user does not make the instance unready");

    // A run with no owner never falls back to a shared identity.
    const ownerless = await runs.create({ tenantId: "t1", toolId: "squad_plan" });
    const executor = runtime.stageExecutorFactory({} as never, "default", ownerless.runId);
    await assert.rejects(executor.execute({} as never, {} as never), (error: unknown) =>
      error instanceof StageBlockedError && error.reason === "github_connection_required");

    // An owned run whose owner has not linked GitHub is blocked with the same typed reason.
    const owned = await runs.create({
      tenantId: withUserStoragePartition({
        tenantId: "t1", subject: "oid-alice", objectId: "oid-alice", tokenKind: "delegated", scopes: [], audience: "api",
      }).tenantId,
      toolId: "squad_plan",
      owner: { authorityTenantId: "t1", objectId: "oid-alice", githubUserId: 111, linkGeneration: "synthetic-generation" },
    });
    const ownedExecutor = runtime.stageExecutorFactory({} as never, "default", owned.runId);
    await assert.rejects(ownedExecutor.execute({} as never, {} as never), (error: unknown) =>
      error instanceof StageBlockedError && error.reason === "github_connection_required");

    // The preflight leaves it resumable and says why.
    const pre = await runtime.runPreflight!(owned);
    assert.deepEqual({ ok: pre.ok, code: pre.ok ? undefined : pre.code }, { ok: false, code: "github_connection_required" });
    const corrupt = await runtime.runPreflight!({
      ...owned, owner: { ...owned.owner!, objectId: "different-user" },
    });
    assert.equal(corrupt.ok, false);
    assert.equal(corrupt.ok ? undefined : corrupt.code, "run_identity_binding_invalid");

    // The gate and routes are what the handler serves.
    assert.ok(runtime.perUser.gate.appliesTo("squad_run"));
    const notFound = await runtime.perUser.linkRoutes({ method: "GET", path: "/github/link/start", query: "nonce=nope", headers: {} });
    assert.ok(notFound && notFound.status >= 400, "an unknown nonce is refused, with no state created");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the production upstream factory holds for real Init under the linked user's models and refuses a disconnected generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "upstream-user-bootstrap-"));
  const h = await startHarness();
  try {
    const service = h.makeService();
    assert.equal((await linkAs(h, service, ALICE, GH_ALICE)).final.status, 200);
    const credentials = new PerUserCopilotCredentials({
      tokens: service,
      verifier: { verify: async () => ({ models: ["gpt-5.4", "gpt-5.4-mini"] }) },
    });
    const users: PerUserStack = {
      service, credentials,
      gate: new UserIdentityGate({
        credentials, executionTools: new Set(["squad_run"]),
        link: {
          begin: async p => { const b = await service.begin(p); return { url: b.startUrl, expiresAt: b.expiresAt }; },
          status: p => service.status(p),
          unlink: async p => { await service.unlink(p); },
        },
      }),
      linkRoutes: req => service.handleHttp(req),
      runPreflight: perUserRunPreflight(credentials),
      statusForRun: () => credentials.cachedStatus(ALICE),
      tokenProviderForRun: saved => credentials.tokenProviderFor(ALICE, {
        githubUserId: saved.owner?.githubUserId, linkGeneration: saved.owner?.linkGeneration,
      }),
    };
    const admission = await credentials.verifyFor(ALICE);
    const partition = withUserStoragePartition({
      tenantId: ALICE.tenantId, subject: ALICE.objectId, objectId: ALICE.objectId,
      tokenKind: "delegated", scopes: ["Squad.Run"], audience: "api",
    }).tenantId;
    const runs = new EphemeralRunStateStore();
    const run = await runs.create({
      tenantId: partition, toolId: "squad_run",
      owner: {
        authorityTenantId: ALICE.tenantId, objectId: ALICE.objectId,
        githubUserId: GH_ALICE.id, linkGeneration: admission.linkGeneration,
      },
    });
    let sessions = 0;
    const client: CopilotSdkClient = {
      createSession: async () => { sessions++; throw new Error("Init must pause before a session is opened."); },
      ping: async () => ({}), listModels: async () => ["gpt-5.4"], stop: async () => {},
      entitlementVerifier: () => ({ verify: async () => { throw new Error("A shared token must never be verified."); } }),
    };
    const config = loadOperatorConfig(perUserEnv(root, { SQUAD_MCP_UPSTREAM_RUNTIME_ENABLED: "true" }));
    const runtime = buildCopilotRuntime(config, {
      memoryStore: new FileSquadMemoryStore({ baseDir: join(root, "memory") }),
    }, { client, runStateStore: runs, perUserStack: users });
    assert.ok(runtime?.upstreamRun);
    const held = await runtime.upstreamRun(run, {
      toolId: "squad_run", request: "Prepare a synthetic bounded advisory report.", project: "private-project",
    }, {
      id: "workspace", tenantId: partition, root, resolve: p => join(root, p), dispose: async () => {},
    }, async () => {});
    assert.equal(held?.outcome, "held");
    assert.ok((await runs.get(run.runId))?.humanInput, "real upstream Init is persisted, not fabricated");
    assert.equal(sessions, 0);
    assert.equal(runtime.credentials, undefined);
    await service.unlink(ALICE);
    assert.equal((await users.runPreflight(run)).ok, false);
  } finally {
    await h.stop();
    await rm(root, { recursive: true, force: true });
  }
});
