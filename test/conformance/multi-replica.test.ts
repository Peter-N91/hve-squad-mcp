/**
 * Multi-replica release (WI-06) — an operator approval recorded on ONE replica
 * releases a held run that is polled/driven on ANOTHER replica.
 *
 * Two EmbeddedCoordinators bind to the SAME durable run-state directory through
 * separate store instances (two processes / replicas). Approval is store-backed
 * (RunStoreApprovalChannel), so it is persisted on the shared run record rather
 * than a per-process map: replica B's `/admin/approve` is visible to replica A's
 * poll. This is the gap the in-memory approval channel could not close.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { loadCatalog, type CatalogTool } from "../../src/catalog/catalog.js";
import { EmbeddedCoordinator } from "../../src/engine/embedded.js";
import { EphemeralWorkspaceManager } from "../../src/engine/workspace.js";
import { RunStoreApprovalChannel, TenantQuotaTracker } from "../../src/engine/gates.js";
import { DurableRunStateStore } from "../../src/engine/durable-run-state.js";
import { AesGcmFieldCipher } from "../../src/engine/field-cipher.js";
import type { AuthContext } from "../../src/auth/entra.js";
import type { BackendRequest, BackendResult, ModelBackend } from "../../src/engine/model-backend.js";

class FakeBackend implements ModelBackend {
  readonly id = "fake-backend";
  calls = 0;
  async complete(_request: BackendRequest): Promise<BackendResult> {
    this.calls += 1;
    return { text: `STAGE-${this.calls}`, finishReason: "stop", backendId: this.id, usage: { estimatedCostUsd: 0.01 } };
  }
}

const AUTH_A: AuthContext = { tenantId: "tenant-a", subject: "caller", scopes: [], audience: "api://test" };
const OP: AuthContext = { tenantId: "tenant-a", subject: "operator@contoso.com", scopes: [], audience: "api://test" };
const OP_B: AuthContext = { tenantId: "tenant-b", subject: "operator-b", scopes: [], audience: "api://test" };

function squadRun(): CatalogTool {
  const t = loadCatalog().tools.find((c) => c.id === "squad_run");
  assert.ok(t);
  return t;
}

/** A coordinator + its store-backed approval channel, bound to a shared dir (one replica). */
function replica(dir: string): { engine: EmbeddedCoordinator; backend: FakeBackend } {
  const backend = new FakeBackend();
  // A shared key so encrypted request/context round-trips across replicas.
  const store = new DurableRunStateStore({
    baseDir: dir,
    cipher: new AesGcmFieldCipher(Buffer.from("0".repeat(64), "hex")),
  });
  const approvals = new RunStoreApprovalChannel(store);
  const engine = new EmbeddedCoordinator({
    backend,
    workspaceManager: new EphemeralWorkspaceManager(),
    quota: new TenantQuotaTracker({ concurrency: 4, monthlyCeilingUsd: 500 }),
    runStateStore: store,
    approvals,
  });
  return { engine, backend };
}

test("an approval on replica B releases a held run polled on replica A", async () => {
  const dir = mkdtempSync(join(tmpdir(), "squad-mr-"));
  try {
    const a = replica(dir);
    const b = replica(dir);

    // Replica A starts a held run.
    const started = await a.engine.startHttpRun(squadRun(), { toolId: "squad_run", request: "improve caching" }, { auth: AUTH_A });
    const runId = started.runId!;
    assert.equal(started.outcome, "held");

    // Replica A polls: still held, no model call.
    const held = await a.engine.pollRun(runId, { auth: AUTH_A });
    assert.equal(held.outcome, "held");
    assert.equal(a.backend.calls, 0);

    // Operator approval is recorded on replica B (different process/store instance).
    const approved = await b.engine.approveRun(runId, { auth: OP });
    assert.ok(approved.ok, "the operator on replica B recorded the approval");

    // Replica A now observes the shared approval and drives the run to completion.
    const done = await a.engine.pollRun(runId, { auth: AUTH_A });
    assert.equal(done.outcome, "completed");
    assert.match(done.artifact ?? "", /## Task Reviewer/);
    assert.ok(a.backend.calls >= 2, "the pipeline ran on replica A after the cross-replica approval");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a cross-tenant operator on another replica cannot release the run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "squad-mr-"));
  try {
    const a = replica(dir);
    const b = replica(dir);
    const started = await a.engine.startHttpRun(squadRun(), { toolId: "squad_run", request: "x" }, { auth: AUTH_A });
    const runId = started.runId!;

    // Operator in tenant B cannot release tenant A's run, even on a shared store.
    const denied = await b.engine.approveRun(runId, { auth: OP_B });
    assert.equal(denied.ok, false);

    const stillHeld = await a.engine.pollRun(runId, { auth: AUTH_A });
    assert.equal(stillHeld.outcome, "held");
    assert.equal(a.backend.calls, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
