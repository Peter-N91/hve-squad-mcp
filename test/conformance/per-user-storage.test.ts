import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { withUserStoragePartition } from "../../src/auth/user-storage-partition.js";
import { FileSquadMemoryStore } from "../../src/engine/backends/file-squad-memory.js";
import { PerUserCopilotCredentials } from "../../src/engine/copilot/user-credentials.js";
import { TenantQuotaTracker } from "../../src/engine/gates.js";
import { UserIdentityGate } from "../../src/transports/user-identity-gate.js";
import { buildHarness, callTool, initializeSession } from "./support/harness.js";
import { bearer, FakeJwtVerifier } from "./support/fake-auth.js";

function gate() {
  return new UserIdentityGate({
    executionTools: new Set(["squad_run"]),
    credentials: new PerUserCopilotCredentials({
      tokens: { tokenFor: async () => { throw new Error("No token should be acquired for a memory read."); } },
      verifier: { verify: async () => ({ models: [] }) },
    }),
    link: {
      begin: async () => ({ url: "https://example.invalid/", expiresAt: Date.now() + 60000 }),
      status: async () => ({ linked: false }),
      unlink: async () => {},
    },
  });
}

test("same-tenant private history, resources and binary references share the same user boundary", async () => {
  const dir = await mkdtemp(join(tmpdir(), "private-user-memory-"));
  try {
    const memoryStore = new FileSquadMemoryStore({ baseDir: dir });
    const verifier = new FakeJwtVerifier();
    for (const [token, oid, sub] of [
      ["alice-cowork", "alice", "pairwise-cowork"],
      ["alice-studio", "alice", "pairwise-studio"],
      ["bob", "bob", "pairwise-bob"],
    ]) {
      verifier.register({ token, tenantId: "tenant", subject: oid, sub, scopes: ["Squad.Memory", "Squad.MemoryWrite"] });
    }
    let binaryCalls = 0;
    const harness = buildHarness({
      verifier, memoryStore, userIdentity: gate(), artifactsEnabled: true,
      localArtifactChunk: async () => { binaryCalls++; return undefined; },
    });
    const alice = await initializeSession(harness.handler, "alice-cowork");
    const studio = await initializeSession(harness.handler, "alice-studio");
    const bob = await initializeSession(harness.handler, "bob");
    const write = await callTool(harness.handler, {
      token: "alice-cowork", sessionId: alice, name: "squad_memory_write",
      args: { project: "same-project", path: "state", content: "ALICE-PRIVATE" },
    });
    assert.equal(write.status, 200);
    const read = (token: string, sessionId: string) => callTool(harness.handler, {
      token, sessionId, name: "squad_memory_read", args: { project: "same-project", path: "state" },
    });
    assert.match(JSON.stringify((await read("alice-studio", studio)).body), /ALICE-PRIVATE/);
    assert.doesNotMatch(JSON.stringify((await read("bob", bob)).body), /ALICE-PRIVATE/);
    const rpc = (method: string, params: Record<string, unknown>) => harness.handler.handle({
      method: "POST", path: "/mcp",
      headers: { authorization: bearer("bob"), "mcp-session-id": bob, "content-type": "application/json" },
      body: { jsonrpc: "2.0", id: 10, method, params },
    });
    const listed = await rpc("resources/list", {});
    assert.doesNotMatch(JSON.stringify(listed.body), /same-project|ALICE-PRIVATE/);
    const resource = await rpc("resources/read", { uri: "squad-memory://same-project/state" });
    assert.doesNotMatch(JSON.stringify(resource.body), /ALICE-PRIVATE/);
    const privatePartition = withUserStoragePartition({
      tenantId: "tenant", subject: "alice", objectId: "alice", tokenKind: "delegated", scopes: [], audience: "api",
    }).tenantId;
    assert.equal((await memoryStore.read(privatePartition, "same-project", "state"))?.content, "ALICE-PRIVATE");
    assert.equal(await memoryStore.read("tenant", "same-project", "state"), undefined);
    const history = await callTool(harness.handler, {
      token: "bob", sessionId: bob, name: "squad_history", args: { project: "same-project", op: "index" },
    });
    assert.doesNotMatch(JSON.stringify(history.body), /ALICE-PRIVATE/);
    assert.equal(binaryCalls, 0);
    const foreignDelete = await harness.handler.handle({
      method: "DELETE", path: "/mcp", headers: { authorization: bearer("bob"), "mcp-session-id": alice },
    });
    assert.equal(foreignDelete.status, 404);
    assert.match(JSON.stringify((await read("alice-cowork", alice)).body), /ALICE-PRIVATE/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("user quota and aggregate tenant quota are both enforced", () => {
  const quota = new TenantQuotaTracker({
    concurrency: 2, monthlyCeilingUsd: 100, userConcurrency: 1, userMonthlyCeilingUsd: 25,
  });
  quota.bindUserPartition("alice-partition", "tenant");
  quota.bindUserPartition("bob-partition", "tenant");
  const alice = quota.acquire("alice-partition");
  assert.equal(alice.ok, true);
  assert.equal(quota.acquire("alice-partition").ok, false);
  const bob = quota.acquire("bob-partition");
  assert.equal(bob.ok, true);
  assert.equal(quota.activeCount("tenant"), 2);
  if (alice.ok) alice.release();
  if (bob.ok) bob.release();
  quota.recordCostUsd("alice-partition", 25);
  assert.equal(quota.spentUsd("tenant"), 25);
  assert.equal(quota.acquire("alice-partition").ok, false);
  assert.equal(quota.acquire("bob-partition").ok, true);
  assert.throws(() => quota.bindUserPartition("alice-partition", "other"), /authority mismatch/);
});
