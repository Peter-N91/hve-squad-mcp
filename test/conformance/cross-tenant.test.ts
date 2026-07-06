/**
 * Conformance corpus 3 — cross-tenant leakage (SEC-4).
 *
 * Drives two tenants' runs and asserts tenant isolation is server-controlled and
 * verifiable:
 *
 *   * workspaces are SERVER-ALLOCATED under a per-tenant namespace (a hash of the
 *     tenant id plus a CSPRNG run id) — never caller-influenced;
 *   * tenant A's ephemeral workspace / run-state / paths never surface in tenant
 *     B's run, and never in tenant B's caller-facing output;
 *   * guaranteed teardown removes each workspace (even the path is never surfaced
 *     to the caller); and
 *   * there is no shared mutable state — every allocation is a fresh directory and
 *     a session minted for one tenant cannot be replayed by another (SEC-8 binding
 *     reinforcing SEC-4).
 *
 * Runs with a deterministic MOCK backend — no live Azure.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadCatalog, type CatalogTool } from "../../src/catalog/catalog.js";
import { EmbeddedCoordinator } from "../../src/engine/embedded.js";
import {
  EphemeralWorkspaceManager,
  type Workspace,
  type WorkspaceManager,
} from "../../src/engine/workspace.js";
import { GateKeeper, TenantQuotaTracker } from "../../src/engine/gates.js";
import { EphemeralRunStateStore } from "../../src/engine/run-state.js";
import { renderEmbeddedResult } from "../../src/engine/render-embedded.js";
import { SessionStore } from "../../src/transports/session-store.js";
import type { AuthContext } from "../../src/auth/entra.js";
import { MockModelBackend } from "./support/mock-backend.js";
import { TENANT_A, TENANT_B } from "./support/scenarios.js";

const catalog = loadCatalog();
const research = catalog.tools.find((t) => t.id === "squad_research") as CatalogTool;

/** A WorkspaceManager that records every allocated root and disposal for assertions. */
class RecordingWorkspaceManager implements WorkspaceManager {
  readonly kind = "ephemeral" as const;
  readonly allocatedRoots: string[] = [];
  readonly disposedRoots: string[] = [];
  private readonly inner: EphemeralWorkspaceManager;

  constructor(baseDir: string) {
    this.inner = new EphemeralWorkspaceManager({ baseDir });
  }

  async allocate(tenantId: string): Promise<Workspace> {
    const ws = await this.inner.allocate(tenantId);
    this.allocatedRoots.push(ws.root);
    return {
      id: ws.id,
      tenantId: ws.tenantId,
      root: ws.root,
      resolve: (p: string) => ws.resolve(p),
      dispose: async () => {
        this.disposedRoots.push(ws.root);
        await ws.dispose();
      },
    };
  }
}

const baseDir = join(tmpdir(), `squad-mcp-xtenant-${process.pid}-${Date.now()}`);

function authFor(tenantId: string, subject: string): AuthContext {
  return { tenantId, subject, scopes: ["Squad.Research"], audience: "api://test" };
}

function tenantNamespace(tenantId: string): string {
  return createHash("sha256").update(tenantId).digest("hex").slice(0, 16);
}

function makeEngine(
  wsm: WorkspaceManager,
  store: EphemeralRunStateStore,
  backend: MockModelBackend,
): EmbeddedCoordinator {
  return new EmbeddedCoordinator({
    backend,
    workspaceManager: wsm,
    quota: new TenantQuotaTracker({ concurrency: 8, monthlyCeilingUsd: 1000 }),
    gates: new GateKeeper(),
    runStateStore: store,
  });
}

test("SEC-4: two tenants get isolated, server-allocated workspaces with no path overlap", async () => {
  const wsm = new RecordingWorkspaceManager(baseDir);
  const store = new EphemeralRunStateStore();
  const backend = new MockModelBackend();
  const engine = makeEngine(wsm, store, backend);

  // Tenant A's request embeds caller-controlled, path-like markers that must NOT
  // influence the server-allocated workspace path.
  const callerMarker = "ZZZ_CALLER_PATH_MARKER_AAAA";
  const aResult = await engine.handle(
    research,
    { toolId: research.id, request: `Research ${callerMarker}`, context: "../../etc/passwd and /abs/leak" },
    { auth: authFor(TENANT_A.tenantId, TENANT_A.subject) },
  );
  const bResult = await engine.handle(
    research,
    { toolId: research.id, request: "Research something benign" },
    { auth: authFor(TENANT_B.tenantId, TENANT_B.subject) },
  );

  assert.equal(aResult.outcome, "completed");
  assert.equal(bResult.outcome, "completed");

  const aRoot = aResult.workspaceRoot;
  const bRoot = bResult.workspaceRoot;
  assert.ok(aRoot, "tenant A workspace root present");
  assert.ok(bRoot, "tenant B workspace root present");

  // Distinct roots, distinct per-tenant namespace segments, no cross-contamination.
  assert.notEqual(aRoot, bRoot);
  assert.ok(aRoot.includes(tenantNamespace(TENANT_A.tenantId)), "A root in A's namespace");
  assert.ok(bRoot.includes(tenantNamespace(TENANT_B.tenantId)), "B root in B's namespace");
  assert.ok(!aRoot.includes(tenantNamespace(TENANT_B.tenantId)), "A root not in B's namespace");
  assert.ok(!bRoot.includes(tenantNamespace(TENANT_A.tenantId)), "B root not in A's namespace");

  // Caller text never influenced the server-allocated path.
  assert.ok(!aRoot.includes(callerMarker), "caller marker absent from path");
  assert.ok(!aRoot.includes("passwd"), "caller path fragment absent from path");

  // Teardown ran for both (SEC-4 guaranteed dispose) — neither directory remains.
  assert.ok(!existsSync(aRoot), "tenant A workspace torn down");
  assert.ok(!existsSync(bRoot), "tenant B workspace torn down");
  assert.equal(wsm.allocatedRoots.length, 2);
  assert.equal(wsm.disposedRoots.length, 2, "every allocation was disposed");

  // Run-state isolation: each run is tagged to its own tenant; no cross-leak.
  const aRunId = aResult.runId;
  const bRunId = bResult.runId;
  assert.ok(aRunId, "tenant A run id present");
  assert.ok(bRunId, "tenant B run id present");
  assert.notEqual(aRunId, bRunId);
  assert.equal((await store.get(aRunId))?.tenantId, TENANT_A.tenantId);
  assert.equal((await store.get(bRunId))?.tenantId, TENANT_B.tenantId);

  // Tenant A's run id / workspace path never surface in tenant B's caller-facing output...
  const bRendered = renderEmbeddedResult(bResult).content.map((c) => c.text).join("\n");
  assert.ok(!bRendered.includes(aRunId), "A run id absent from B output");
  assert.ok(!bRendered.includes(aRoot), "A workspace path absent from B output");
  // ...and the workspace path is never surfaced to the caller at all (defense in depth).
  assert.ok(!bRendered.includes(bRoot), "own workspace path not surfaced to caller");
});

test("SEC-4: workspace.resolve contains path-traversal and absolute-path escapes", async () => {
  const wsm = new EphemeralWorkspaceManager({ baseDir });
  const ws = await wsm.allocate("containment-tenant");
  try {
    assert.throws(() => ws.resolve("../escape.txt"), /escapes the workspace root/);
    assert.throws(() => ws.resolve("/etc/passwd"), /must be relative/);
    // A benign relative path resolves inside the root.
    assert.ok(ws.resolve("artifact.md").startsWith(ws.root));
  } finally {
    await ws.dispose();
  }
});

test("SEC-4: a workspace cannot be allocated without a tenant id (no ambient tenant)", async () => {
  const wsm = new EphemeralWorkspaceManager({ baseDir });
  await assert.rejects(() => wsm.allocate(""), /tenant id is required/);
});

test("SEC-4: a session minted for one tenant cannot be replayed by another (SEC-8 binding)", () => {
  const sessions = new SessionStore({ idleMs: 60_000 });
  const aAuth = authFor(TENANT_A.tenantId, TENANT_A.subject);
  const bAuth = authFor(TENANT_B.tenantId, TENANT_B.subject);
  const aSession = sessions.create(aAuth);
  assert.equal(sessions.validate(aSession.id, aAuth), true, "owner can use its own session");
  assert.equal(sessions.validate(aSession.id, bAuth), false, "tenant B cannot replay tenant A's session");
});
