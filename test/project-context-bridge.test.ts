import assert from "node:assert/strict";
import { test } from "node:test";
import { Ajv } from "ajv";

import {
  ProjectContextBridge,
  ProjectContextError,
  PROJECT_CONTEXT_INDEX_PROJECT,
  PROJECT_CONTEXT_INDEX_PATH_PREFIX,
  PROJECT_CONTEXT_INPUT_SCHEMA,
  PROJECT_CONTEXT_REGISTRY_PATH,
  parseProjectContextEnvelope,
  isProjectContextMetadata,
  statelessProjectContextAcknowledgement,
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
    if (expectedEtag === "" ? current !== undefined :
      expectedEtag !== undefined && current?.etag !== expectedEtag) {
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

function durable(overrides: Partial<ProjectContextEnvelope> = {}): ProjectContextEnvelope {
  return envelope({ schemaVersion: 2, ...overrides });
}

function reason(expected: ProjectContextError["reason"]): (error: unknown) => boolean {
  return (error) => error instanceof ProjectContextError && error.reason === expected;
}

test("schema v2 separates reused display names and ignores a different legacy UUID", async () => {
  const store = new MemoryStore();
  const bridge = new ProjectContextBridge(store);
  await bridge.negotiate(TENANT, PROJECT, envelope());
  await store.write(TENANT, PROJECT, "docs/legacy.md", "legacy history");
  const oldRegistry = await store.read(TENANT, PROJECT, PROJECT_CONTEXT_REGISTRY_PATH);
  const newId = "22222222-2222-4222-8222-222222222222";
  const fresh = await bridge.negotiate(TENANT, PROJECT, durable({
    projectId: newId,
    storage: { provider: "sharepoint", driveId: "drive-1", folderItemId: "recreated-folder" },
  }));
  assert.equal(fresh?.project, `project-${newId}`);
  assert.deepEqual(await store.read(TENANT, PROJECT, PROJECT_CONTEXT_REGISTRY_PATH), oldRegistry);
  assert.equal((await store.read(TENANT, PROJECT, "docs/legacy.md"))?.content, "legacy history");
  const third = await bridge.negotiate(TENANT, PROJECT, durable({
    projectId: "33333333-3333-4333-8333-333333333333",
  }));
  assert.notEqual(fresh?.project, third?.project);
});

test("schema v2 uses normalized GUIDs across renames, restarts, and absent display names", async () => {
  const store = new MemoryStore();
  const id = "ABCDEFAB-ABCD-4ABC-8ABC-ABCDEFABCDEF";
  const first = await new ProjectContextBridge(store).negotiate(
    TENANT, PROJECT, durable({ projectId: id }),
  );
  assert.equal(first?.project, `project-${id.toLowerCase()}`);
  assert.equal(first?.projectId, id.toLowerCase());
  assert.equal(first?.schemaVersion, 2);
  assert.equal(first?.storage?.folderItemId, "folder-1");
  const bridge = new ProjectContextBridge(store);
  assert.equal(await bridge.resolveProject(TENANT, "renamed-project", durable({
    projectId: id.toLowerCase(),
  })), first?.project);
  const renamed = await bridge.negotiate(TENANT, undefined, durable({
    projectId: id.toLowerCase(), revision: 5, sequence: 9,
    storage: { ...durable().storage!, displayPath: "/Renamed/Folder" },
  }));
  assert.equal(renamed?.project, first?.project);
  assert.equal(renamed?.status, "advanced");
});

test("schema v2 rejects copied folders, changed drives, and provider changes before negotiation", async () => {
  const store = new MemoryStore();
  const bridge = new ProjectContextBridge(store);
  await bridge.resolveProject(TENANT, PROJECT, durable());
  for (const storage of [
    { provider: "sharepoint" as const, driveId: "drive-1", folderItemId: "copy" },
    { provider: "sharepoint" as const, driveId: "another-drive", folderItemId: "folder-1" },
    { provider: "onedrive" as const, driveId: "drive-1", folderItemId: "folder-1" },
  ]) {
    await assert.rejects(
      bridge.resolveProject(TENANT, "renamed", durable({ storage })),
      reason("project_storage_conflict"),
    );
  }
  const accepted = await bridge.negotiate(TENANT, PROJECT, durable());
  assert.equal(accepted?.status, "registered");
});

test("schema v2 identities and folder bindings are tenant isolated", async () => {
  const store = new MemoryStore();
  const bridge = new ProjectContextBridge(store);
  const first = await bridge.negotiate(TENANT, PROJECT, durable());
  const secondTenant = "22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const second = await bridge.negotiate(secondTenant, PROJECT, durable({
    storage: { provider: "onedrive", driveId: "other-drive", folderItemId: "other-folder" },
  }));
  assert.equal(first?.project, second?.project);
  assert.equal((await store.list(TENANT, PROJECT_CONTEXT_INDEX_PROJECT)).length, 1);
  assert.equal((await store.list(secondTenant, PROJECT_CONTEXT_INDEX_PROJECT)).length, 1);
});

test("legacy upgrade preserves its partition and history across later renames", async () => {
  const store = new MemoryStore();
  const bridge = new ProjectContextBridge(store);
  await bridge.negotiate(TENANT, PROJECT, envelope());
  await store.write(TENANT, PROJECT, "history/old-run", "existing run history");
  const upgraded = await bridge.negotiate(TENANT, PROJECT, durable());
  assert.equal(upgraded?.project, PROJECT);
  assert.equal(upgraded?.status, "advanced");
  assert.equal(JSON.parse((await store.read(TENANT, PROJECT, PROJECT_CONTEXT_REGISTRY_PATH))!.content).schemaVersion, 2);
  assert.equal(await new ProjectContextBridge(store).resolveProject(TENANT, "renamed", durable()), PROJECT);
  assert.equal((await store.read(TENANT, PROJECT, "history/old-run"))?.content, "existing run history");
  const legacyCall = await bridge.negotiate(TENANT, PROJECT, envelope({ revision: 5, sequence: 9 }));
  assert.equal(legacyCall?.schemaVersion, 1);
  assert.equal(JSON.parse((await store.read(TENANT, PROJECT, PROJECT_CONTEXT_REGISTRY_PATH))!.content).schemaVersion, 2);
  await assert.rejects(
    bridge.negotiate(TENANT, PROJECT, envelope({ revision: 6, storage: undefined })),
    reason("project_storage_conflict"),
  );
});

test("legacy upgrade cannot infer a missing binding or rebind a copied folder", async () => {
  for (const storage of [undefined, { provider: "sharepoint" as const }]) {
    const store = new MemoryStore();
    const bridge = new ProjectContextBridge(store);
    await bridge.negotiate(TENANT, PROJECT, envelope({ storage }));
    await assert.rejects(bridge.resolveProject(TENANT, PROJECT, durable()), reason("project_storage_conflict"));
    assert.equal((await store.list(TENANT, PROJECT_CONTEXT_INDEX_PROJECT)).length, 0);
  }
});

test("schema v2 stale revisions and sequences cannot overwrite the accepted checkpoint", async () => {
  const store = new MemoryStore();
  const bridge = new ProjectContextBridge(store);
  const accepted = await bridge.negotiate(TENANT, PROJECT, durable());
  const before = await store.read(TENANT, accepted!.project, PROJECT_CONTEXT_REGISTRY_PATH);
  for (const update of [{ revision: 3, sequence: 99 }, { revision: 4, sequence: 7 }]) {
    await assert.rejects(
      bridge.negotiate(TENANT, "new-name", durable(update)),
      reason("stale_project_context"),
    );
  }
  assert.deepEqual(await store.read(TENANT, accepted!.project, PROJECT_CONTEXT_REGISTRY_PATH), before);
});

test("simultaneous identical GUID registration converges using create-only CAS", async () => {
  const store = new MemoryStore();
  const one = new ProjectContextBridge(store);
  const two = new ProjectContextBridge(store);
  const partitions = await Promise.all([
    one.resolveProject(TENANT, PROJECT, durable()),
    two.resolveProject(TENANT, "renamed", durable()),
  ]);
  assert.deepEqual(partitions, [`project-${PROJECT_ID}`, `project-${PROJECT_ID}`]);
  assert.equal((await store.list(TENANT, PROJECT_CONTEXT_INDEX_PROJECT)).length, 1);
  const results = await Promise.allSettled([
    one.negotiate(TENANT, PROJECT, durable()),
    two.negotiate(TENANT, PROJECT, durable()),
  ]);
  assert.ok(results.some((result) => result.status === "fulfilled"));
  for (const result of results) {
    if (result.status === "rejected") assert.ok(reason("project_context_conflict")(result.reason));
  }
  assert.equal((await two.negotiate(TENANT, PROJECT, durable()))?.status, "current");
});

test("simultaneous competing folder bindings fail closed and never overwrite the winner", async () => {
  const store = new MemoryStore();
  const contexts = [durable(), durable({
    storage: { provider: "sharepoint", driveId: "drive-1", folderItemId: "copied-folder" },
  })];
  const results = await Promise.allSettled(contexts.map((context) =>
    new ProjectContextBridge(store).resolveProject(TENANT, PROJECT, context),
  ));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.ok(rejected?.status === "rejected" && reason("project_storage_conflict")(rejected.reason));
  const winner = results.findIndex((result) => result.status === "fulfilled");
  const index = (await store.list(TENANT, PROJECT_CONTEXT_INDEX_PROJECT))[0]!;
  assert.equal(JSON.parse(index.content).storage.folderItemId, contexts[winner]!.storage!.folderItemId);
});

test("simultaneous legacy migrations to different partitions cannot overwrite the GUID index", async () => {
  const store = new MemoryStore();
  const bridge = new ProjectContextBridge(store);
  await bridge.negotiate(TENANT, "legacy-one", envelope());
  await bridge.negotiate(TENANT, "legacy-two", envelope());
  const results = await Promise.allSettled([
    bridge.resolveProject(TENANT, "legacy-one", durable()),
    new ProjectContextBridge(store).resolveProject(TENANT, "legacy-two", durable()),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.ok(rejected?.status === "rejected" && reason("project_context_conflict")(rejected.reason));
  assert.equal((await store.list(TENANT, PROJECT_CONTEXT_INDEX_PROJECT)).length, 1);
});

test("v2 rejects malformed input before writing any identity or registry", async () => {
  const store = new MemoryStore();
  const bridge = new ProjectContextBridge(store);
  const invalid: unknown[] = [
    { ...durable(), schemaVersion: 3 },
    { ...durable(), projectId: "not-a-uuid" },
    { ...durable(), storage: undefined },
    { ...durable(), storage: { provider: "sharepoint" } },
    { ...durable(), storage: { provider: "dropbox", driveId: "drive", folderItemId: "folder" } },
    { ...durable(), storage: { provider: "onedrive", driveId: " ", folderItemId: "folder" } },
    { ...durable(), storage: { provider: "onedrive", driveId: 123, folderItemId: "folder" } },
    { ...durable(), storage: { provider: "onedrive", driveId: "drive", folderItemId: " folder " } },
    { ...durable(), storage: { ...durable().storage, displayPath: {} } },
    { ...durable(), revision: Number.MAX_SAFE_INTEGER + 1 },
    { ...durable(), sequence: -1 },
    { ...durable(), digest: {} },
  ];
  for (const value of invalid) {
    await assert.rejects(
      bridge.resolveProject(TENANT, PROJECT, value as ProjectContextEnvelope),
      reason("invalid_project_context"),
    );
  }
  await assert.rejects(
    bridge.resolveProject(TENANT, PROJECT_CONTEXT_INDEX_PROJECT, durable()),
    reason("invalid_project_context"),
  );
  assert.deepEqual(await store.listProjects(TENANT), []);
});

test("malformed or competing durable index records fail closed", async () => {
  const path = `identities/${PROJECT_ID}`;
  const valid = {
    schemaVersion: 1, projectId: PROJECT_ID, project: `project-${PROJECT_ID}`,
    storage: durable().storage,
  };
  for (const content of [
    "{", "null", "[]",
    JSON.stringify({ ...valid, projectId: "22222222-2222-4222-8222-222222222222" }),
    JSON.stringify({ ...valid, project: "../escape" }),
    JSON.stringify({ ...valid, storage: { provider: "onedrive" } }),
    JSON.stringify({ ...valid, project: "missing-legacy" }),
  ]) {
    const store = new MemoryStore();
    await store.write(TENANT, PROJECT_CONTEXT_INDEX_PROJECT, path, content);
    await assert.rejects(
      new ProjectContextBridge(store).resolveProject(TENANT, PROJECT, durable()),
      reason("project_context_conflict"),
    );
    assert.equal((await store.read(TENANT, PROJECT_CONTEXT_INDEX_PROJECT, path))?.content, content);
  }
  const store = new MemoryStore();
  await store.write(TENANT, PROJECT_CONTEXT_INDEX_PROJECT, path, JSON.stringify(valid));
  await store.write(TENANT, valid.project, PROJECT_CONTEXT_REGISTRY_PATH, JSON.stringify({
    ...envelope({ projectId: "22222222-2222-4222-8222-222222222222" }),
    project: valid.project, acceptedAt: 0,
  }));
  await assert.rejects(
    new ProjectContextBridge(store).resolveProject(TENANT, PROJECT, durable()),
    reason("project_identity_conflict"),
  );
});

test("identity index and registry are excluded from tracking updates", async () => {
  const store = new MemoryStore();
  const bridge = new ProjectContextBridge(store);
  const accepted = await bridge.negotiate(TENANT, PROJECT, durable());
  await store.write(TENANT, accepted!.project, "docs/report.md", "# Report");
  const result = await bridge.finalize(TENANT, accepted, undefined, "squad_plan", 0);
  assert.deepEqual(result?.trackingUpdates?.map((update) => update.path), ["docs/report.md"]);
  assert.equal(await bridge.resolveProject(TENANT, PROJECT, undefined), PROJECT);
  assert.equal(await bridge.resolveProject(TENANT, undefined, undefined), undefined);
});

test("advertised envelope schema accepts legacy and uppercase GUIDs but requires v2 storage IDs", () => {
  const validate = new Ajv().compile(PROJECT_CONTEXT_INPUT_SCHEMA);
  assert.equal(validate(envelope({ storage: undefined })), true);
  assert.equal(validate(durable({ projectId: "ABCDEFAB-ABCD-4ABC-8ABC-ABCDEFABCDEF" })), true);
  assert.equal(validate(durable({ storage: undefined })), false);
  assert.equal(validate(durable({ storage: { provider: "sharepoint" } })), false);
});

test("v2 resolves both the display slug and acknowledged partition, including legacy upgrades", async () => {
  for (const upgrade of [false, true]) {
    const store = new MemoryStore();
    const bridge = new ProjectContextBridge(store);
    if (upgrade) await bridge.negotiate(TENANT, PROJECT, envelope());
    const accepted = await bridge.negotiate(TENANT, PROJECT, durable());
    assert.ok(accepted);
    for (const project of [PROJECT, accepted.project, "renamed-display-slug"]) {
      assert.equal(await bridge.resolveProject(TENANT, project, durable()), accepted.project);
      assert.equal((await bridge.negotiate(TENANT, project, durable()))?.project, accepted.project);
    }
  }
});

test("stateless schema v2 fails explicitly while legacy stateless acknowledgement is unchanged", () => {
  for (const project of [PROJECT, undefined]) {
    assert.throws(
      () => statelessProjectContextAcknowledgement(project, durable()),
      reason("project_context_conflict"),
    );
  }
  assert.equal(statelessProjectContextAcknowledgement(PROJECT, envelope())?.status, "stateless");
  assert.equal(statelessProjectContextAcknowledgement(PROJECT, envelope())?.project, PROJECT);
  assert.equal(statelessProjectContextAcknowledgement(undefined, undefined), undefined);
});

test("broker metadata guard reserves the complete identity partition and project registry", () => {
  assert.equal(isProjectContextMetadata(PROJECT_CONTEXT_INDEX_PROJECT), true);
  assert.equal(isProjectContextMetadata(PROJECT_CONTEXT_INDEX_PROJECT, `${PROJECT_CONTEXT_INDEX_PATH_PREFIX}${PROJECT_ID}`), true);
  assert.equal(isProjectContextMetadata(PROJECT_CONTEXT_INDEX_PROJECT, "state"), true);
  assert.equal(isProjectContextMetadata(PROJECT, PROJECT_CONTEXT_REGISTRY_PATH), true);
  assert.equal(isProjectContextMetadata(`project-${PROJECT_ID}`, PROJECT_CONTEXT_REGISTRY_PATH), true);
  assert.equal(isProjectContextMetadata(PROJECT, "docs/report.md"), false);
  assert.equal(isProjectContextMetadata(PROJECT), false);
});
