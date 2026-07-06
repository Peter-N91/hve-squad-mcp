/**
 * Cast snapshot generator (build-time, reproducible).
 *
 * Copies the FULL deployed squad cast — every `*.agent.md` persona plus the
 * squad instruction files and the untrusted-content-boundary instruction — from
 * the authoritative in-repo sources into `host/cast/.github`, and writes a
 * SHA-pinned `host/cast/manifest.json` recording the source commit, the bundled
 * agent `name:` values, and the file count.
 *
 * The container `Containerfile` COPYs `host/cast/.github` to `/app/.github`, so
 * `resolveSquadAgentsRoots()` / `resolveSquadGithubRoot()` resolve REAL persona
 * bytes at runtime (the single-source invariant) instead of the paraphrased
 * hero fallback.
 *
 * This is a pure file copy + git-SHA read — no model, no network. It is the
 * scripted, drift-checkable replacement for the hand-copied 2-agent spike
 * snapshot. The companion drift test (`test/cast-bundle.test.ts`) fails when the
 * bundle is missing any roster Primary agent or the boundary instruction.
 *
 * Sources (READ-ONLY — the deployed cast + squad instructions are the single
 * source of truth; this script never edits them):
 *   - `<repo>/.github/agents/**` .......... the deployed HVE Core cast personas
 *   - `<repo>/squad-src/.github/agents/squad/**` ... the squad-owned personas
 *   - `<repo>/squad-src/.github/instructions/squad/*.instructions.md` ... squad instructions
 *   - `<repo>/.github/instructions/untrusted-content-boundary.instructions.md`
 *
 * Run: `npm run snapshot:cast` (from the `squad-mcp/` package root).
 *
 * DEFERRED (recorded in the changes log, not silently skipped): this bundles
 * personas + squad/boundary instructions only. Bundling the full referenced
 * SKILL file trees is deferred to the execution expansion to keep image size and
 * scope bounded; the loader's untrusted-content-boundary enforcement does not
 * depend on skill files being present.
 */
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const HOST_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = dirname(HOST_DIR);

/**
 * Resolve the hve-squad APM PACKAGE source root this MCP repo snapshots its cast
 * from. This server lives in its OWN repo (split from the monorepo), so the
 * package is a SEPARATE checkout. Resolution order:
 *   1. SQUAD_MCP_PACKAGE_ROOT env (explicit override; CI checkout or APM-dep path).
 *   2. A sibling `../hve-squad` next to this repo (the local-dev default).
 *   3. The legacy monorepo layout where the package IS the parent directory.
 * The chosen root must expose `apm.yml` + `squad-src` (and the deployed
 * `.github/agents` cast).
 */
function resolvePackageSourceRoot(): string {
  const override = (process.env.SQUAD_MCP_PACKAGE_ROOT ?? "").trim();
  const candidates =
    override.length > 0 ? [override] : [join(dirname(PACKAGE_ROOT), "hve-squad"), dirname(PACKAGE_ROOT)];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "apm.yml")) && existsSync(join(candidate, "squad-src"))) {
      return candidate;
    }
  }
  throw new Error(
    "Could not resolve the hve-squad package source root (needs apm.yml + squad-src). " +
      "Set SQUAD_MCP_PACKAGE_ROOT to the package checkout.",
  );
}

const PACKAGE_SOURCE_ROOT = resolvePackageSourceRoot();
const PACKAGE_PIN_PATH = join(HOST_DIR, "cast", "package-pin.json");

const CAST_ROOT = join(HOST_DIR, "cast", ".github");
const CAST_AGENTS = join(CAST_ROOT, "agents");
const CAST_INSTRUCTIONS = join(CAST_ROOT, "instructions");

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Source roots, resolved read-only from the pinned hve-squad package checkout. */
const SOURCES = {
  deployedAgents: join(PACKAGE_SOURCE_ROOT, ".github", "agents"),
  squadAgents: join(PACKAGE_SOURCE_ROOT, "squad-src", ".github", "agents", "squad"),
  squadInstructions: join(PACKAGE_SOURCE_ROOT, "squad-src", ".github", "instructions", "squad"),
  boundaryInstruction: join(
    PACKAGE_SOURCE_ROOT,
    ".github",
    "instructions",
    "untrusted-content-boundary.instructions.md",
  ),
} as const;

function assertExists(path: string, label: string): void {
  if (!existsSync(path)) {
    throw new Error(`Snapshot source missing: ${label} (${path}).`);
  }
}

/** Read the `name:` frontmatter value from an agent persona file, if present. */
function agentName(file: string): string | undefined {
  const match = readFileSync(file, "utf8").match(FRONTMATTER);
  if (!match) {
    return undefined;
  }
  try {
    const fm = (parseYaml(match[1]) ?? {}) as Record<string, unknown>;
    return typeof fm.name === "string" ? fm.name.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** Recursively collect files under `dir` matching `suffix`. */
function collectFiles(dir: string, suffix: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectFiles(full, suffix, acc);
    } else if (entry.endsWith(suffix)) {
      acc.push(full);
    }
  }
  return acc;
}

/** The package repo's HEAD commit (the SOURCE being snapshotted, not this repo). */
function pinnedSha(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: PACKAGE_SOURCE_ROOT })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

/** The `version:` field from the package's apm.yml (the linked package version). */
function packageVersion(): string {
  const apm = readFileSync(join(PACKAGE_SOURCE_ROOT, "apm.yml"), "utf8");
  const match = apm.match(/^version:\s*(.+)$/m);
  return match ? match[1].trim() : "unknown";
}

/** The package + version this MCP release is PINNED to (host/cast/package-pin.json). */
function pinnedPackage(): { package: string; version: string } {
  const pin = JSON.parse(readFileSync(PACKAGE_PIN_PATH, "utf8")) as { package: string; version: string };
  return { package: pin.package, version: pin.version };
}

function main(): void {
  for (const [label, path] of Object.entries(SOURCES)) {
    assertExists(path, label);
  }

  // Enforce the version LINK: the package we snapshot MUST match the pin recorded
  // for this MCP release, so a drifted cast can never ship silently. Bump the pin
  // (and the MCP version) together for a related change.
  const pin = pinnedPackage();
  const resolvedVersion = packageVersion();
  if (resolvedVersion !== pin.version) {
    throw new Error(
      `Package version mismatch: host/cast/package-pin.json pins ${pin.package}@${pin.version} ` +
        `but the resolved package is ${resolvedVersion} (${PACKAGE_SOURCE_ROOT}). ` +
        "Bump the pin (and the MCP version) or point at the pinned package.",
    );
  }

  // Clean the generated bundle subtrees so removed agents do not linger.
  rmSync(CAST_AGENTS, { recursive: true, force: true });
  rmSync(CAST_INSTRUCTIONS, { recursive: true, force: true });
  mkdirSync(CAST_AGENTS, { recursive: true });
  mkdirSync(join(CAST_INSTRUCTIONS, "squad"), { recursive: true });

  const filterAgents = (src: string): boolean =>
    statSync(src).isDirectory() || src.endsWith(".agent.md");
  const filterInstructions = (src: string): boolean =>
    statSync(src).isDirectory() || src.endsWith(".instructions.md");

  // 1) Deployed HVE Core cast personas (preserve subtree structure).
  cpSync(SOURCES.deployedAgents, CAST_AGENTS, { recursive: true, filter: filterAgents });
  // 2) Squad-owned personas under agents/squad/.
  cpSync(SOURCES.squadAgents, join(CAST_AGENTS, "squad"), {
    recursive: true,
    filter: filterAgents,
  });
  // 3) Squad instruction files (includes the squad-routing probe file).
  cpSync(SOURCES.squadInstructions, join(CAST_INSTRUCTIONS, "squad"), {
    recursive: true,
    filter: filterInstructions,
  });
  // 4) The untrusted-content-boundary instruction (G6 / VF-07 enforcement).
  cpSync(SOURCES.boundaryInstruction, join(CAST_INSTRUCTIONS, "untrusted-content-boundary.instructions.md"));

  const bundledAgentFiles = collectFiles(CAST_AGENTS, ".agent.md");
  const names = bundledAgentFiles
    .map(agentName)
    .filter((n): n is string => Boolean(n))
    .sort((a, b) => a.localeCompare(b));

  const manifest = {
    generatedBy: "host/snapshot-cast.ts",
    sourcePackage: pin.package,
    linkedPackageVersion: pin.version,
    sourceCommit: pinnedSha(),
    generatedAt: new Date().toISOString().slice(0, 10),
    agentFileCount: bundledAgentFiles.length,
    agentNames: names,
    instructions: [
      ...collectFiles(join(CAST_INSTRUCTIONS, "squad"), ".instructions.md").map((f) =>
        relative(CAST_ROOT, f).replace(/\\/g, "/"),
      ),
      "instructions/untrusted-content-boundary.instructions.md",
    ].sort((a, b) => a.localeCompare(b)),
    note: "Skill file trees are DEFERRED to the execution expansion; personas + squad/boundary instructions only.",
  };

  writeFileSync(
    join(HOST_DIR, "cast", "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  process.stdout.write(
    `Snapshot: ${manifest.agentFileCount} agent files, ${names.length} named personas, ` +
      `${manifest.instructions.length} instruction files; ` +
      `linked ${pin.package}@${pin.version}; pinned commit ${manifest.sourceCommit}.\n`,
  );
}

main();
