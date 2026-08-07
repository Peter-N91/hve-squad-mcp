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
    // The committed cast snapshot FIRST: it is the artifact this server ships and
    // the one `snapshot:cast --check` verifies. Anything installed into this repo
    // later (an `apm install` for a headless squad run, say) must not shadow it,
    // or tests and the generator would validate the install instead of the bundle.
    // It is absent in the container, where the bundle is COPYed to /app/.github and
    // the package-root candidate below resolves it.
    join(fromPackageRoot, "host", "cast", ".github"),
    join(repoRoot, "squad-src", ".github"),
    join(repoRoot, ".github"),
    // Also allow the package root itself to host a `.github` (the container layout).
    join(fromPackageRoot, ".github"),
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
 * this returns EVERY existing candidate because the layouts differ in what they
 * contain. The persona loader scans them in order and takes the first `name:`
 * match, so ORDER IS PRECEDENCE: the committed bundle comes first for the same
 * reason as above — it is what ships, and nothing installed into this repo later
 * should silently take its place.
 */
export function resolveSquadAgentsRoots(fromPackageRoot = packageRoot()): string[] {
  const repoRoot = dirname(fromPackageRoot);
  const candidates = [
    join(fromPackageRoot, "host", "cast", ".github", "agents"),
    join(repoRoot, "squad-src", ".github", "agents"),
    join(repoRoot, ".github", "agents"),
    // The container layout: the bundle is COPYed to /app/.github/agents.
    join(fromPackageRoot, ".github", "agents"),
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
