import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  DurableRunStateStore,
  isValidRunId,
} from "../src/engine/durable-run-state.js";

function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "squad-runs-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("durable store round-trips create/get/update in one instance", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const store = new DurableRunStateStore({ baseDir: dir });
    const run = await store.create({ tenantId: "tenant-a", toolId: "squad_run" });
    assert.equal((await store.get(run.runId))?.status, "running");
    await store.update(run.runId, { status: "complete", artifact: "FINAL ARTIFACT" });
    const done = await store.get(run.runId);
    assert.equal(done?.status, "complete");
    assert.equal(done?.artifact, "FINAL ARTIFACT");
  } finally {
    cleanup();
  }
});

test("durable store survives a cold start: a second instance resolves the run", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const first = new DurableRunStateStore({ baseDir: dir });
    const run = await first.create({ tenantId: "tenant-a", toolId: "squad_run" });
    await first.update(run.runId, { status: "complete", artifact: "SURVIVES RESTART" });

    // Simulate a fresh process / scale-from-zero: a brand-new store instance.
    const second = new DurableRunStateStore({ baseDir: dir });
    const resolved = await second.get(run.runId);
    assert.equal(resolved?.status, "complete");
    assert.equal(resolved?.artifact, "SURVIVES RESTART");
  } finally {
    cleanup();
  }
});

test("durable store rejects a non-UUID run id without touching the filesystem (SEC-4)", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const store = new DurableRunStateStore({ baseDir: dir });
    assert.equal(isValidRunId("../../etc/passwd"), false);
    assert.equal(await store.get("../../etc/passwd"), undefined);
    assert.equal(await store.get("not-a-uuid"), undefined);
    // A well-formed but unknown UUID simply resolves to undefined.
    assert.equal(await store.get("00000000-0000-0000-0000-000000000000"), undefined);
  } finally {
    cleanup();
  }
});
