/**
 * Set this server's release version in every place that carries it, in one step.
 *
 * The version lives in three files, and they drifted apart precisely because a
 * workflow moved two of them: `bump-on-package-release.yml` advances
 * `package.json` and `package-lock.json` but not `SERVER_VERSION`, which is what a
 * host reports as `serverInfo.version`. It sat two releases behind with its own
 * guard test red and nothing running it.
 *
 * `SERVER_VERSION` cannot simply read `package.json` at runtime: the container
 * ships `dist/`, `tools.catalog.yml`, `generated/`, and the cast bundle, with no
 * `package.json` beside them, so the read would resolve differently in the image
 * than in development. A constant plus one writer is the honest guarantee.
 *
 *   npm run version:set -- 0.3.1
 *   npm run version:set -- patch|minor|major
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = dirname(SCRIPT_DIR);

const PACKAGE_JSON = join(PACKAGE_ROOT, "package.json");
const PACKAGE_LOCK = join(PACKAGE_ROOT, "package-lock.json");
const SERVER_TS = join(PACKAGE_ROOT, "src", "server.ts");

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SERVER_VERSION_LINE = /^(export const SERVER_VERSION = ")([^"]*)(";)$/m;

type Bump = "major" | "minor" | "patch";

function currentVersion(): string {
  return (JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as { version: string }).version;
}

export function nextVersion(current: string, bump: Bump): string {
  const [major, minor, patch] = current.split(".").map((part) => Number.parseInt(part, 10));
  if ([major, minor, patch].some((part) => Number.isNaN(part))) {
    throw new Error(`Cannot bump a non-semver current version: "${current}".`);
  }
  if (bump === "major") {
    return `${major + 1}.0.0`;
  }
  return bump === "minor" ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
}

/** Resolve the CLI argument to a concrete version. */
export function resolveTarget(arg: string, current: string): string {
  if (arg === "major" || arg === "minor" || arg === "patch") {
    return nextVersion(current, arg);
  }
  const version = arg.replace(/^v/, "");
  if (!SEMVER.test(version)) {
    throw new Error(`Not a semver version or bump keyword: "${arg}".`);
  }
  return version;
}

function setJsonVersion(path: string, version: string, alsoRootPackage = false): void {
  const raw = readFileSync(path, "utf8");
  const doc = JSON.parse(raw) as { version: string; packages?: Record<string, { version?: string }> };
  doc.version = version;
  if (alsoRootPackage && doc.packages?.[""]) {
    doc.packages[""].version = version;
  }
  const trailingNewline = raw.endsWith("\n") ? "\n" : "";
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}${trailingNewline}`, "utf8");
}

function setServerVersion(version: string): void {
  const source = readFileSync(SERVER_TS, "utf8");
  if (!SERVER_VERSION_LINE.test(source)) {
    throw new Error(`Could not find the SERVER_VERSION declaration in ${SERVER_TS}.`);
  }
  writeFileSync(SERVER_TS, source.replace(SERVER_VERSION_LINE, `$1${version}$3`), "utf8");
}

export function runCli(argv: string[]): number {
  const arg = argv[0];
  if (!arg) {
    process.stderr.write("Usage: npm run version:set -- <version|major|minor|patch>\n");
    return 1;
  }

  const current = currentVersion();
  let target: string;
  try {
    target = resolveTarget(arg, current);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  setJsonVersion(PACKAGE_JSON, target);
  setJsonVersion(PACKAGE_LOCK, target, true);
  setServerVersion(target);

  process.stdout.write(
    `Version ${current} -> ${target} in package.json, package-lock.json, and src/server.ts.\n` +
      "Add a CHANGELOG entry for this version before releasing.\n",
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(runCli(process.argv.slice(2)));
}
