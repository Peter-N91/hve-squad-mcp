import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

import { FileSquadMemoryStore } from "../../src/engine/backends/file-squad-memory.js";
import { GateKeeper } from "../../src/engine/gates.js";
import {
  PROJECT_CONTEXT_INDEX_PROJECT,
  PROJECT_CONTEXT_REGISTRY_PATH,
  ProjectContextBridge,
  type ProjectContextAcknowledgement,
  type ProjectContextEnvelope,
} from "../../src/engine/project-context-bridge.js";
import { EphemeralRunStateStore } from "../../src/engine/run-state.js";
import { responsibleAiBlocker } from "../../src/engine/responsible-ai.js";
import type { HttpResponseLike } from "../../src/transports/http-core.js";
import { buildHarness, callTool, initializeSession, resultText } from "./support/harness.js";

const TENANT = "aaaaaaaa-1111-4111-8111-111111111111";
const OTHER_TENANT = "bbbbbbbb-2222-4222-8222-222222222222";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const CONTEXT: ProjectContextEnvelope = {
  schemaVersion: 2,
  projectId: PROJECT_ID,
  revision: 1,
  sequence: 1,
  storage: { provider: "sharepoint", driveId: "async-drive", folderItemId: "async-folder" },
};

function result(response: HttpResponseLike) {
  return CallToolResultSchema.parse((response.body as { result: unknown }).result);
}

function bridge(response: HttpResponseLike): ProjectContextAcknowledgement {
  const value = result(response).structuredContent?.contextBridge;
  assert.ok(value && typeof value === "object", resultText(response));
  return value as ProjectContextAcknowledgement;
}

function machine(response: HttpResponseLike): {
  outcome: string;
  reason?: string;
  runId: string;
  contextBridge?: Omit<ProjectContextAcknowledgement, "trackingUpdates"> & {
    trackingUpdatePaths: string[];
  };
} {
  // Deliberately inspect only text: some MCP clients discard structuredContent.
  const json = resultText(response).match(/## machine-readable\s+```json\s+([\s\S]*?)\s+```/)?.[1];
  assert.ok(json, resultText(response));
  return JSON.parse(json);
}

async function fixture(t: TestContext, advisoryAutopilotEnabled = true) {
  const directory = mkdtempSync(join(process.cwd(), ".async-project-writeback-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const memory = new FileSquadMemoryStore({ baseDir: directory });
  const runs = new EphemeralRunStateStore();
  const h = buildHarness({
    memoryStore: memory,
    runStateStore: runs,
    artifactsEnabled: true,
    gates: new GateKeeper({ advisoryAutopilotEnabled }),
  });
  for (const [token, tenantId] of [["owner", TENANT], ["other", OTHER_TENANT]]) {
    h.verifier.register({
      token, tenantId, subject: `${token}-user`, scopes: ["Squad.Run", "Squad.Memory"],
    });
  }
  const sessionId = await initializeSession(h.handler, "owner");
  const otherSessionId = await initializeSession(h.handler, "other");
  const call = (name: string, args: Record<string, unknown>, other = false) =>
    callTool(h.handler, {
      token: other ? "other" : "owner",
      sessionId: other ? otherSessionId : sessionId,
      name, args,
    });
  const start = async (project = "async-delivery", projectContext = CONTEXT) => {
    const response = await call("squad_run", {
      request: "Research and plan delivery.", project, projectContext,
    });
    assert.notEqual(result(response).isError, true, resultText(response));
    const ack = bridge(response);
    assert.ok(ack.runId);
    return { response, project: ack.project, runId: ack.runId };
  };
  const write = async (project: string, path: string, content: string, tenant = TENANT) => {
    assert.equal((await memory.write(tenant, project, path, content)).ok, true);
  };
  const claim = async (runId: string) => {
    const claimed = await runs.claim(runId, ["running"], "running", { leaseMs: 60_000 });
    assert.equal(claimed?.status, "running");
    assert.ok(claimed?.leaseExpiresAt && claimed.leaseExpiresAt > Date.now());
  };
  return { ...h, memory, runs, call, start, write, claim };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function readWholeArtifact(h: Fixture, project: string, path: string, expected: string) {
  let offset = 0;
  let content = "";
  const sha256 = createHash("sha256").update(expected).digest("hex");
  const etags = new Set<unknown>();
  for (let pageNumber = 0; pageNumber < 4; pageNumber += 1) {
    const response = await h.call("squad_history", { project, op: "read", path, offset });
    assert.notEqual(result(response).isError, true, resultText(response));
    const page = result(response).structuredContent;
    assert.ok(page);
    const firstContent = result(response).content[0];
    assert.equal(firstContent.type, "text");
    assert.ok("text" in firstContent && typeof firstContent.text === "string");
    assert.deepEqual(JSON.parse(firstContent.text), page,
      "text-only clients receive the same exact page receipt as structured clients");
    assert.equal(page.project, project);
    assert.equal(page.path, path);
    assert.equal(page.offset, offset);
    assert.equal(page.totalChars, expected.length);
    assert.equal(page.totalBytes, Buffer.byteLength(expected, "utf8"));
    assert.equal(page.sha256, sha256);
    assert.equal(typeof page.content, "string");
    const text = page.content as string;
    assert.equal(text, expected.slice(offset, offset + 64_000));
    assert.equal(page.endOffset, offset + text.length);
    assert.equal(page.pageSha256, createHash("sha256").update(text, "utf8").digest("hex"));
    assert.equal(typeof page.etag, "string");
    assert.ok(page.etag);
    etags.add(page.etag);
    content += text;
    if (page.nextOffset === null) {
      assert.equal(content, expected);
      assert.deepEqual(Buffer.from(content, "utf8"), Buffer.from(expected, "utf8"));
      assert.equal(createHash("sha256").update(content, "utf8").digest("hex"), sha256);
      assert.equal(etags.size, 1, "all pages refer to the same persisted artifact version");
      return;
    }
    assert.equal(page.nextOffset, offset + text.length);
    assert.equal(page.truncated, true);
    offset = page.nextOffset as number;
  }
  assert.fail("bounded history pagination did not recover the complete artifact");
}

test("leased worker progress is projected across repeated running polls without executing or finishing the run",
  { timeout: 15_000 }, async (t) => {
    const h = await fixture(t);
    const { response, project, runId } = await h.start();
    assert.equal(machine(response).reason, "queued");
    assert.equal((await h.runs.get(runId))?.status, "running");
    assert.deepEqual(bridge(response).trackingUpdates, []);
    await h.claim(runId);
    const before = await h.call("squad_status", { runId });
    assert.equal(machine(before).reason, "run_already_in_flight");
    assert.deepEqual(bridge(before).trackingUpdates, []);

    // Model the worker's persistence boundary using the real stores, not a mocked poll response.
    const path = `.copilot-tracking/research/${runId}/partial.md`;
    const content = "# Research progress\nEvidence is persisted; review is still pending.";
    await h.write(project, path, content);
    await h.runs.update(runId, {
      stages: [{ role: "Squad Researcher", artifact: content }],
      history: [{ stage: "Squad Researcher", at: new Date().toISOString() }],
    });
    await delay(5);
    const runBeforePoll = structuredClone(await h.runs.get(runId));
    const bindingBeforePoll = await h.memory.read(TENANT, project, PROJECT_CONTEXT_REGISTRY_PATH);
    const first = await h.call("squad_status", { runId });
    const second = await h.call("squad_status", { runId });
    for (const poll of [first, second]) {
      assert.notEqual(result(poll).isError, true);
      assert.equal(machine(poll).outcome, "held");
      assert.equal(machine(poll).reason, "run_already_in_flight");
      assert.equal(machine(poll).runId, runId);
      assert.equal(bridge(poll).trackingStatus, "available");
      assert.equal(bridge(poll).trackingTruncated, false);
      assert.deepEqual(bridge(poll).trackingUpdates?.map(({ path, content }) => ({ path, content })),
        [{ path, content }]);
      assert.deepEqual(machine(poll).contextBridge?.trackingUpdatePaths, [path]);
      assert.doesNotMatch(resultText(poll), /Human Gate — approval required|Produced server-side under/);
    }
    assert.deepEqual(bridge(second), bridge(first));
    assert.deepEqual(await h.runs.get(runId), runBeforePoll);
    assert.deepEqual(await h.memory.read(TENANT, project, PROJECT_CONTEXT_REGISTRY_PATH), bindingBeforePoll);
    assert.equal(h.backend.callCount, 0);
    await readWholeArtifact(h, project, path, content);
  });

test("failed async work preserves its partial output and failure receipt for text-only clients",
  { timeout: 15_000 }, async (t) => {
    const h = await fixture(t);
    const { project, runId } = await h.start();
    await h.claim(runId);
    const path = `.copilot-tracking/plans/${runId}/partial-plan.md`;
    const content = "# Partial plan\nResearch completed; architecture review did not run.";
    await h.write(project, path, content);
    await h.runs.update(runId, {
      status: "failed", failureReason: "worker_review_failed",
      artifact: content, stages: [{ role: "Squad Planner", artifact: content }],
    });
    await delay(5);
    const persisted = structuredClone(await h.runs.get(runId));
    const failed = await h.call("squad_status", { runId });
    assert.equal(result(failed).isError, true);
    assert.ok(resultText(failed).includes(content));
    assert.match(resultText(failed), /stopped \(worker_review_failed\).*did not complete successfully/);
    assert.doesNotMatch(resultText(failed), /No model call was made/);
    const receipt = machine(failed);
    assert.equal(receipt.outcome, "denied");
    assert.equal(receipt.reason, "worker_review_failed");
    assert.equal(receipt.runId, runId);
    assert.equal(receipt.contextBridge?.project, project);
    assert.equal(receipt.contextBridge?.projectId, PROJECT_ID);
    assert.equal(receipt.contextBridge?.trackingStatus, "available");
    assert.deepEqual(receipt.contextBridge?.trackingUpdatePaths, [path]);
    assert.deepEqual(bridge(failed).trackingUpdates?.map(({ path, content }) => ({ path, content })),
      [{ path, content }]);
    assert.deepEqual(result(await h.call("squad_status", { runId })), result(failed));
    assert.deepEqual(await h.runs.get(runId), persisted);
    await readWholeArtifact(h, project, path, content);
  });

for (const status of ["failed", "complete"] as const) {
  test(`terminal ${status} status remains readable after the project checkpoint advances`,
    { timeout: 15_000 }, async (t) => {
      const h = await fixture(t);
      const { project, runId } = await h.start();
      const policy = status === "failed"
        ? responsibleAiBlocker({ status: 400, providerCode: "ContentFiltered" }, "Independent Review", runId)
        : undefined;
      await h.runs.update(runId, {
        status, artifact: "Preserved authored draft",
        failureReason: policy ? "model_backend_content_policy" : undefined,
        responsibleAi: policy,
      });
      await new ProjectContextBridge(h.memory).negotiate(TENANT, project,
        { ...CONTEXT, revision: 2, sequence: 2 });
      const runBefore = structuredClone(await h.runs.get(runId));
      const bindingBefore = await h.memory.read(TENANT, project, PROJECT_CONTEXT_REGISTRY_PATH);
      let writes = 0;
      const write = h.memory.write.bind(h.memory);
      h.memory.write = async (...args) => { writes += 1; return write(...args); };

      const polled = await h.call("squad_status", { runId });
      assert.equal(machine(polled).runId, runId);
      assert.equal(machine(polled).outcome, status === "failed" ? "denied" : "completed");
      assert.equal(machine(polled).contextBridge, undefined);
      assert.match(resultText(polled), /Read-only terminal status/);
      assert.equal(result(polled).content.length, 1);
      assert.ok(resultText(polled).startsWith("Read-only terminal status"));
      assert.ok(resultText(polled).includes("Preserved authored draft"));
      if (policy) assert.deepEqual(result(polled).structuredContent?.responsibleAi, policy);
      const explicitStale = await h.call("squad_status",
        { runId, project, projectContext: CONTEXT });
      assert.match(resultText(explicitStale), /stale_project_context/);
      const foreign = await h.call("squad_status", { runId }, true);
      assert.doesNotMatch(resultText(foreign), /Preserved authored draft|ContentFiltered|Independent Review/);
      const wrongIdentity = await h.call("squad_status",
        { runId, project, projectContext: { ...CONTEXT, projectId: OTHER_PROJECT_ID } });
      assert.match(resultText(wrongIdentity), /project_identity_conflict/);
      assert.equal(writes, 0);
      assert.deepEqual(await h.runs.get(runId), runBefore);
      assert.deepEqual(await h.memory.read(TENANT, project, PROJECT_CONTEXT_REGISTRY_PATH), bindingBefore);
    });
}

test("active status still rejects an inherited stale checkpoint without advancing or running work",
  { timeout: 15_000 }, async (t) => {
    const h = await fixture(t);
    const { project, runId } = await h.start();
    await h.claim(runId);
    await new ProjectContextBridge(h.memory).negotiate(TENANT, project,
      { ...CONTEXT, revision: 2, sequence: 2 });
    const before = structuredClone(await h.runs.get(runId));
    const polled = await h.call("squad_status", { runId });
    assert.match(resultText(polled), /stale_project_context/);
    assert.deepEqual(await h.runs.get(runId), before);
  });

for (const sizeCase of ["single oversized", "accumulated oversized"] as const) {
  test(`${sizeCase} worker artifacts declare truncation and remain losslessly retrievable from history`,
    { timeout: 15_000 }, async (t) => {
      const h = await fixture(t);
      const { project, runId } = await h.start();
      await h.claim(runId);
      const firstPath = `.copilot-tracking/research/${runId}/a-evidence.md`;
      const secondPath = `.copilot-tracking/research/${runId}/b-evidence.md`;
      const receiptPath = `outputs/${runId}/receipt.md`;
      const firstContent = "A".repeat(sizeCase === "single oversized" ? 107_000 : 40_000);
      const secondContent = "B".repeat(sizeCase === "single oversized" ? 19 : 40_000);
      const receiptContent = "Worker wrote both evidence artifacts; delivery is not complete.";
      const artifacts = [
        { path: firstPath, content: firstContent },
        { path: secondPath, content: secondContent },
        { path: receiptPath, content: receiptContent },
      ];
      for (const artifact of artifacts) await h.write(project, artifact.path, artifact.content);
      await delay(5);
      const response = await h.call("squad_status", { runId });
      const ack = bridge(response);
      assert.equal(ack.trackingStatus, "available");
      assert.equal(ack.trackingTruncated, true);
      assert.equal(machine(response).contextBridge?.trackingTruncated, true);
      assert.equal(machine(response).reason, "run_already_in_flight");
      const expected = sizeCase === "single oversized" ? [artifacts[1], artifacts[2]]
        : [artifacts[0], artifacts[2]];
      assert.deepEqual(ack.trackingUpdates?.map(({ path, content }) => ({ path, content })), expected);
      assert.deepEqual(machine(response).contextBridge?.trackingUpdatePaths, expected.map(({ path }) => path));
      assert.deepEqual(bridge(await h.call("squad_status", { runId })), ack);
      for (const artifact of artifacts) await readWholeArtifact(h, project, artifact.path, artifact.content);
      assert.equal((await h.runs.get(runId))?.status, "running");
    });
}

test("project, folder and tenant conflicts disclose no worker artifacts and cannot mutate the held binding",
  { timeout: 15_000 }, async (t) => {
    const h = await fixture(t, false);
    const { project, runId } = await h.start();
    const otherContext: ProjectContextEnvelope = {
      ...CONTEXT, projectId: OTHER_PROJECT_ID,
      storage: { ...CONTEXT.storage!, folderItemId: "other-folder" },
    };
    const otherRun = await h.start("other-project", otherContext);
    const ownPath = `.copilot-tracking/research/${runId}/private.md`;
    const otherPath = `.copilot-tracking/research/${otherRun.runId}/private.md`;
    await h.write(project, ownPath, "OWNER-PARTIAL-ONLY");
    await h.write(otherRun.project, otherPath, "OTHER-PROJECT-ONLY");
    await h.write(project, ownPath, "OTHER-TENANT-ONLY", OTHER_TENANT);
    const snapshot = {
      run: structuredClone(await h.runs.get(runId)),
      binding: await h.memory.read(TENANT, project, PROJECT_CONTEXT_REGISTRY_PATH),
      identity: await h.memory.list(TENANT, PROJECT_CONTEXT_INDEX_PROJECT),
      otherBinding: await h.memory.read(TENANT, otherRun.project, PROJECT_CONTEXT_REGISTRY_PATH),
    };
    for (const args of [
      { runId, project: otherRun.project, projectContext: otherContext },
      { runId, project, projectContext: { ...CONTEXT, revision: 2, storage: otherContext.storage } },
    ]) {
      const denied = await h.call("squad_status", args);
      assert.equal(result(denied).isError, true);
      assert.match(resultText(denied), /project_(identity|storage)_conflict/);
      assert.doesNotMatch(JSON.stringify(denied.body), /OWNER-PARTIAL-ONLY|OTHER-PROJECT-ONLY|OTHER-TENANT-ONLY/);
    }
    const crossTenant = await h.call("squad_status", {
      runId, project, projectContext: { ...CONTEXT, revision: 9, sequence: 9 },
    }, true);
    assert.equal(result(crossTenant).isError, true);
    assert.match(resultText(crossTenant), /run_not_found_or_cross_tenant/);
    assert.equal(result(crossTenant).structuredContent?.contextBridge, undefined);
    assert.doesNotMatch(JSON.stringify(crossTenant.body), /OWNER-PARTIAL-ONLY|OTHER-PROJECT-ONLY|OTHER-TENANT-ONLY/);
    const tenantHistory = await h.call("squad_history", {
      project, op: "read", path: ownPath, offset: 0,
    }, true);
    assert.equal(result(tenantHistory).structuredContent?.content, "OTHER-TENANT-ONLY");
    assert.doesNotMatch(JSON.stringify(tenantHistory.body), /OWNER-PARTIAL-ONLY|OTHER-PROJECT-ONLY/);
    const absentHistory = await h.call("squad_history", {
      project: otherRun.project, op: "read", path: otherPath, offset: 0,
    }, true);
    assert.equal(result(absentHistory).structuredContent?.found, false);
    assert.doesNotMatch(JSON.stringify(absentHistory.body), /OTHER-PROJECT-ONLY/);
    assert.equal(await h.memory.read(OTHER_TENANT, project, PROJECT_CONTEXT_REGISTRY_PATH), undefined);
    assert.deepEqual(await h.memory.list(OTHER_TENANT, PROJECT_CONTEXT_INDEX_PROJECT), []);
    assert.deepEqual(await h.runs.get(runId), snapshot.run);
    assert.deepEqual(await h.memory.read(TENANT, project, PROJECT_CONTEXT_REGISTRY_PATH), snapshot.binding);
    assert.deepEqual(await h.memory.list(TENANT, PROJECT_CONTEXT_INDEX_PROJECT), snapshot.identity);
    assert.deepEqual(await h.memory.read(TENANT, otherRun.project, PROJECT_CONTEXT_REGISTRY_PATH), snapshot.otherBinding);
    const legitimate = await h.call("squad_status", { runId });
    assert.match(resultText(legitimate), /Human Gate — approval required/);
    assert.deepEqual(bridge(legitimate).trackingUpdates?.map(({ path, content }) => ({ path, content })),
      [{ path: ownPath, content: "OWNER-PARTIAL-ONLY" }]);
    assert.equal((await h.runs.get(runId))?.status, "held");
    assert.equal(h.backend.callCount, 0);
  });

test("next-revision turns keep an old run's project immutable and reject retroactive attachment",
  { timeout: 15_000 }, async (t) => {
    const h = await fixture(t);
    const old = await h.start();
    await h.claim(old.runId);
    const path = `.copilot-tracking/research/${old.runId}/old-worker.md`;
    const content = "This belongs only to the original run's project.";
    await h.write(old.project, path, content);
    const original = structuredClone(await h.runs.get(old.runId));
    const nextContext = { ...CONTEXT, revision: 2, sequence: 2 };
    const next = await h.start("renamed-delivery", nextContext);
    assert.equal(next.project, old.project);
    assert.notEqual(next.runId, old.runId);
    const another = await h.start("async-delivery", {
      ...nextContext, projectId: OTHER_PROJECT_ID,
      storage: { ...CONTEXT.storage!, folderItemId: "replacement-folder" },
    });
    assert.notEqual(another.project, old.project);
    const replacementBinding = await h.memory.read(TENANT, another.project, PROJECT_CONTEXT_REGISTRY_PATH);
    const denied = await h.call("squad_status", {
      runId: old.runId, project: another.project,
      projectContext: { ...nextContext, projectId: OTHER_PROJECT_ID,
        storage: { ...CONTEXT.storage!, folderItemId: "replacement-folder" } },
    });
    assert.equal(result(denied).isError, true);
    assert.match(resultText(denied), /project_identity_conflict/);
    assert.ok(!JSON.stringify(denied.body).includes(content));
    const oldPoll = await h.call("squad_status", {
      runId: old.runId, project: old.project, projectContext: nextContext,
    });
    assert.notEqual(result(oldPoll).isError, true, resultText(oldPoll));
    assert.equal(bridge(oldPoll).acceptedRevision, 2);
    assert.equal(bridge(oldPoll).projectId, PROJECT_ID);
    assert.equal(bridge(oldPoll).runId, old.runId);
    assert.deepEqual(bridge(oldPoll).trackingUpdates?.map(({ path, content }) => ({ path, content })),
      [{ path, content }]);
    assert.deepEqual(await h.runs.get(old.runId), original);
    assert.deepEqual(await h.memory.read(TENANT, another.project, PROJECT_CONTEXT_REGISTRY_PATH), replacementBinding);
    const notFound = await h.call("squad_history", { project: another.project, op: "read", path, offset: 0 });
    assert.equal(result(notFound).structuredContent?.found, false);
    await readWholeArtifact(h, old.project, path, content);
  });
