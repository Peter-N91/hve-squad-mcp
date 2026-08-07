import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";

import { sha256 } from "../host/snapshot-cast.js";
import { loadCatalog } from "../src/catalog/catalog.js";
import { resolvePersonaForRole } from "../src/engine/embedded-roles.js";
import { loadPersonaForRole } from "../src/engine/persona-loader.js";

/**
 * Cast-bundle drift check.
 *
 * The host image ships a pinned snapshot of the deployed cast
 * (`host/cast/.github`, produced by `npm run snapshot:cast`). This suite FAILS
 * when that bundle drifts from the read-only single source of truth:
 *   1. any bundled file's content differs from the hash `manifest.json` records,
 *   2. the bundle carries a file the manifest does not, or vice versa,
 *   3. the manifest is linked to a different package version than the pin,
 *   4. any roster Cast Catalog Primary agent is missing from the bundle, or
 *   5. the untrusted-content-boundary instruction is absent from the bundle.
 *
 * Checks 1-3 are the OFFLINE half of the integrity contract and need no network:
 * they catch a hand-edited persona, a partially committed snapshot, and a pin
 * moved without re-running the snapshot. The ONLINE half — whether the manifest
 * still matches what the pinned tag actually resolves to — is
 * `npm run snapshot:cast:check`.
 *
 * The roster is parsed READ-ONLY; this test never mutates the deployed sources.
 */

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = dirname(TEST_DIR);

const CAST_DIR = join(PACKAGE_ROOT, "host", "cast");
const BUNDLE_ROOT = join(CAST_DIR, ".github");
const BUNDLE_AGENTS = join(BUNDLE_ROOT, "agents");
const MANIFEST_FILE = join(CAST_DIR, "manifest.json");
const PIN_FILE = join(CAST_DIR, "package-pin.json");
const BUNDLE_BOUNDARY = join(
  BUNDLE_ROOT,
  "instructions",
  "untrusted-content-boundary.instructions.md",
);

interface CastManifest {
  linkedPackageVersion: string;
  sourcePackage: string;
  agentFileCount: number;
  instructionFileCount: number;
  duplicateAgentNames: string[];
  files: { path: string; sha256: string; source: string }[];
}

function readManifest(): CastManifest {
  assert.ok(existsSync(MANIFEST_FILE), "host/cast/manifest.json must exist (run `npm run snapshot:cast`).");
  return JSON.parse(readFileSync(MANIFEST_FILE, "utf8")) as CastManifest;
}

/** Every file in the bundle tree, bundle-relative with POSIX separators. */
function bundledPaths(dir = BUNDLE_ROOT, acc: string[] = []): string[] {
  if (!existsSync(dir)) {
    return acc;
  }
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      bundledPaths(full, acc);
    } else {
      acc.push(relative(BUNDLE_ROOT, full).replace(/\\/g, "/"));
    }
  }
  return acc;
}

/**
 * The roster the bundle SHIPS. Deliberately not a sibling package checkout: the
 * bundle is the artifact the image runs on, so validating it against a roster
 * that is not in it means a developer with a checkout and a runner without one
 * assert different things — and the runner's answer is the one that matters.
 * `npm run snapshot:cast:check` is what confirms this roster is the pinned one.
 */
const ROSTER_FILE = join(BUNDLE_ROOT, "instructions", "squad", "squad-roster.instructions.md");

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
function rosterPrimaryAgents(): { role: string; primary: string }[] {
  const lines = readFileSync(ROSTER_FILE, "utf8").split(/\r?\n/);
  const primaries: { role: string; primary: string }[] = [];
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
    const roleIdx = headers.findIndex((h) => /^Role$/i.test(h));
    for (let j = i + 2; j < lines.length && isTableLine(lines[j]); j += 1) {
      const cells = splitRow(lines[j]);
      const value = (cells[primaryIdx] ?? "").replace(/`/g, "").trim();
      if (value && value !== "—") {
        primaries.push({
          role: roleIdx < 0 ? "" : (cells[roleIdx] ?? "").replace(/`/g, "").trim(),
          primary: value,
        });
      }
    }
    break; // only one Cast Catalog table
  }
  return primaries;
}

/** Compare an agent display name and an upstream resource id on equal terms. */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Agents the roster registers as `opt-in` in its External Cast, keyed both by
 * resource id and by the role that registered them.
 *
 * An opt-in agent ships from a marketplace the consumer installs themselves, so
 * `apm.yml` never carries it and the bundle cannot contain it. Asserting on those
 * rows would fail the drift check for a roster that is in fact correct. The role
 * key is needed because a Primary is a display name (`QA`) while the row records
 * the upstream resource id (`qa-subagent`).
 */
function optInExternalAgents(): { resources: Set<string>; roles: Set<string> } {
  const lines = readFileSync(ROSTER_FILE, "utf8").split(/\r?\n/);
  const resources = new Set<string>();
  const roles = new Set<string>();
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
    const tierIdx = headers.findIndex((h) => /^Tier$/i.test(h));
    const resourceIdx = headers.findIndex((h) => /^Resource$/i.test(h));
    const kindIdx = headers.findIndex((h) => /Resource Kind/i.test(h));
    const roleIdx = headers.findIndex((h) => /^Role$/i.test(h));
    if (tierIdx < 0 || resourceIdx < 0 || kindIdx < 0 || roleIdx < 0) {
      continue; // not the Registered External Cast table
    }
    for (let j = i + 2; j < lines.length && isTableLine(lines[j]); j += 1) {
      const cells = splitRow(lines[j]);
      const tier = (cells[tierIdx] ?? "").replace(/`/g, "").trim().toLowerCase();
      const kind = (cells[kindIdx] ?? "").replace(/`/g, "").trim().toLowerCase();
      const resource = (cells[resourceIdx] ?? "").replace(/`/g, "").trim();
      const role = (cells[roleIdx] ?? "").replace(/`/g, "").trim();
      if (tier === "opt-in" && kind === "agent" && resource) {
        resources.add(slugify(resource));
        if (role) {
          roles.add(role);
        }
      }
    }
  }
  return { resources, roles };
}

test("cast bundle contains every bundled roster Cast Catalog Primary agent", () => {
  const bundled = bundledAgentNames();
  assert.ok(bundled.size > 0, "the bundle resolved at least one named persona");
  const optIn = optInExternalAgents();
  assert.ok(optIn.resources.size > 0, "the roster registered at least one opt-in external agent");
  const primaries = rosterPrimaryAgents();
  assert.ok(primaries.length > 0, "the roster yielded Cast Catalog Primary agents");
  const missing = [
    ...new Set(
      primaries
        .filter(
          ({ role, primary }) =>
            !bundled.has(primary) &&
            !optIn.resources.has(slugify(primary)) &&
            !optIn.roles.has(role),
        )
        .map(({ primary }) => primary),
    ),
  ];
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

test("every bundled file hashes to what the manifest records", () => {
  const manifest = readManifest();
  assert.ok(manifest.files.length > 0, "the manifest records at least one file");
  const mismatched: string[] = [];
  for (const entry of manifest.files) {
    const target = join(BUNDLE_ROOT, entry.path);
    if (!existsSync(target)) {
      mismatched.push(`${entry.path} (missing)`);
      continue;
    }
    if (sha256(readFileSync(target, "utf8")) !== entry.sha256) {
      mismatched.push(`${entry.path} (content differs)`);
    }
  }
  assert.deepEqual(
    mismatched,
    [],
    "bundled bytes disagree with host/cast/manifest.json — the bundle was edited by hand " +
      "or committed partially. Re-run `npm run snapshot:cast`.",
  );
});

test("the bundle carries no file the manifest does not record", () => {
  const manifest = readManifest();
  const recorded = new Set(manifest.files.map((entry) => entry.path));
  const untracked = bundledPaths().filter((path) => !recorded.has(path));
  assert.deepEqual(
    untracked,
    [],
    "files present in the bundle but absent from host/cast/manifest.json. Re-run `npm run snapshot:cast`.",
  );
});

test("the manifest counts agree with the recorded files", () => {
  const manifest = readManifest();
  const agents = manifest.files.filter((entry) => entry.path.startsWith("agents/"));
  assert.equal(manifest.agentFileCount, agents.length);
  assert.equal(manifest.instructionFileCount, manifest.files.length - agents.length);
});

test("the bundled manifest is linked to the pinned package version", () => {
  const manifest = readManifest();
  const pin = JSON.parse(readFileSync(PIN_FILE, "utf8")) as { package: string; version: string };
  assert.equal(
    manifest.linkedPackageVersion,
    pin.version,
    "host/cast/package-pin.json moved without re-running `npm run snapshot:cast` — " +
      "the shipped cast is not the cast the pin claims.",
  );
  assert.equal(manifest.sourcePackage, pin.package);
});

test("no roster Primary agent is ambiguous in the bundle", () => {
  const manifest = readManifest();
  const primaries = new Set(rosterPrimaryAgents().map(({ primary }) => primary));
  const ambiguous = manifest.duplicateAgentNames.filter((name) => primaries.has(name));
  assert.deepEqual(
    ambiguous,
    [],
    "two bundled personas claim the same `name:` for a role the roster dispatches, so " +
      "which one loads depends on directory-walk order.",
  );
});

/**
 * The paraphrase fallback in `embedded-roles.ts` exists for a minimal image with no
 * cast on disk. In a correctly built repo it must never be what a dispatchable role
 * resolves to — a missing persona would otherwise degrade silently into a summary of
 * an agent instead of the agent, which is exactly how a retired role stayed invisible.
 */
test("every catalog role and council member resolves to REAL bundle bytes", () => {
  const catalog = loadCatalog();
  const roles = new Set<string>();
  for (const tool of catalog.tools) {
    roles.add(tool.role);
    for (const member of tool.council) {
      roles.add(member);
    }
  }

  const unresolved: string[] = [];
  const paraphrased: string[] = [];
  for (const role of [...roles].sort((a, b) => a.localeCompare(b))) {
    const fromDisk = loadPersonaForRole(role);
    if (!fromDisk) {
      // A resolved record with no on-disk source is the paraphrase fallback.
      (resolvePersonaForRole(role) ? paraphrased : unresolved).push(role);
    }
  }

  assert.deepEqual(unresolved, [], "catalog role(s) with no persona anywhere — the bundle is incomplete.");
  assert.deepEqual(
    paraphrased,
    [],
    "catalog role(s) served by the embedded paraphrase instead of real bundle bytes. " +
      "Re-run `npm run snapshot:cast`, or repoint the role in tools.catalog.yml.",
  );
});
