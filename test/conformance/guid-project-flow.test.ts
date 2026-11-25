import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

import { FileSquadMemoryStore } from "../../src/engine/backends/file-squad-memory.js";
import { AutoMemory } from "../../src/engine/auto-memory.js";
import { MemoryBackedArtifactStore } from "../../src/engine/artifact-store.js";
import { SquadRunRecorder } from "../../src/engine/squad-run-recorder.js";
import { EphemeralRunStateStore } from "../../src/engine/run-state.js";
import { PROJECT_CONTEXT_INDEX_PROJECT, type ProjectContextAcknowledgement } from "../../src/engine/project-context-bridge.js";
import { SquadMemoryResourceProvider } from "../../src/engine/squad-memory-resources.js";
import { TOOL_SCOPES } from "../../src/auth/scopes.js";
import type { HttpResponseLike } from "../../src/transports/http-core.js";
import { buildHarness, callTool, initializeSession, resultText } from "./support/harness.js";

const TENANT = "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";

function context(projectId = ID_A, folderItemId = "folder-a") {
  return {
    schemaVersion: 2, projectId, revision: 1, sequence: 1,
    storage: { provider: "sharepoint", driveId: "drive-a", folderItemId },
  };
}

function bridge(response: HttpResponseLike): ProjectContextAcknowledgement {
  const result = CallToolResultSchema.parse((response.body as { result: unknown }).result);
  assert.notEqual(result.isError, true, resultText(response));
  const value = result.structuredContent?.contextBridge;
  assert.ok(value && typeof value === "object");
  return value as ProjectContextAcknowledgement;
}

async function withProjectHarness(fn: (h: ReturnType<typeof buildHarness>, session: string,
  memory: FileSquadMemoryStore, runs: EphemeralRunStateStore) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "guid-project-flow-"));
  try {
    const memory = new FileSquadMemoryStore({ baseDir: dir });
    const runs = new EphemeralRunStateStore();
    const h = buildHarness({
      memoryStore: memory, runStateStore: runs, artifactsEnabled: true,
      autoMemory: new AutoMemory({ store: memory, defaultProject: "default" }),
      runRecorder: new SquadRunRecorder({ store: new MemoryBackedArtifactStore(memory) }),
    });
    h.verifier.register({
      token: "guid-project-token", tenantId: TENANT, subject: "operator-user",
      scopes: ["Squad.Plan", "Squad.Run", "Squad.Operate", "Squad.Memory", TOOL_SCOPES.squad_memory_write],
    });
    const session = await initializeSession(h.handler, "guid-project-token");
    await fn(h, session, memory, runs);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("HTTP refuses stateless schema-two binding before inference", async () => {
  const h = buildHarness();
  h.verifier.register({
    token: "stateless-guid-token", tenantId: TENANT, subject: "user", scopes: ["Squad.Run"],
  });
  const sessionId = await initializeSession(h.handler, "stateless-guid-token");
  const response = await callTool(h.handler, {
    token: "stateless-guid-token", sessionId, name: "squad_run",
    args: { request: "Plan delivery", project: "northstar", projectContext: context() },
  });
  assert.match(resultText(response), /project_context_conflict/);
  assert.equal(h.backend.callCount, 0);
});

test("HTTP GUID projects isolate reused names and keep artifacts discoverable after rename", async () => {
  await withProjectHarness(async (h, sessionId, memory) => {
    const call = (name: string, args: Record<string, unknown>) =>
      callTool(h.handler, { token: "guid-project-token", sessionId, name, args });
    const first = bridge(await call("squad_plan", {
      request: "Plan Northstar delivery", project: "northstar", projectContext: context(),
    }));
    assert.notEqual(first.project, "northstar");
    assert.ok(first.project.includes(ID_A));
    const resources = new SquadMemoryResourceProvider(memory);
    assert.ok((await resources.list(TENANT))
      .every((entry) => !entry.uri.includes(PROJECT_CONTEXT_INDEX_PROJECT)));
    await assert.rejects(resources.read(TENANT,
      `squad-memory://${PROJECT_CONTEXT_INDEX_PROJECT}/identities/${ID_A}`));
    for (const name of ["squad_memory_write", "squad_memory_sync"]) {
      const denied = await call(name, {
        project: PROJECT_CONTEXT_INDEX_PROJECT, path: `identities/${ID_A}`,
        content: "forged", items: [{ path: `identities/${ID_A}`, content: "forged" }],
      });
      assert.equal((denied.body as { error: { code: number } }).error.code, -32602);
    }
    const second = bridge(await call("squad_plan", {
      request: "Plan a replacement project", project: "northstar",
      projectContext: context(ID_B, "folder-b"),
    }));
    assert.notEqual(second.project, first.project);
    assert.ok((await memory.list(TENANT, first.project)).length > 0);
    assert.ok((await memory.list(TENANT, second.project)).length > 0);
    const renamed = bridge(await call("squad_plan", {
      request: "Review delivery plan", project: "renamed-northstar",
      projectContext: { ...context(), revision: 2, sequence: 2 },
    }));
    assert.equal(renamed.project, first.project);
    assert.equal(renamed.projectId, ID_A);
    const history = await call("squad_history", { project: first.project, op: "index" });
    const result = CallToolResultSchema.parse((history.body as { result: unknown }).result);
    assert.notEqual(result.isError, true);
    assert.ok(Number(result.structuredContent?.total) > 0);
    const beforeConflict = h.backend.callCount;
    const copied = await call("squad_plan", {
      request: "Wrong copy", project: "new-name", projectContext: context(ID_A, "copied-folder"),
    });
    assert.match(resultText(copied), /project_storage_conflict/);
    assert.equal(h.backend.callCount, beforeConflict);
  });
});

test("GUID gate approval and current-checkpoint polls stay bound to the same run and folder", async () => {
  await withProjectHarness(async (h, sessionId, memory, runs) => {
    const call = (name: string, args: Record<string, unknown>) =>
      callTool(h.handler, { token: "guid-project-token", sessionId, name, args });
    const started = bridge(await call("squad_run", {
      request: "Research and plan Northstar delivery", project: "northstar", projectContext: context(),
    }));
    assert.ok(started.runId);
    const initialHistoryResponse = await call("squad_history", {
      project: started.project, op: "list",
    });
    const initialHistory = CallToolResultSchema.parse(
      (initialHistoryResponse.body as { result: unknown }).result);
    assert.notEqual(initialHistory.isError, true);
    assert.doesNotMatch(JSON.stringify(initialHistory), /context\/bridge/);
    assert.equal((await h.embedded.projectContextForRun(started.runId, {
      auth: { tenantId: TENANT, subject: "operator-user", audience: "", scopes: ["Squad.Run"] },
    }))?.project, started.project);
    const wrong = await call("squad_status", {
      runId: started.runId, project: "northstar", projectContext: context(ID_B, "folder-b"),
    });
    assert.match(resultText(wrong), /project_identity_conflict/);
    const approved = await call("squad_approve", {
      runId: started.runId, decision: "approve", projectId: ID_A,
    });
    assert.equal(CallToolResultSchema.parse(
      (approved.body as { result: unknown }).result,
    ).structuredContent?.approved, true);
    const done = bridge(await call("squad_status", {
      runId: started.runId, project: started.project,
      projectContext: { ...context(), revision: 2, sequence: 2 },
    }));
    assert.equal(done.project, started.project);
    assert.equal(done.runId, started.runId);
    assert.equal(done.acceptedRevision, 2);
    assert.equal((await runs.get(started.runId))?.status, "complete");
    assert.ok((await memory.list(TENANT, done.project))
      .some((entry) => entry.path.startsWith(".copilot-tracking/")));
  });
});

test("a held legacy project upgrades its identity without stranding its run or history", async () => {
  await withProjectHarness(async (h, sessionId, memory) => {
    const call = (name: string, args: Record<string, unknown>) =>
      callTool(h.handler, { token: "guid-project-token", sessionId, name, args });
    const started = bridge(await call("squad_run", {
      request: "Plan legacy Northstar", project: "legacy-northstar",
      projectContext: { ...context(), schemaVersion: 1 },
    }));
    assert.equal(started.project, "legacy-northstar");
    await memory.write(TENANT, started.project, "docs/existing.md", "Existing project artifact", undefined);
    const upgraded = bridge(await call("squad_status", {
      runId: started.runId, project: started.project,
      projectContext: { ...context(), revision: 2, sequence: 2 },
    }));
    assert.equal(upgraded.project, started.project);
    assert.equal((await memory.read(TENANT, upgraded.project, "docs/existing.md"))?.content,
      "Existing project artifact");
    const renamed = bridge(await call("squad_status", {
      runId: started.runId, project: "new-display-name",
      projectContext: { ...context(), revision: 3, sequence: 3 },
    }));
    assert.equal(renamed.project, started.project);
    const approved = await call("squad_approve", {
      runId: started.runId, projectId: ID_A, decision: "approve", decisionId: ID_B,
    });

    assert.equal(CallToolResultSchema.parse(
      (approved.body as { result: unknown }).result,
    ).structuredContent?.approved, true);
    const completed = bridge(await call("squad_status", {
      runId: started.runId, project: renamed.project,
      projectContext: { ...context(), revision: 4, sequence: 4 },
    }));
    assert.equal(completed.runId, started.runId);
    assert.equal(completed.project, started.project);
    assert.ok((completed.trackingUpdates?.length ?? 0) > 0);
  });
});

test("unknown and cross-tenant status calls cannot register a GUID project", async () => {
  await withProjectHarness(async (h, sessionId, memory) => {
    const write = memory.write.bind(memory);
    let writes = 0;
    memory.write = async (...args: Parameters<FileSquadMemoryStore["write"]>) => {
      writes++;
      return write(...args);
    };
    const response = await callTool(h.handler, {
      token: "guid-project-token", sessionId, name: "squad_status",
      args: { runId: ID_B, project: "unknown", projectContext: context() },
    });
    assert.match(resultText(response), /run_not_found_or_cross_tenant/);
    assert.equal(writes, 0);
    h.verifier.register({
      token: "foreign-project-token", tenantId: "22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      subject: "another-user", scopes: ["Squad.Run"],
    });
    const foreignSession = await initializeSession(h.handler, "foreign-project-token");
    const started = bridge(await callTool(h.handler, {
      token: "guid-project-token", sessionId, name: "squad_run",
      args: { request: "Research delivery", project: "northstar", projectContext: context() },
    }));
    writes = 0;
    const foreign = await callTool(h.handler, {
      token: "foreign-project-token", sessionId: foreignSession, name: "squad_status",
      args: { runId: started.runId, project: started.project, projectContext: context() },
    });
    assert.match(resultText(foreign), /run_not_found_or_cross_tenant/);
    assert.equal(writes, 0);
  });
});
