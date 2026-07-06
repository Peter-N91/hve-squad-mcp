import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { loadCatalog, type CatalogTool } from "../src/catalog/catalog.js";
import { EmbeddedCoordinator } from "../src/engine/embedded.js";
import { EphemeralWorkspaceManager } from "../src/engine/workspace.js";
import { TenantQuotaTracker } from "../src/engine/gates.js";
import type { AuthContext } from "../src/auth/entra.js";
import type {
  BackendRequest,
  BackendResult,
  ModelBackend,
} from "../src/engine/model-backend.js";

class FakeBackend implements ModelBackend {
  readonly id = "fake-backend";
  calls = 0;
  async complete(_request: BackendRequest): Promise<BackendResult> {
    this.calls += 1;
    return {
      text: `STAGE-${this.calls} OUTPUT`,
      finishReason: "stop",
      backendId: this.id,
      usage: { estimatedCostUsd: 0.02 },
    };
  }
}

function makeCastFixture(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "squad-pipeline-cast-"));
  mkdirSync(root, { recursive: true });
  const persona = (name: string, body: string): string =>
    ["---", `name: ${name}`, "---", "", body, ""].join("\n");
  writeFileSync(join(root, "task-researcher.agent.md"), persona("Task Researcher", "Researcher body."), "utf8");
  writeFileSync(join(root, "task-reviewer.agent.md"), persona("Task Reviewer", "Reviewer body."), "utf8");
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function tool(id: string): CatalogTool {
  const t = loadCatalog().tools.find((c) => c.id === id);
  assert.ok(t, `catalog defines ${id}`);
  return t;
}

const AUTH: AuthContext = {
  tenantId: "tenant-a",
  subject: "user-1",
  scopes: [],
  audience: "api://test",
};

test("executePipeline runs the two-stage pipeline to completion in an isolated workspace", async () => {
  const { root, cleanup } = makeCastFixture();
  const backend = new FakeBackend();
  const engine = new EmbeddedCoordinator({
    backend,
    workspaceManager: new EphemeralWorkspaceManager(),
    quota: new TenantQuotaTracker({ concurrency: 4, monthlyCeilingUsd: 500 }),
  });
  try {
    const result = await engine.executePipeline(tool("squad_run"), { toolId: "squad_run", request: "improve caching" }, { auth: AUTH }, [root]);

    assert.equal(result.outcome, "completed");
    assert.equal(backend.calls, 2); // two stages dispatched
    assert.ok(result.artifact);
    assert.match(result.artifact, /## Task Researcher/);
    assert.match(result.artifact, /## Task Reviewer/);
    assert.match(result.artifact, /STAGE-1 OUTPUT/);
    assert.match(result.artifact, /STAGE-2 OUTPUT/);
    assert.ok(result.runId, "a run id is allocated");
    // SEC-4 — the ephemeral workspace is torn down on return.
    assert.ok(result.workspaceRoot);
    assert.equal(existsSync(result.workspaceRoot), false);
  } finally {
    cleanup();
  }
});

test("executePipeline falls back to paraphrase personas when no cast is on disk", async () => {
  // With an empty roots dir, resolvePersonaForRole falls back to the paraphrase
  // record for the two known hero roles, so the pipeline still completes without
  // a deployed cast (deterministic CI behavior).
  const root = mkdtempSync(join(tmpdir(), "squad-pipeline-empty-"));
  const backend = new FakeBackend();
  const engine = new EmbeddedCoordinator({
    backend,
    workspaceManager: new EphemeralWorkspaceManager(),
    quota: new TenantQuotaTracker({ concurrency: 4, monthlyCeilingUsd: 500 }),
  });
  try {
    const result = await engine.executePipeline(tool("squad_run"), { toolId: "squad_run", request: "x" }, { auth: AUTH }, [root]);
    assert.equal(result.outcome, "completed");
    assert.equal(backend.calls, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
