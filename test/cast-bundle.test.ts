import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";

/**
 * Cast-bundle drift check.
 *
 * The host image ships a SHA-pinned snapshot of the full deployed cast
 * (`host/cast/.github`, produced by `npm run snapshot:cast`). This suite FAILS
 * when that bundle drifts from the read-only single source of truth:
 *   1. any roster Cast Catalog Primary agent is missing from the bundle, or
 *   2. the untrusted-content-boundary instruction is absent from the bundle.
 *
 * The roster is parsed READ-ONLY; this test never mutates the deployed sources.
 */

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = dirname(TEST_DIR);
const REPO_ROOT = dirname(PACKAGE_ROOT);

const BUNDLE_ROOT = join(PACKAGE_ROOT, "host", "cast", ".github");
const BUNDLE_AGENTS = join(BUNDLE_ROOT, "agents");
const BUNDLE_BOUNDARY = join(
  BUNDLE_ROOT,
  "instructions",
  "untrusted-content-boundary.instructions.md",
);

/**
 * The authoritative roster. This server lives in its OWN repo (split from the
 * monorepo), so the hve-squad package is a SEPARATE checkout. Resolve it from
 * SQUAD_MCP_PACKAGE_ROOT or a sibling `../hve-squad` (mirroring
 * host/snapshot-cast.ts). When the package source is not available (e.g. CI
 * without the package checkout), fall back to the BUNDLED roster so this drift
 * check degrades to bundle self-consistency instead of failing on a missing file.
 */
function resolveRosterFile(): string {
  const rel = join("squad-src", ".github", "instructions", "squad", "squad-roster.instructions.md");
  const override = (process.env.SQUAD_MCP_PACKAGE_ROOT ?? "").trim();
  const candidates = override.length > 0 ? [override] : [join(dirname(PACKAGE_ROOT), "hve-squad"), REPO_ROOT];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, rel))) {
      return join(candidate, rel);
    }
  }
  return join(BUNDLE_ROOT, "instructions", "squad", "squad-roster.instructions.md");
}

const ROSTER_FILE = resolveRosterFile();

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function collectAgentFiles(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) {
    return acc;
  }
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectAgentFiles(full, acc);
    } else if (entry.endsWith(".agent.md")) {
      acc.push(full);
    }
  }
  return acc;
}

function bundledAgentNames(): Set<string> {
  const names = new Set<string>();
  for (const file of collectAgentFiles(BUNDLE_AGENTS)) {
    const match = readFileSync(file, "utf8").match(FRONTMATTER);
    if (!match) {
      continue;
    }
    try {
      const fm = (parseYaml(match[1]) ?? {}) as Record<string, unknown>;
      if (typeof fm.name === "string" && fm.name.trim().length > 0) {
        names.add(fm.name.trim());
      }
    } catch {
      // A malformed persona simply does not contribute a name.
    }
  }
  return names;
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

const isTableLine = (line: string): boolean => /^\s*\|.*\|\s*$/.test(line);
const isSeparator = (line: string): boolean =>
  /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes("-");

/**
 * Read the Cast Catalog Primary agent names from the roster. Targets ONLY the
 * table whose header contains "Primary Agent" and stops at that table's end, so
 * the Profiles / Members-schema tables are never mistaken for cast rows.
 */
function rosterPrimaryAgents(): string[] {
  const lines = readFileSync(ROSTER_FILE, "utf8").split(/\r?\n/);
  const primaries: string[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*```/.test(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !isTableLine(lines[i]) || i + 1 >= lines.length || !isSeparator(lines[i + 1])) {
      continue;
    }
    const headers = splitRow(lines[i]);
    const primaryIdx = headers.findIndex((h) => /Primary Agent/i.test(h));
    if (primaryIdx < 0) {
      continue; // not the Cast Catalog table
    }
    for (let j = i + 2; j < lines.length && isTableLine(lines[j]); j += 1) {
      const cells = splitRow(lines[j]);
      const value = (cells[primaryIdx] ?? "").replace(/`/g, "").trim();
      if (value && value !== "—") {
        primaries.push(value);
      }
    }
    break; // only one Cast Catalog table
  }
  return [...new Set(primaries)];
}

test("cast bundle contains every roster Cast Catalog Primary agent", () => {
  const bundled = bundledAgentNames();
  assert.ok(bundled.size > 0, "the bundle resolved at least one named persona");
  const primaries = rosterPrimaryAgents();
  assert.ok(primaries.length > 0, "the roster yielded Cast Catalog Primary agents");
  const missing = primaries.filter((name) => !bundled.has(name));
  assert.deepEqual(
    missing,
    [],
    `bundle is stale — missing roster Primary agent(s): ${missing.join(", ")}. ` +
      "Re-run `npm run snapshot:cast`.",
  );
});

test("cast bundle carries the untrusted-content-boundary instruction", () => {
  assert.ok(
    existsSync(BUNDLE_BOUNDARY),
    "untrusted-content-boundary.instructions.md must be present in the bundle " +
      "(re-run `npm run snapshot:cast`).",
  );
});
