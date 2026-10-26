import assert from "node:assert/strict";
import { test } from "node:test";
import { userSessionClient } from "../src/engine/copilot/user-session-client.js";
import type { CopilotClientPort, CopilotSessionConfig, CopilotSessionPort } from "../src/engine/copilot/copilot-stage-executor.js";
import type { RunState } from "../src/engine/run-state.js";
import type { PerUserStack } from "../src/server-per-user.js";

const run: RunState = {
  runId: "owned-run", tenantId: "private-partition", toolId: "squad_run", status: "running", createdAt: 1,
  owner: { objectId: "alice", authorityTenantId: "tenant", githubUserId: 101 },
};

test("native and upstream sessions recheck the saved owner before turns and tool execution", async () => {
  let connected = true;
  let originalToolCalls = 0;
  let sent = 0;
  let configured: CopilotSessionConfig | undefined;
  const users: Pick<PerUserStack, "runPreflight" | "tokenProviderForRun"> = {
    runPreflight: async saved => {
      assert.equal(saved, run);
      return connected ? { ok: true } : { ok: false, code: "github_connection_required", reason: "Reconnect." };
    },
    tokenProviderForRun: saved => {
      assert.equal(saved.owner?.githubUserId, 101);
      return async () => ({ kind: "token", accessToken: "synthetic-session-token", expiresIn: 28800 });
    },
  };
  const session: CopilotSessionPort = {
    on: () => () => {},
    sendAndWait: async () => { sent++; return { data: { content: "complete" } }; },
    abort: async () => {},
    disconnect: async () => {},
  };
  const original: CopilotClientPort = {
    createSession: async config => { configured = config; return session; },
    resumeSession: async (_id, config) => { configured = config; return session; },
  };
  const config: CopilotSessionConfig = {
    sessionId: "session", systemMessage: { mode: "append", content: "test" }, availableTools: [], tools: [],
    hooks: {
      onPreToolUse: () => { originalToolCalls++; return { permissionDecision: "allow" }; },
      onPostToolUse: async () => undefined,
    },
    onPermissionRequest: () => ({ kind: "reject" }),
    fileSystem: {
      readFile: async () => "",
      writeFile: async () => {},
      appendFile: async () => {},
      exists: async () => false,
      stat: async () => ({ isFile: false, isDirectory: false, size: 0, mtime: "", birthtime: "" }),
      mkdir: async () => {},
      readdir: async () => [],
      readdirWithTypes: async () => [],
      rm: async () => {},
      rename: async () => {},
    },
    gitHubToken: "must-not-survive",
    workingDirectory: "/workspace", streaming: false,
  };
  const guard = userSessionClient(original, users, run);
  const opened = await guard.createSession(config);
  assert.equal(configured?.gitHubToken, undefined);
  const provider = await configured!.gitHubTokenProvider!({ host: "github.com", reason: "initial" });
  assert.equal(provider.kind, "token");
  await opened.sendAndWait({ prompt: "test" }, 1000);
  assert.equal(sent, 1);
  connected = false;
  await assert.rejects(opened.sendAndWait({ prompt: "test" }, 1000), /Reconnect/);
  await assert.rejects(Promise.resolve(configured!.hooks.onPreToolUse({ toolName: "view", toolArgs: {}, sessionId: "session" })), /Reconnect/);
  assert.equal(originalToolCalls, 0);
  await assert.rejects(guard.resumeSession!("session", config), /Reconnect/);
  assert.equal(sent, 1);
});
