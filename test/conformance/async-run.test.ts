/**
 * Async run + durable run-state conformance (engine level).
 *
 * squad_run stays off the HTTP hero surface (PROD-1); the async run + status-poll
 * MECHANICS are proven here against the real engine (EmbeddedCoordinator) with a
 * DurableRunStateStore and injected fakes — the same "real code, injected fakes"
 * spirit as the HTTP conformance harness. Covers DR-05 case (1)-(4).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { loadCatalog, type CatalogTool } from "../../src/catalog/catalog.js";
import { EmbeddedCoordinator } from "../../src/engine/embedded.js";
import { EphemeralWorkspaceManager } from "../../src/engine/workspace.js";
import { TenantQuotaTracker } from "../../src/engine/gates.js";
import { DurableRunStateStore } from "../../src/engine/durable-run-state.js";
import type { AuthContext } from "../../src/auth/entra.js";
import type {
  BackendRequest,
  BackendResult,
  ModelBackend,
} from "../../src/engine/model-backend.js";

class FakeBackend implements ModelBackend {
  readonly id = "fake-backend";
  calls = 0;
  async complete(_request: BackendRequest): Promise<BackendResult> {
    this.calls += 1;
    return { text: `STAGE-${this.calls}`, finishReason: "stop", backendId: this.id, usage: { estimatedCostUsd: 0.01 } };
  }
}

function squadRun(): CatalogTool {
  const t = loadCatalog().tools.find((c) => c.id === "squad_run");
  assert.ok(t, "catalog defines squad_run");
  return t;
}

const AUTH_A: AuthContext = { tenantId: "tenant-a", subject: "u1", scopes: [], audience: "api://test" };
const AUTH_B: AuthContext = { tenantId: "tenant-b", subject: "u2", scopes: [], audience: "api://test" };

function engineWith(dir: string, backend: FakeBackend): EmbeddedCoordinator {
  return new EmbeddedCoordinator({
    backend,
    workspaceManager: new EphemeralWorkspaceManager(),
    quota: new TenantQuotaTracker({ concurrency: 4, monthlyCeilingUsd: 500 }),
    runStateStore: new DurableRunStateStore({ baseDir: dir }),
  });
}

test("DR-05(1): squad_run start returns a well-formed run id WITHOUT running the pipeline", async () => {
  const dir = mkdtempSync(join(tmpdir(), "squad-async-"));
  try {
    const backend = new FakeBackend();
    const engine = engineWith(dir, backend);
    const { runId } = await engine.startRun(squadRun(), { auth: AUTH_A });
    assert.match(runId, /^[0-9a-f-]{36}$/i);
    assert.equal(backend.calls, 0, "no model call on start (non-blocking)");
    assert.equal((await engine.getRunStatus(runId, { auth: AUTH_A }))?.status, "running");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("DR-05(2): status returns running, then the finished artifact after completion", async () => {
  const dir = mkdtempSync(join(tmpdir(), "squad-async-"));
  try {
    const backend = new FakeBackend();
    const engine = engineWith(dir, backend);
    const { runId } = await engine.startRun(squadRun(), { auth: AUTH_A });
    assert.equal((await engine.getRunStatus(runId, { auth: AUTH_A }))?.status, "running");

    const result = await engine.runToCompletion(runId, { toolId: "squad_run", request: "improve caching" }, { auth: AUTH_A }, []);
    assert.equal(result.outcome, "completed");
    assert.equal(backend.calls, 2);

    const status = await engine.getRunStatus(runId, { auth: AUTH_A });
    assert.equal(status?.status, "complete");
    assert.match(status?.artifact ?? "", /## Task Researcher/);
    assert.match(status?.artifact ?? "", /## Task Reviewer/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("DR-05(3): a status/run call for another tenant's run id is denied (no leakage)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "squad-async-"));
  try {
    const backend = new FakeBackend();
    const engine = engineWith(dir, backend);
    const { runId } = await engine.startRun(squadRun(), { auth: AUTH_A });

    // Tenant B cannot see tenant A's run.
    assert.equal(await engine.getRunStatus(runId, { auth: AUTH_B }), undefined);
    // Tenant B cannot execute tenant A's run — and no model call happens.
    const denied = await engine.runToCompletion(runId, { toolId: "squad_run", request: "x" }, { auth: AUTH_B }, []);
    assert.equal(denied.outcome, "denied");
    assert.equal(denied.reason, "run_not_found_or_cross_tenant");
    assert.equal(backend.calls, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("DR-05(4): a run started on one instance resolves + completes on a fresh instance (cold start)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "squad-async-"));
  try {
    // Instance 1 starts the run, then "the process restarts".
    const { runId } = await engineWith(dir, new FakeBackend()).startRun(squadRun(), { auth: AUTH_A });

    // Instance 2 (fresh process, same durable dir) resolves and completes it.
    const backend2 = new FakeBackend();
    const engine2 = engineWith(dir, backend2);
    assert.equal((await engine2.getRunStatus(runId, { auth: AUTH_A }))?.status, "running");
    const result = await engine2.runToCompletion(runId, { toolId: "squad_run", request: "x" }, { auth: AUTH_A }, []);
    assert.equal(result.outcome, "completed");

    // Instance 3 (another fresh process) reads the completed artifact.
    const engine3 = engineWith(dir, new FakeBackend());
    assert.equal((await engine3.getRunStatus(runId, { auth: AUTH_A }))?.status, "complete");
    assert.match((await engine3.getRunStatus(runId, { auth: AUTH_A }))?.artifact ?? "", /## Task Reviewer/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
