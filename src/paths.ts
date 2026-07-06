/**
 * Path resolution helpers for the squad-mcp server and generator.
 *
 * The server and generator must locate two roots at runtime:
 *   1. the package root (where `tools.catalog.yml` and `generated/` live);
 *   2. the squad `.github` root (where the read-only routing/roster
 *      instructions and the `*.agent.md` personas live).
 *
 * Both are resolved by walking the filesystem so the same code works whether it
 * runs from TypeScript source (`tsx`) or compiled output (`dist/`), and whether
 * the squad sources sit under `squad-src/.github` (this authoring repo) or
 * `.github` (a deployed consumer).
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CATALOG_FILE = "tools.catalog.yml";

/**
 * Walk up from this module's directory until a directory containing
 * `tools.catalog.yml` is found. That directory is the package root.
 */
export function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  // Bound the walk so a misconfigured environment fails fast instead of looping.
  for (let i = 0; i < 12; i += 1) {
    if (existsSync(join(dir, CATALOG_FILE))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new Error(
    `Could not locate ${CATALOG_FILE} by walking up from ${fileURLToPath(import.meta.url)}.`,
  );
}

/** Absolute path to the authored tool catalog. */
export function catalogPath(): string {
  return join(packageRoot(), CATALOG_FILE);
}

/** Absolute path to the generated runtime descriptor. */
export function generatedSchemaPath(): string {
  return join(packageRoot(), "generated", "mcp-tools.schema.json");
}

/**
 * Resolve the squad `.github` root holding the read-only routing/roster
 * instructions and agent personas. Tries the authoring-repo layout
 * (`<repo>/squad-src/.github`) first, then the deployed-consumer layout
 * (`<repo>/.github`), where `<repo>` is the package root's parent.
 *
 * Returns `undefined` when neither candidate exists (the generator treats this
 * as a hard error; the delegated engine treats it as "fall back to the
 * embedded persona constants").
 */
export function resolveSquadGithubRoot(fromPackageRoot = packageRoot()): string | undefined {
  const repoRoot = dirname(fromPackageRoot);
  const probe = join(
    "instructions",
    "squad",
    "squad-routing.instructions.md",
  );
  const candidates = [
    join(repoRoot, "squad-src", ".github"),
    join(repoRoot, ".github"),
    // Also allow the package root itself to host a `.github` (defensive).
    join(fromPackageRoot, ".github"),
    // The committed cast snapshot bundled in this standalone repo (and COPYed to
    // /app/.github in the container). Lets local dev/test/generate resolve the
    // routing/roster instructions from the bundle without a squad-src checkout.
    join(fromPackageRoot, "host", "cast", ".github"),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, probe))) {
      return resolve(candidate);
    }
  }
  return undefined;
}

/**
 * Resolve the candidate `agents/` directories that may hold the `*.agent.md`
 * personas, in priority order, filtered to those that exist.
 *
 * Unlike {@link resolveSquadGithubRoot} (which keys off the routing-probe file),
 * this returns EVERY existing candidate because the two layouts differ in what
 * they contain: the authoring repo's `squad-src/.github/agents` holds only the
 * squad subfolder, while the deployed FLAT cast at `.github/agents` holds the
 * hero personas (Task Researcher / Task Reviewer). The from-disk persona loader
 * scans all candidates so it resolves real persona bytes in either layout and in
 * the bundled container path (`<packageRoot>/.github/agents`).
 */
export function resolveSquadAgentsRoots(fromPackageRoot = packageRoot()): string[] {
  const repoRoot = dirname(fromPackageRoot);
  const candidates = [
    join(repoRoot, "squad-src", ".github", "agents"),
    join(repoRoot, ".github", "agents"),
    join(fromPackageRoot, ".github", "agents"),
    // The committed cast snapshot bundled in this standalone repo (and COPYed to
    // /app/.github/agents in the container).
    join(fromPackageRoot, "host", "cast", ".github", "agents"),
  ];
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const candidate of candidates) {
    const abs = resolve(candidate);
    if (!seen.has(abs) && existsSync(abs)) {
      seen.add(abs);
      roots.push(abs);
    }
  }
  return roots;
}
