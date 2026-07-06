import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { loadPersonaForRole, loadPersonaForRosterRole } from "../src/engine/persona-loader.js";
import {
  resolvePersonaForRole,
  resolvePersonaForRosterRole,
  TASK_RESEARCHER_CHARTER,
} from "../src/engine/embedded-roles.js";

const REAL_BODY_MARKER = "REAL-PERSONA-BODY-MARKER: task researcher from disk.";
const NON_HERO_MARKER = "REAL-PERSONA-BODY-MARKER: system architecture reviewer from disk.";

/** Build a temp agents root containing a nested Task Researcher persona file. */
function makeCastFixture(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "squad-cast-"));
  // Nested subdir proves recursive scanning (mirrors squad-src/.github/agents/squad).
  const nested = join(root, "hve-core");
  mkdirSync(nested, { recursive: true });
  const persona = [
    "---",
    "name: Task Researcher",
    "applyTo:",
    "  - '**/*.ts'",
    "tools:",
    "  - Researcher Subagent",
    "---",
    "",
    REAL_BODY_MARKER,
    "",
    "You investigate and frame findings.",
    "",
  ].join("\n");
  writeFileSync(join(nested, "task-researcher.agent.md"), persona, "utf8");
  // A NON-hero persona (no paraphrase fallback record) proves the loader is
  // general across the full cast, not limited to the two hero roles.
  const architect = [
    "---",
    "name: System Architecture Reviewer",
    "---",
    "",
    NON_HERO_MARKER,
    "",
    "You review design tradeoffs.",
    "",
  ].join("\n");
  writeFileSync(join(nested, "system-architecture-reviewer.agent.md"), architect, "utf8");
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** An empty temp dir with no persona files (the "cast absent" case). */
function makeEmptyRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "squad-empty-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("loadPersonaForRole returns the real body + parsed frontmatter when present", () => {
  const { root, cleanup } = makeCastFixture();
  try {
    const record = loadPersonaForRole("Task Researcher", [root]);
    assert.ok(record, "a record is resolved for Task Researcher");
    assert.equal(record.role, "Task Researcher");
    assert.match(record.charter, /REAL-PERSONA-BODY-MARKER/);
    assert.notEqual(record.charter, TASK_RESEARCHER_CHARTER); // real bytes, not the paraphrase
    assert.deepEqual(record.applyTo, ["**/*.ts"]);
    assert.deepEqual(record.tools, ["Researcher Subagent"]);
  } finally {
    cleanup();
  }
});

test("loadPersonaForRole returns undefined when the cast is absent (no throw)", () => {
  const { root, cleanup } = makeEmptyRoot();
  try {
    assert.equal(loadPersonaForRole("Task Researcher", [root]), undefined);
  } finally {
    cleanup();
  }
});

test("loadPersonaForRole returns undefined for a role with no matching persona", () => {
  const { root, cleanup } = makeCastFixture();
  try {
    assert.equal(loadPersonaForRole("Nonexistent Role", [root]), undefined);
  } finally {
    cleanup();
  }
});

test("resolvePersonaForRole prefers real bytes when present", () => {
  const { root, cleanup } = makeCastFixture();
  try {
    const record = resolvePersonaForRole("Task Researcher", [root]);
    assert.ok(record);
    assert.match(record.charter, /REAL-PERSONA-BODY-MARKER/);
  } finally {
    cleanup();
  }
});

test("resolvePersonaForRole falls back to the paraphrase record when the cast is absent", () => {
  const { root, cleanup } = makeEmptyRoot();
  try {
    const record = resolvePersonaForRole("Task Researcher", [root]);
    assert.ok(record);
    assert.equal(record.charter, TASK_RESEARCHER_CHARTER);
    assert.deepEqual(record.applyTo, []);
  } finally {
    cleanup();
  }
});

test("loadPersonaForRole resolves a NON-hero agent from the cast by name", () => {
  const { root, cleanup } = makeCastFixture();
  try {
    const record = loadPersonaForRole("System Architecture Reviewer", [root]);
    assert.ok(record, "a record is resolved for the non-hero architect role");
    assert.equal(record.role, "System Architecture Reviewer");
    assert.match(record.charter, /system architecture reviewer from disk/);
  } finally {
    cleanup();
  }
});

test("resolvePersonaForRole returns real bytes for a NON-hero agent (no paraphrase)", () => {
  const { root, cleanup } = makeCastFixture();
  try {
    const record = resolvePersonaForRole("System Architecture Reviewer", [root]);
    assert.ok(record, "the non-hero persona resolves from disk");
    assert.match(record.charter, /system architecture reviewer from disk/);
  } finally {
    cleanup();
  }
});

test("resolvePersonaForRole returns undefined for an unknown role (no cast)", () => {
  const { root, cleanup } = makeEmptyRoot();
  try {
    assert.equal(resolvePersonaForRole("System Architecture Reviewer", [root]), undefined);
    assert.equal(resolvePersonaForRole("Totally Unknown Role", [root]), undefined);
  } finally {
    cleanup();
  }
});

test("loadPersonaForRosterRole maps a role KEY to an agent name then loads bytes", () => {
  const { root, cleanup } = makeCastFixture();
  const rosterMap = new Map<string, string>([
    ["architect", "System Architecture Reviewer"],
    ["researcher", "Task Researcher"],
  ]);
  try {
    const record = loadPersonaForRosterRole("architect", rosterMap, [root]);
    assert.ok(record, "the architect role key resolves via the roster map");
    assert.match(record.charter, /system architecture reviewer from disk/);
    // An unmapped role key returns undefined (never a silent wrong persona).
    assert.equal(loadPersonaForRosterRole("unmapped-key", rosterMap, [root]), undefined);
  } finally {
    cleanup();
  }
});

test("resolvePersonaForRosterRole maps a role KEY and keeps the hero fallback", () => {
  const { root: emptyRoot, cleanup } = makeEmptyRoot();
  const rosterMap = new Map<string, string>([
    ["architect", "System Architecture Reviewer"],
    ["researcher", "Task Researcher"],
  ]);
  try {
    // Cast absent: a non-hero role key resolves to undefined...
    assert.equal(resolvePersonaForRosterRole("architect", rosterMap, [emptyRoot]), undefined);
    // ...but a hero role key still resolves via the paraphrase fallback.
    const hero = resolvePersonaForRosterRole("researcher", rosterMap, [emptyRoot]);
    assert.ok(hero, "the hero role key resolves via the paraphrase fallback");
    assert.equal(hero.charter, TASK_RESEARCHER_CHARTER);
    // An unmapped role key returns undefined.
    assert.equal(resolvePersonaForRosterRole("unmapped-key", rosterMap, [emptyRoot]), undefined);
  } finally {
    cleanup();
  }
});
