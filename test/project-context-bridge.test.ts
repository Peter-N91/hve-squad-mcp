import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ProjectContextBridge,
  ProjectContextError,
  parseProjectContextEnvelope,
  type ProjectContextEnvelope,
} from "../src/engine/project-context-bridge.js";
import type {
  SquadMemoryEntry,
  SquadMemoryStore,
  SquadMemoryWriteResult,
} from "../src/engine/squad-memory-state.js";

const TENANT = "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT = "legora-storyboard";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

class MemoryStore implements SquadMemoryStore {
  private readonly entries = new Map<string, SquadMemoryEntry>();
  private sequence = 0;
  now = 1_000;

  private key(tenantId: string, project: string, path: string): string {
    return `${tenantId}|${project}|${path}`;
  }

  list(tenantId: string, project: string): Promise<SquadMemoryEntry[]> {
    return Promise.resolve(
      [...this.entries.values()].filter(
        (entry) => entry.tenantId === tenantId && entry.project === project,
      ),
    );
  }

  read(
    tenantId: string,
    project: string,
    path: string,
  ): Promise<SquadMemoryEntry | undefined> {
    return Promise.resolve(this.entries.get(this.key(tenantId, project, path)));
  }

  write(
    tenantId: string,
    project: string,
    path: string,
    content: string,
    expectedEtag?: string,
  ): Promise<SquadMemoryWriteResult> {
    const key = this.key(tenantId, project, path);
    const current = this.entries.get(key);
    if (expectedEtag !== undefined && current?.etag !== expectedEtag) {
      return Promise.resolve({
        ok: false,
        conflict: true,
        current,
      });
    }
    this.sequence += 1;
    this.now += 1;
    const entry: SquadMemoryEntry = {
      tenantId,
      project,
      path,
      content,
      etag: `etag-${this.sequence}`,
      updatedAt: this.now,
    };
    this.entries.set(key, entry);
    return Promise.resolve({ ok: true, etag: entry.etag, entry });
  }

  listProjects(tenantId: string): Promise<string[]> {
    return Promise.resolve([
      ...new Set(
        [...this.entries.values()]
          .filter((entry) => entry.tenantId === tenantId)
          .map((entry) => entry.project),
      ),
    ]);
  }
}

function envelope(
  overrides: Partial<ProjectContextEnvelope> = {},
): ProjectContextEnvelope {
  return {
    schemaVersion: 1,
    projectId: PROJECT_ID,
    revision: 4,
    sequence: 8,
    trackingRoot: ".copilot-tracking",
    storage: {
      provider: "sharepoint",
      driveId: "drive-1",
      folderItemId: "folder-1",
      displayPath: "/Projects/Legora",
    },
    ...overrides,
  };
}

test("project context registers, stays current, and advances", async () => {
  const store = new MemoryStore();
  const bridge = new ProjectContextBridge(store, undefined, () => store.now);

  const registered = await bridge.negotiate(TENANT, PROJECT, envelope());
  assert.equal(registered?.status, "registered");
  const current = await bridge.negotiate(TENANT, PROJECT, envelope());
  assert.equal(current?.status, "current");
  const advanced = await bridge.negotiate(
    TENANT,
    PROJECT,
    envelope({ revision: 5, sequence: 9 }),
  );
  assert.equal(advanced?.status, "advanced");
  assert.equal(advanced?.expectedNextRevision, 6);
});

test("project context rejects identity, storage, and stale checkpoint conflicts", async () => {
  const store = new MemoryStore();
  const bridge = new ProjectContextBridge(store, undefined, () => store.now);
  await bridge.negotiate(TENANT, PROJECT, envelope());

  await assert.rejects(
    () =>
      bridge.negotiate(
        TENANT,
        PROJECT,
        envelope({ projectId: "22222222-2222-4222-8222-222222222222" }),
      ),
    (error: unknown) =>
      error instanceof ProjectContextError &&
      error.reason === "project_identity_conflict",
  );
  await assert.rejects(
    () =>
      bridge.negotiate(
        TENANT,
        PROJECT,
        envelope({
          storage: {
            provider: "sharepoint",
            driveId: "drive-1",
            folderItemId: "copied-folder",
          },
        }),
      ),
    (error: unknown) =>
      error instanceof ProjectContextError &&
      error.reason === "project_storage_conflict",
  );
  await assert.rejects(
    () =>
      bridge.negotiate(
        TENANT,
        PROJECT,
        envelope({ storage: { provider: "sharepoint" } }),
      ),
    (error: unknown) =>
      error instanceof ProjectContextError &&
      error.reason === "project_storage_conflict",
  );
  await assert.rejects(
    () =>
      bridge.negotiate(
        TENANT,
        PROJECT,
        envelope({ revision: 3, sequence: 99 }),
      ),
    (error: unknown) =>
      error instanceof ProjectContextError &&
      error.reason === "stale_project_context",
  );
});

test("finalization returns changed tracking files without the registry record", async () => {
  const store = new MemoryStore();
  const bridge = new ProjectContextBridge(store, undefined, () => store.now);
  const acceptedAt = store.now;
  const acknowledgement = await bridge.negotiate(
    TENANT,
    PROJECT,
    envelope(),
  );
  await store.write(
    TENANT,
    PROJECT,
    ".copilot-tracking/squad/state.json",
    '{"turn": 1}',
  );
  await store.write(
    TENANT,
    PROJECT,
    ".copilot-tracking/plans/plan.md",
    "# Plan",
  );
  await store.write(TENANT, PROJECT, "history/internal", "not projected");

  const finalized = await bridge.finalize(
    TENANT,
    acknowledgement,
    "run-1",
    "squad_plan",
    acceptedAt,
  );
  assert.equal(finalized?.trackingStatus, "available");
  assert.deepEqual(
    finalized?.trackingUpdates?.map((update) => update.path),
    [
      ".copilot-tracking/plans/plan.md",
      ".copilot-tracking/squad/state.json",
    ],
  );
  assert.equal(finalized?.runId, "run-1");
});

test("project context parser rejects malformed envelopes", () => {
  assert.throws(
    () =>
      parseProjectContextEnvelope({
        schemaVersion: 1,
        projectId: "not-a-uuid",
        revision: 0,
        sequence: 0,
      }),
    ProjectContextError,
  );
});
