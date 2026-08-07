import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  ARTIFACT_MAX_CHARS,
  assertSafeArtifactPath,
  MemoryBackedArtifactStore,
  SQUAD_STATE_ROOT,
} from "../src/engine/artifact-store.js";
import { FileSquadMemoryStore } from "../src/engine/backends/file-squad-memory.js";
import { loadProfileTables, resolveProfile } from "../src/engine/profiles.js";
import {
  agentHistoryPath,
  DECISIONS_PATH,
  initialState,
  renderTeamMarkdown,
  SquadLedger,
  STATE_PATH,
  STATE_SCHEMA_VERSION,
  TEAM_PATH,
} from "../src/engine/squad-ledger.js";

const TENANT = "11111111-1111-1111-1111-111111111111";
const PROJECT = "default";
const TABLES = loadProfileTables();

function makeStore(): { store: MemoryBackedArtifactStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "squad-artifacts-"));
  return {
    store: new MemoryBackedArtifactStore(new FileSquadMemoryStore({ baseDir: dir })),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("an artifact path must be traversal-safe and sit under an allowed root", () => {
  assertSafeArtifactPath(".copilot-tracking/plans/x.md");
  assertSafeArtifactPath("docs/architecture/hld.md");
  assertSafeArtifactPath("outputs/notebook.ipynb");
  for (const bad of [
    "../secrets",
    ".copilot-tracking/../../etc/passwd",
    "/etc/passwd",
    "etc/passwd",
    "",
  ]) {
    assert.throws(() => assertSafeArtifactPath(bad), `${JSON.stringify(bad)} must be rejected`);
  }
});

test("put then get round-trips an artifact", async () => {
  const { store, cleanup } = makeStore();
  try {
    const written = await store.put(TENANT, PROJECT, ".copilot-tracking/plans/a.md", "# Plan");
    assert.equal(written.ok, true);
    const read = await store.get(TENANT, PROJECT, ".copilot-tracking/plans/a.md");
    assert.equal(read?.content, "# Plan");
    assert.equal(read?.tenantId, TENANT);
  } finally {
    cleanup();
  }
});

test("list filters by prefix and returns metadata in path order", async () => {
  const { store, cleanup } = makeStore();
  try {
    await store.put(TENANT, PROJECT, ".copilot-tracking/plans/b.md", "b");
    await store.put(TENANT, PROJECT, ".copilot-tracking/plans/a.md", "aa");
    await store.put(TENANT, PROJECT, ".copilot-tracking/research/r.md", "rrr");
    await store.put(TENANT, PROJECT, "docs/d.md", "dddd");

    const plans = await store.list(TENANT, PROJECT, ".copilot-tracking/plans");
    assert.deepEqual(
      plans.map((e) => e.path),
      [".copilot-tracking/plans/a.md", ".copilot-tracking/plans/b.md"],
    );
    assert.equal(plans[0].size, 2);

    const tracking = await store.list(TENANT, PROJECT, ".copilot-tracking");
    assert.equal(tracking.length, 3);
    assert.equal((await store.list(TENANT, PROJECT)).length, 4);
  } finally {
    cleanup();
  }
});

test("a prefix never matches a sibling that merely shares a name stem", async () => {
  const { store, cleanup } = makeStore();
  try {
    await store.put(TENANT, PROJECT, ".copilot-tracking/plans/a.md", "in");
    await store.put(TENANT, PROJECT, ".copilot-tracking/plans-archive/a.md", "out");
    const plans = await store.list(TENANT, PROJECT, ".copilot-tracking/plans");
    assert.deepEqual(plans.map((e) => e.path), [".copilot-tracking/plans/a.md"]);
  } finally {
    cleanup();
  }
});

test("append preserves prior entries rather than replacing them", async () => {
  const { store, cleanup } = makeStore();
  try {
    await store.append(TENANT, PROJECT, DECISIONS_PATH, "## First");
    await store.append(TENANT, PROJECT, DECISIONS_PATH, "## Second");
    const log = await store.get(TENANT, PROJECT, DECISIONS_PATH);
    assert.match(log?.content ?? "", /## First[\s\S]*## Second/);
  } finally {
    cleanup();
  }
});

test("concurrent appends to one log all survive", async () => {
  const { store, cleanup } = makeStore();
  try {
    const path = `${SQUAD_STATE_ROOT}/history/squad-researcher.md`;
    const blocks = Array.from({ length: 25 }, (_, i) => `### Turn ${i}`);
    await Promise.all(blocks.map((block) => store.append(TENANT, PROJECT, path, block)));
    const log = await store.get(TENANT, PROJECT, path);
    for (const block of blocks) {
      assert.match(log?.content ?? "", new RegExp(`${block}$`, "m"), `${block} was lost`);
    }
  } finally {
    cleanup();
  }
});

test("a tenant never sees another tenant's tree", async () => {
  const { store, cleanup } = makeStore();
  try {
    const other = "22222222-2222-2222-2222-222222222222";
    await store.put(TENANT, PROJECT, ".copilot-tracking/plans/mine.md", "mine");
    assert.deepEqual(await store.list(other, PROJECT), []);
    assert.equal(await store.get(other, PROJECT, ".copilot-tracking/plans/mine.md"), undefined);
  } finally {
    cleanup();
  }
});

test("an oversized artifact is truncated rather than rejected", async () => {
  const { store, cleanup } = makeStore();
  try {
    const huge = "x".repeat(ARTIFACT_MAX_CHARS + 5_000);
    const written = await store.put(TENANT, PROJECT, ".copilot-tracking/plans/big.md", huge);
    assert.equal(written.ok, true);
    const read = await store.get(TENANT, PROJECT, ".copilot-tracking/plans/big.md");
    assert.ok((read?.content.length ?? 0) < huge.length);
    assert.match(read?.content ?? "", /truncated/);
  } finally {
    cleanup();
  }
});

test("seeding the product profile writes team, routing, and state", async () => {
  const { store, cleanup } = makeStore();
  try {
    const ledger = new SquadLedger(store);
    const product = resolveProfile("product", TABLES);
    const seeded = await ledger.seed(TENANT, PROJECT, product, TABLES, { date: "2026-08-07" });

    assert.equal(seeded.created, true);
    assert.equal(seeded.profile, "product");

    const team = await store.get(TENANT, PROJECT, TEAM_PATH);
    assert.match(team?.content ?? "", /\| analyst \|/);
    assert.match(team?.content ?? "", /\| intake-validator \|/);
    assert.match(team?.content ?? "", /Squad Researcher/);
    // The roster's deliverable roots land in the seeded rows.
    assert.match(team?.content ?? "", /\.copilot-tracking\/research\/2026-08-07/);

    const state = await ledger.readState(TENANT, PROJECT);
    assert.equal(state?.profile, "product");
    assert.equal(state?.schemaVersion, STATE_SCHEMA_VERSION);
    assert.equal(state?.turn, 0);
  } finally {
    cleanup();
  }
});

test("seeding is idempotent and an existing roster wins over a later profile argument", async () => {
  const { store, cleanup } = makeStore();
  try {
    const ledger = new SquadLedger(store);
    await ledger.seed(TENANT, PROJECT, resolveProfile("product", TABLES), TABLES);
    const second = await ledger.seed(TENANT, PROJECT, resolveProfile("security", TABLES), TABLES);

    assert.equal(second.created, false);
    assert.equal(second.profile, "product", "a later profile must not re-cast the squad");
    const state = await ledger.readState(TENANT, PROJECT);
    assert.equal(state?.profile, "product");
  } finally {
    cleanup();
  }
});

test("the ledger appends per-agent history and decisions without losing entries", async () => {
  const { store, cleanup } = makeStore();
  try {
    const ledger = new SquadLedger(store);
    await ledger.seed(TENANT, PROJECT, resolveProfile("product", TABLES), TABLES);

    await Promise.all([
      ledger.appendAgentHistory(TENANT, PROJECT, "Squad Researcher", "### Turn 1"),
      ledger.appendDecision(TENANT, PROJECT, "## Council Verdict — Go"),
      ledger.appendDecision(TENANT, PROJECT, "## Intake Readiness Verdict — Ready"),
    ]);

    const history = await store.get(TENANT, PROJECT, agentHistoryPath("Squad Researcher"));
    assert.match(history?.content ?? "", /### Turn 1/);

    const decisions = await store.get(TENANT, PROJECT, DECISIONS_PATH);
    assert.match(decisions?.content ?? "", /Council Verdict/);
    assert.match(decisions?.content ?? "", /Intake Readiness Verdict/);
  } finally {
    cleanup();
  }
});

test("updateState overwrites state.json while preserving untouched fields", async () => {
  const { store, cleanup } = makeStore();
  try {
    const ledger = new SquadLedger(store);
    await ledger.seed(TENANT, PROJECT, resolveProfile("product", TABLES), TABLES);
    await ledger.updateState(TENANT, PROJECT, {
      turn: 3,
      activeRoles: ["analyst"],
      currentRun: { id: "run-1" } as never,
    });
    const state = await ledger.readState(TENANT, PROJECT);
    assert.equal(state?.turn, 3);
    assert.deepEqual(state?.activeRoles, ["analyst"]);
    assert.equal(state?.currentRun.id, "run-1");
    assert.equal(state?.currentRun.estCostUsd, 0, "untouched run fields survive the patch");
    assert.equal(state?.profile, "product");
  } finally {
    cleanup();
  }
});

test("a deliverable lands in its role's own root, and a findings-only role writes none", async () => {
  const { store, cleanup } = makeStore();
  try {
    const ledger = new SquadLedger(store);
    const written = await ledger.writeDeliverable(
      TENANT,
      PROJECT,
      "lead",
      "Onboarding Plan",
      "# Plan",
      TABLES,
    );
    assert.equal(written, ".copilot-tracking/plans/onboarding-plan.md");
    assert.equal(
      await ledger.writeDeliverable(TENANT, PROJECT, "cost-manager", "estimate", "x", TABLES),
      undefined,
    );
  } finally {
    cleanup();
  }
});

test("a federation sub-squad's state and deliverables stay inside its own root", async () => {
  const { store, cleanup } = makeStore();
  try {
    const ledger = new SquadLedger(store);
    const path = await ledger.writeDeliverable(
      TENANT,
      PROJECT,
      "lead",
      "plan",
      "# Plan",
      TABLES,
      { squad: "product" },
    );
    assert.equal(path, ".copilot-tracking/squad/members/product/plans/plan.md");
  } finally {
    cleanup();
  }
});

test("rendered team markdown leaves Member Name empty for an unattended run", () => {
  const markdown = renderTeamMarkdown(resolveProfile("product", TABLES), TABLES);
  const rows = markdown.split("\n").filter((line) => line.startsWith("| ") && !line.includes("---"));
  const dataRows = rows.slice(1);
  assert.ok(dataRows.length > 0);
  for (const row of dataRows) {
    const memberName = row.split("|")[2].trim();
    assert.equal(memberName, "", `expected no invented alias, got ${memberName}`);
  }
});

test("initialState matches the documented state.json shape", () => {
  const state = initialState(resolveProfile("default", TABLES), { date: "2026-08-07" });
  assert.deepEqual(Object.keys(state).sort(), [
    "activeRoles",
    "currentRun",
    "mode",
    "notify",
    "openEscalations",
    "profile",
    "schemaVersion",
    "turn",
    "updated",
  ]);
  assert.equal(state.notify.approvalChannel, "in-chat");
  assert.equal(state.mode, "interactive");
  assert.ok(STATE_PATH.startsWith(SQUAD_STATE_ROOT));
});
