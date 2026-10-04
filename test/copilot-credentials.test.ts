import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { loadOperatorConfig } from "../src/config/operator-config.js";
import {
  CommandCredentialSource,
  CopilotCredentials,
  CopilotRuntimeUnavailableError,
  EnvCredentialSource,
  FileCredentialSource,
  type CopilotEntitlementVerifier,
} from "../src/engine/copilot/copilot-credentials.js";
import { CopilotReadiness } from "../src/engine/copilot/copilot-readiness.js";
import { FileSquadMemoryStore } from "../src/engine/backends/file-squad-memory.js";
import { RedactingLogger } from "../src/observability/logger.js";
import { buildCopilotCredentialSource, buildCopilotRuntime, prepareReadiness } from "../src/server-http.js";
import type { CopilotSdkClient } from "../src/engine/copilot/copilot-sdk-client.js";
import type { ReadinessProbe } from "../src/transports/readiness.js";
import { buildHarness } from "./conformance/support/harness.js";

const TOKEN_A = `gho_${"a".repeat(36)}`;
const TOKEN_B = `gho_${"b".repeat(36)}`;
/** Spawning node on a busy machine can exceed the 15 s production default; the test checks behavior, not speed. */
const SPAWN_TIMEOUT_MS = 120_000;

function verifier(behaviour: (token: string) => { models: string[]; premiumRemainingPercent?: number } | Error) {
  const calls: string[] = [];
  const impl: CopilotEntitlementVerifier = {
    async verify(token) {
      calls.push(token);
      const result = behaviour(token);
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return { impl, calls };
}

test("each session's token comes from the source, refreshes re-read it, and rotation needs no restart", async () => {
  const env: NodeJS.ProcessEnv = { GH: TOKEN_A };
  let now = 0;
  const credentials = new CopilotCredentials({
    source: new EnvCredentialSource("GH", env), verifier: verifier(() => ({ models: ["m"] })).impl, cacheMs: 1_000, now: () => now,
  });
  const first = await credentials.tokenProvider({ reason: "initial" });
  assert.deepEqual(first, { kind: "token", accessToken: TOKEN_A, expiresIn: 28_800 });
  env.GH = TOKEN_B;
  assert.equal((await credentials.tokenProvider({ reason: "initial" }) as { accessToken: string }).accessToken, TOKEN_A, "Within the cache window the token is reused.");
  assert.equal((await credentials.tokenProvider({ reason: "refresh" }) as { accessToken: string }).accessToken, TOKEN_B, "A runtime refresh always re-reads the source.");
  env.GH = TOKEN_A;
  now += 1_001;
  assert.equal((await credentials.tokenProvider({ reason: "initial" }) as { accessToken: string }).accessToken, TOKEN_A, "After the cache window a new session sees the rotated token.");
  assert.throws(() => new CopilotCredentials({ source: new EnvCredentialSource("GH", env), verifier: verifier(() => ({ models: [] })).impl, assumedLifetimeSeconds: 3_600 }),
    /must exceed one hour/);
});

test("verification proves Copilot entitlement and reports failures without ever exposing the token", async () => {
  const env: NodeJS.ProcessEnv = {};
  const outcome = { value: (() => ({ models: ["claude-sonnet-5", "gpt-6-sol"] })) as (token: string) => { models: string[]; premiumRemainingPercent?: number } | Error };
  const check = verifier((token) => outcome.value(token));
  const credentials = new CopilotCredentials({ source: new EnvCredentialSource("GH", env), verifier: check.impl });

  let status = await credentials.verify();
  assert.equal(status.ready, false);
  assert.match(status.reason, /No GitHub token is available from environment variable GH/);
  assert.equal(check.calls.length, 0, "Nothing is verified without a token.");

  env.GH = "not a token!";
  assert.match((await credentials.verify()).reason, /is not a GitHub token/);

  env.GH = TOKEN_A;
  status = await credentials.verify();
  assert.deepEqual({ ready: status.ready, models: status.models }, { ready: true, models: 2 });

  outcome.value = () => new Error("Request models.list failed: Bad credentials");
  status = await credentials.verify();
  assert.equal(status.ready, false);
  assert.match(status.reason, /Bad credentials/);

  outcome.value = () => ({ models: [] });
  assert.match((await credentials.verify()).reason, /no Copilot models/);

  outcome.value = () => ({ models: ["m"], premiumRemainingPercent: 0 });
  status = await credentials.verify();
  assert.equal(status.ready, true);
  assert.match(status.reason, /premium request quota is exhausted/);

  for (const value of [status, credentials.status()]) assert.ok(!JSON.stringify(value).includes(TOKEN_A));
  const [a, b] = await Promise.all([credentials.verify(), credentials.verify()]);
  assert.equal(a, b, "Concurrent verifications share one check.");
});

test("a verification older than two monitor intervals is no longer ready", async () => {
  let now = Date.parse("2026-10-03T12:00:00Z");
  const credentials = new CopilotCredentials({
    source: new EnvCredentialSource("GH", { GH: TOKEN_A }), verifier: verifier(() => ({ models: ["m"] })).impl,
    reverifyMs: 60_000, now: () => now,
  });
  await credentials.verify();
  assert.equal(credentials.status().ready, true);
  now += 120_001;
  assert.deepEqual({ ready: credentials.status().ready, reason: credentials.status().reason }, { ready: false, reason: "Copilot identity verification is stale." });
});

test("file and command sources re-read on every acquisition; command failures never echo output", async () => {
  const root = await mkdtemp(join(tmpdir(), "copilot-credentials-"));
  try {
    const path = join(root, "token");
    await writeFile(path, `${TOKEN_A}\n`);
    const file = new FileCredentialSource(path);
    assert.equal(await file.read(), TOKEN_A);
    await writeFile(path, TOKEN_B);
    assert.equal(await file.read(), TOKEN_B, "A rotated mounted secret is picked up.");

    const command = new CommandCredentialSource([process.execPath, "-e", `process.stdout.write(${JSON.stringify(TOKEN_A)} + "\\n")`], SPAWN_TIMEOUT_MS);
    assert.equal(await command.read(), TOKEN_A);
    const failing = new CommandCredentialSource([process.execPath, "-e", `process.stdout.write(${JSON.stringify(TOKEN_B)}); process.exit(3)`], SPAWN_TIMEOUT_MS);
    await assert.rejects(failing.read(), (error: unknown) => error instanceof Error && !error.message.includes(TOKEN_B) && /failed/.test(error.message));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("readiness requires a verified identity and a reachable sandbox runtime", async () => {
  const env: NodeJS.ProcessEnv = { GH: TOKEN_A };
  const credentials = new CopilotCredentials({ source: new EnvCredentialSource("GH", env), verifier: verifier(() => ({ models: ["m"] })).impl });
  let reachable = true;
  const readiness = new CopilotReadiness(credentials, { ping: async () => { if (!reachable) throw new Error("ECONNREFUSED"); return {}; } });
  try {
    assert.equal((await readiness.check()).ready, false, "Not ready before the identity is verified.");
    const prepared = await readiness.prepare();
    assert.equal(prepared.ready, true);
    reachable = false;
    const down = await readiness.check();
    assert.deepEqual({ ready: down.ready, identity: down.checks.copilotIdentity.ok, sandbox: down.checks.sandboxRuntime.ok }, { ready: false, identity: true, sandbox: false });
  } finally { credentials.stopMonitoring(); }
});

test("/healthz and /readyz serve platform probes with booleans only", async () => {
  let ready = true;
  const probe: ReadinessProbe = {
    prepare: async () => ({ ready, checks: {} }),
    check: async () => ({
      ready,
      checks: { copilotIdentity: { ok: ready, reason: `secret-ish detail ${TOKEN_A}` }, sandboxRuntime: { ok: true, reason: "ok" } },
    }),
  };
  const { handler, lines } = buildHarness({ readiness: probe });
  const get = (path: string, method = "GET") => handler.handle({ method, path, headers: {} });

  assert.deepEqual(await get("/healthz"), { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: { status: "ok" } });
  const okReady = await get("/readyz");
  assert.equal(okReady.status, 200);
  assert.deepEqual(okReady.body, { ready: true, checks: { copilotIdentity: true, sandboxRuntime: true } });

  ready = false;
  const notReady = await get("/readyz");
  assert.equal(notReady.status, 503);
  assert.deepEqual(notReady.body, { ready: false, checks: { copilotIdentity: false, sandboxRuntime: true } });
  assert.ok(!JSON.stringify(notReady).includes("secret-ish"), "Reasons are never returned by the probe.");
  assert.ok(!lines.join("\n").includes(TOKEN_A), "Logged reasons pass through the redacting logger.");
  assert.equal((await get("/readyz", "POST")).status, 405);

  const builtin = buildHarness();
  assert.deepEqual((await builtin.handler.handle({ method: "GET", path: "/readyz", headers: {} })).body, { ready: true, checks: {} },
    "Without a probe (built-in runtime) the instance is ready whenever it serves.");
});

test("startup refuses a bad identity but waits out an unreachable sandbox, then becomes ready on its own", async () => {
  const logger = new RedactingLogger({ name: "test", sink: () => undefined });
  const env: NodeJS.ProcessEnv = { GH: TOKEN_A };
  const outcome = { value: (() => new Error("Request models.list failed: Bad credentials")) as () => { models: string[] } | Error };
  const credentials = new CopilotCredentials({
    source: new EnvCredentialSource("GH", env), verifier: verifier(() => outcome.value()).impl, retryMs: 20, reverifyMs: 60_000,
  });
  let reachable = false;
  const readiness = new CopilotReadiness(credentials, { ping: async () => { if (!reachable) throw new Error("ECONNREFUSED"); return {}; } }, logger);
  const handler = { readiness } as unknown as Parameters<typeof prepareReadiness>[0];
  try {
    await assert.rejects(prepareReadiness(handler, logger), /Refusing to start: copilotIdentity: Request models\.list failed: Bad credentials/);
    assert.equal(credentials.status().cause, "credential");

    delete env.GH;
    await assert.rejects(prepareReadiness(handler, logger), /Refusing to start: copilotIdentity: No GitHub token/);

    env.GH = TOKEN_A;
    outcome.value = () => new CopilotRuntimeUnavailableError("Could not connect to the Copilot sandbox runtime: ECONNREFUSED");
    await prepareReadiness(handler, logger);
    assert.deepEqual({ ready: (await readiness.check()).ready, cause: credentials.status().cause }, { ready: false, cause: "runtime" });

    outcome.value = () => ({ models: ["m"] });
    reachable = true;
    const deadline = Date.now() + 2_000;
    while (!(await readiness.check()).ready && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal((await readiness.check()).ready, true, "Monitoring retries quickly until the sandbox lets the identity verify.");
  } finally { credentials.stopMonitoring(); }
  await prepareReadiness({} as Parameters<typeof prepareReadiness>[0], logger);
});

test("the identity source is mandatory for the Copilot executor and its token never enters config", async () => {
  const root = await mkdtemp(join(tmpdir(), "copilot-identity-config-"));
  try {
    const base = {
      SQUAD_MCP_AUDIENCE: "api://squad", SQUAD_MCP_ENABLE_MEMORY: "true", SQUAD_MCP_MEMORY_AUTO_ENABLED: "true",
      SQUAD_MCP_ENABLE_ARTIFACTS: "true", SQUAD_MCP_MEMORY_DIR: join(root, "memory"),
      SQUAD_MCP_STAGE_EXECUTOR: "copilot", SQUAD_MCP_COPILOT_CLI_URL: "127.0.0.1:4321", SQUAD_MCP_COPILOT_CONNECTION_TOKEN: "c".repeat(32),
    };
    assert.throws(() => loadOperatorConfig(base), /requires a GitHub identity/);
    const fromEnv = loadOperatorConfig({ ...base, SQUAD_MCP_COPILOT_GITHUB_TOKEN: TOKEN_A });
    assert.deepEqual(fromEnv.copilot.identity, { kind: "env", variable: "SQUAD_MCP_COPILOT_GITHUB_TOKEN" });
    assert.ok(!JSON.stringify(fromEnv).includes(TOKEN_A), "The token value is read on demand, never held in config.");
    assert.deepEqual(loadOperatorConfig({ ...base, SQUAD_MCP_COPILOT_GITHUB_TOKEN_COMMAND: "gh auth token" }).copilot.identity,
      { kind: "command", argv: ["gh", "auth", "token"] });
    assert.deepEqual(loadOperatorConfig({ ...base, SQUAD_MCP_COPILOT_GITHUB_TOKEN_COMMAND: "\"C:\\Program Files\\GitHub CLI\\gh.exe\" auth token" }).copilot.identity,
      { kind: "command", argv: ["C:\\Program Files\\GitHub CLI\\gh.exe", "auth", "token"] });
    assert.deepEqual(loadOperatorConfig({ ...base, SQUAD_MCP_COPILOT_GITHUB_TOKEN_FILE: "/run/secrets/gh" }).copilot.identity, { kind: "file", path: "/run/secrets/gh" });
    assert.throws(() => loadOperatorConfig({ ...base, SQUAD_MCP_COPILOT_GITHUB_TOKEN_SOURCE: "file" }), /requires SQUAD_MCP_COPILOT_GITHUB_TOKEN_FILE/);
    assert.throws(() => loadOperatorConfig({ ...base, SQUAD_MCP_COPILOT_GITHUB_TOKEN: TOKEN_A, SQUAD_MCP_COPILOT_IDENTITY_REVERIFY_MS: "10" }), /REVERIFY_MS/);

    const config = loadOperatorConfig({ ...base, SQUAD_MCP_COPILOT_GITHUB_TOKEN: TOKEN_A });
    const source = buildCopilotCredentialSource(config, { SQUAD_MCP_COPILOT_GITHUB_TOKEN: TOKEN_B });
    assert.equal(await source.read(), TOKEN_B, "The env source reads the live environment, not a boot-time copy.");

    const fakeClient = {
      createSession: async () => { throw new Error("not used"); },
      ping: async () => ({}),
      listModels: async () => ["m"],
      stop: async () => undefined,
      entitlementVerifier: () => ({ verify: async (token: string) => ({ models: token === TOKEN_A ? ["claude-sonnet-5"] : [] }) }),
    } as unknown as CopilotSdkClient;
    const runtime = buildCopilotRuntime(config, { memoryStore: new FileSquadMemoryStore({ baseDir: join(root, "memory") }) },
      { env: { SQUAD_MCP_COPILOT_GITHUB_TOKEN: TOKEN_A }, client: fakeClient });
    assert.ok(runtime);
    try {
      const prepared = await runtime.readiness.prepare();
      assert.deepEqual({ ready: prepared.ready, identity: prepared.checks.copilotIdentity.ok }, { ready: true, identity: true });
    } finally { runtime.credentials.stopMonitoring(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
