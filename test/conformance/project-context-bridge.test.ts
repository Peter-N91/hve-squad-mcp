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
import {
  buildHarness,
  callTool,
  initializeSession,
  resultText,
} from "./support/harness.js";
import { FakeJwtVerifier, bearer } from "./support/fake-auth.js";

const TENANT = "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT_CONTEXT = {
  schemaVersion: 1,
  projectId: "11111111-1111-4111-8111-111111111111",
  revision: 4,
  sequence: 8,
  trackingRoot: ".copilot-tracking",
  storage: {
    provider: "sharepoint",
    driveId: "drive-1",
    folderItemId: "folder-1",
  },
};

test("HTTP project context is acknowledged and identity collisions fail before inference", async () => {
  const dir = mkdtempSync(join(tmpdir(), "squad-context-http-"));
  try {
    const verifier = new FakeJwtVerifier();
    const memoryStore = new FileSquadMemoryStore({ baseDir: dir });
    const harness = buildHarness({
      verifier,
      memoryStore,
      artifactsEnabled: true,
      autoMemory: new AutoMemory({
        store: memoryStore,
        defaultProject: "default",
      }),
      runRecorder: new SquadRunRecorder({
        store: new MemoryBackedArtifactStore(memoryStore),
      }),
    });
    verifier.register({
      token: "project-context",
      tenantId: TENANT,
      subject: "cowork-user",
      scopes: ["Squad.Plan", "Squad.Run", "Squad.Memory", "Squad.MemoryWrite"],
    });
    const sessionId = await initializeSession(harness.handler, "project-context");

    const first = await callTool(harness.handler, {
      token: "project-context",
      sessionId,
      name: "squad_plan",
      args: {
        request: "Plan the delivery.",
        project: "legora-storyboard",
        projectContext: PROJECT_CONTEXT,
      },
    });
    const firstResult = (first.body as {
      result?: {
        structuredContent?: {
          contextBridge?: {
            status?: string;
            project?: string;
            expectedNextRevision?: number;
            trackingUpdates?: { path?: string; content?: string }[];
          };
        };
      };
    }).result;
    assert.equal(firstResult?.structuredContent?.contextBridge?.status, "registered");
    assert.equal(firstResult?.structuredContent?.contextBridge?.project, "legora-storyboard");
    assert.equal(firstResult?.structuredContent?.contextBridge?.expectedNextRevision, 5);
    const updates =
      firstResult?.structuredContent?.contextBridge?.trackingUpdates ?? [];
    assert.ok(
      updates.some((update) => update.path === ".copilot-tracking/squad/team.md"),
      "first call returns the seeded roster for M365 projection",
    );
    assert.ok(
      updates.some((update) => update.path === ".copilot-tracking/squad/state.json"),
      "first call returns squad state for M365 projection",
    );
    assert.ok(
      updates.some((update) => update.path?.startsWith(".copilot-tracking/plans/")),
      "the role deliverable is included in the tracking delta",
    );
    assert.match(resultText(first), /contextBridge/);
    const callsAfterFirst = harness.backend.callCount;

    const historyIndex = await callTool(harness.handler, {
      token: "project-context",
      sessionId,
      name: "squad_history",
      args: {
        project: "legora-storyboard",
        op: "index",
      },
      id: 21,
    });
    const historyResult = (historyIndex.body as { result?: unknown }).result;
    assert.equal(CallToolResultSchema.safeParse(historyResult).success, true);
    assert.match(resultText(historyIndex), /legora-storyboard/);
    assert.ok(
      (
        historyResult as {
          structuredContent?: { total?: number };
        }
      ).structuredContent?.total,
    );

    const collision = await callTool(harness.handler, {
      token: "project-context",
      sessionId,
      name: "squad_plan",
      args: {
        request: "Plan the delivery again.",
        project: "legora-storyboard",
        projectContext: {
          ...PROJECT_CONTEXT,
          projectId: "22222222-2222-4222-8222-222222222222",
        },
      },
      id: 3,
    });
    assert.match(resultText(collision), /project_identity_conflict/);
    assert.equal(
      harness.backend.callCount,
      callsAfterFirst,
      "identity collision is rejected before a model call",
    );

    const reservedWrite = await callTool(harness.handler, {
      token: "project-context",
      sessionId,
      name: "squad_memory_write",
      args: {
        project: "legora-storyboard",
        path: "context/bridge",
        content: "hijack",
      },
      id: 4,
    });
    assert.match(
      (reservedWrite.body as { error?: { message?: string } }).error?.message ?? "",
      /server-reserved path/,
    );
    const resources = await harness.handler.handle({
      method: "POST",
      path: "/mcp",
      headers: {
        origin: "https://copilotstudio.microsoft.com",
        authorization: bearer("project-context"),
        "mcp-session-id": sessionId,
        "content-type": "application/json",
      },
      body: {
        jsonrpc: "2.0",
        id: 41,
        method: "resources/list",
        params: {},
      },
    });
    assert.doesNotMatch(JSON.stringify(resources.body), /context\/bridge/);

    const started = await callTool(harness.handler, {
      token: "project-context",
      sessionId,
      name: "squad_run",
      args: {
        request: "Run the governed workflow.",
        project: "legora-storyboard",
        projectContext: PROJECT_CONTEXT,
      },
      id: 5,
    });
    const runId = resultText(started).match(/"runId": "([^"]+)"/)?.[1];
    assert.ok(runId);

    const wrongPoll = await callTool(harness.handler, {
      token: "project-context",
      sessionId,
      name: "squad_status",
      args: {
        runId,
        project: "different-project",
        projectContext: {
          ...PROJECT_CONTEXT,
          projectId: "33333333-3333-4333-8333-333333333333",
        },
      },
      id: 6,
    });
    assert.match(resultText(wrongPoll), /project_identity_conflict/);

    const boundPoll = await callTool(harness.handler, {
      token: "project-context",
      sessionId,
      name: "squad_status",
      args: { runId },
      id: 7,
    });
    const boundResult = (boundPoll.body as {
      result?: {
        structuredContent?: {
          contextBridge?: { project?: string; projectId?: string };
        };
      };
    }).result;
    assert.equal(
      boundResult?.structuredContent?.contextBridge?.project,
      "legora-storyboard",
    );
    assert.equal(
      boundResult?.structuredContent?.contextBridge?.projectId,
      PROJECT_CONTEXT.projectId,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
