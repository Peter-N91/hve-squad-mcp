import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { MemoryBackedArtifactStore } from "../src/engine/artifact-store.js";
import { FileSquadMemoryStore } from "../src/engine/backends/file-squad-memory.js";
import { loadProfileTables, resolveProfile } from "../src/engine/profiles.js";
import {
  HISTORY_READ_MAX_CHARS,
  SquadHistory,
} from "../src/engine/squad-history.js";
import { SquadLedger } from "../src/engine/squad-ledger.js";

const TENANT = "11111111-1111-1111-1111-111111111111";
const PROJECT = "default";
const TABLES = loadProfileTables();

function makeHistory(): {
  store: MemoryBackedArtifactStore;
  ledger: SquadLedger;
  history: SquadHistory;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "squad-history-"));
  const store = new MemoryBackedArtifactStore(new FileSquadMemoryStore({ baseDir: dir }));
  return {
    store,
    ledger: new SquadLedger(store),
    history: new SquadHistory(store),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

async function seedRun(fixture: ReturnType<typeof makeHistory>): Promise<void> {
  const { ledger } = fixture;
  await ledger.seed(TENANT, PROJECT, resolveProfile("product", TABLES), TABLES, {
    date: "2026-08-07",
  });
  await ledger.writeDeliverable(TENANT, PROJECT, "lead", "onboarding", "# Plan", TABLES, {
    date: "2026-08-07",
  });
  await ledger.writeDeliverable(TENANT, PROJECT, "researcher", "market", "# Research", TABLES, {
    date: "2026-08-07",
  });
  await ledger.writeDeliverable(TENANT, PROJECT, "analyst", "prd", "# PRD", TABLES, {
    date: "2026-08-07",
  });
  await ledger.appendAgentHistory(TENANT, PROJECT, "Squad Researcher", "### Turn 1");
  await ledger.appendDecision(TENANT, PROJECT, "## Council Verdict — Go");
}

test("an empty project yields no index block rather than an empty one", async () => {
  const fixture = makeHistory();
  try {
    assert.equal(await fixture.history.contextBlock(TENANT, PROJECT), undefined);
    const index = await fixture.history.index(TENANT, PROJECT);
    assert.equal(index.total, 0);
    assert.deepEqual(index.deliverables, []);
  } finally {
    fixture.cleanup();
  }
});

test("the index reports the profile, the deliverable directories, and the agents", async () => {
  const fixture = makeHistory();
  try {
    await seedRun(fixture);
    const index = await fixture.history.index(TENANT, PROJECT);

    assert.equal(index.profile, "product");
    assert.equal(index.turn, 0);
    assert.deepEqual(
      index.deliverables.map((d) => d.directory),
      [".copilot-tracking/plans", ".copilot-tracking/research/2026-08-07"],
    );
    // analyst and lead share the plans root, so that directory holds both.
    assert.equal(
      index.deliverables.find((d) => d.directory === ".copilot-tracking/plans")?.count,
      2,
    );
    assert.deepEqual(index.agents, ["squad-researcher"]);
  } finally {
    fixture.cleanup();
  }
});

test("squad state is not reported as a deliverable", async () => {
  const fixture = makeHistory();
  try {
    await seedRun(fixture);
    const index = await fixture.history.index(TENANT, PROJECT);
    for (const entry of index.deliverables) {
      assert.ok(
        !entry.directory.startsWith(".copilot-tracking/squad"),
        `${entry.directory} is squad state, not a deliverable`,
      );
    }
  } finally {
    fixture.cleanup();
  }
});

test("the context block names the paths a follow-up run can open", async () => {
  const fixture = makeHistory();
  try {
    await seedRun(fixture);
    const block = await fixture.history.contextBlock(TENANT, PROJECT);
    assert.match(block ?? "", /Squad profile: product/);
    assert.match(block ?? "", /\.copilot-tracking\/plans\//);
    assert.match(block ?? "", /squad_history read/);
    assert.match(block ?? "", /Squad Researcher|squad-researcher/);
  } finally {
    fixture.cleanup();
  }
});

test("list browses a subtree and read opens one artifact", async () => {
  const fixture = makeHistory();
  try {
    await seedRun(fixture);
    const plans = await fixture.history.list(TENANT, PROJECT, ".copilot-tracking/plans");
    assert.deepEqual(
      plans.map((e) => e.path),
      [".copilot-tracking/plans/onboarding.md", ".copilot-tracking/plans/prd.md"],
    );

    const opened = await fixture.history.read(
      TENANT,
      PROJECT,
      ".copilot-tracking/plans/onboarding.md",
    );
    assert.equal(opened?.content, "# Plan");
    assert.equal(
      await fixture.history.read(TENANT, PROJECT, ".copilot-tracking/plans/absent.md"),
      undefined,
    );
  } finally {
    fixture.cleanup();
  }
});

test("a read is bounded so one artifact cannot blow the context window", async () => {
  const fixture = makeHistory();
  try {
    const huge = "y".repeat(HISTORY_READ_MAX_CHARS + 1_000);
    await fixture.store.put(TENANT, PROJECT, ".copilot-tracking/plans/big.md", huge);
    const opened = await fixture.history.read(
      TENANT,
      PROJECT,
      ".copilot-tracking/plans/big.md",
    );
    assert.ok((opened?.content.length ?? 0) <= HISTORY_READ_MAX_CHARS + 32);
    assert.match(opened?.content ?? "", /truncated/);
  } finally {
    fixture.cleanup();
  }
});

test("history never crosses a tenant boundary", async () => {
  const fixture = makeHistory();
  try {
    await seedRun(fixture);
    const other = "22222222-2222-2222-2222-222222222222";
    assert.deepEqual(await fixture.history.list(other, PROJECT), []);
    assert.equal(await fixture.history.contextBlock(other, PROJECT), undefined);
    assert.equal(
      await fixture.history.read(other, PROJECT, ".copilot-tracking/plans/onboarding.md"),
      undefined,
    );
  } finally {
    fixture.cleanup();
  }
});

test("a traversal path is rejected rather than served", async () => {
  const fixture = makeHistory();
  try {
    await assert.rejects(
      () => fixture.history.read(TENANT, PROJECT, "../../etc/passwd"),
      /Unsafe artifact path|must sit under/,
    );
  } finally {
    fixture.cleanup();
  }
});
