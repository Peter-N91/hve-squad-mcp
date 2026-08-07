/**
 * Assemble pending change fragments into a CHANGELOG section and bump the version.
 *
 * The version and the changelog move ONLY here, only on `main`. A pull request
 * that edited either would conflict with every other open pull request, which is
 * why `.changes/unreleased/` exists and why PR validation rejects a diff that
 * touches `CHANGELOG.md` or `package.json`'s `version`.
 *
 * TypeScript rather than PowerShell (hve-squad's shape): the version already has
 * to move through `scripts/set-version.ts` to keep `package.json`,
 * `package-lock.json`, and `SERVER_VERSION` in step, `tsx` is already a
 * devDependency, and a second runtime in CI buys nothing. The fragment format is
 * byte-compatible with hve-squad's so the two repos read the same.
 *
 *   npm run release:prep -- --dry-run     # print the section, write nothing
 *   npm run release:prep                  # write CHANGELOG + version, delete fragments
 *   npm run release:prep -- --bump minor  # override the resolved level
 *   npm run release:prep -- --version 1.0.0
 */
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { nextVersion, resolveTarget } from "./set-version.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(SCRIPT_DIR);
const FRAGMENT_DIR = join(REPO_ROOT, ".changes", "unreleased");
const CHANGELOG = join(REPO_ROOT, "CHANGELOG.md");
const PACKAGE_JSON = join(REPO_ROOT, "package.json");

const REPO_SLUG = "Peter-N91/hve-squad-mcp";

/** Keep a Changelog sections, in the order they are rendered. */
export const SECTION_ORDER = [
  "Added",
  "Changed",
  "Deprecated",
  "Removed",
  "Fixed",
  "Security",
] as const;

export type Section = (typeof SECTION_ORDER)[number];
export type Bump = "major" | "minor" | "patch";

const BUMP_RANK: Record<Bump, number> = { patch: 0, minor: 1, major: 2 };

export interface Fragment {
  file: string;
  bump: Bump;
  type: Section;
  body: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * Parse one fragment.
 *
 * Every field is validated rather than defaulted. A fragment with a typo'd
 * `type` would otherwise land its bullets in a section nobody reads, and a
 * typo'd `bump` would silently release a patch when a consumer needed to know
 * their integration changed.
 */
export function parseFragment(file: string, raw: string): Fragment {
  const match = raw.match(FRONTMATTER);
  if (!match) {
    throw new Error(`${file}: missing the --- frontmatter block.`);
  }
  const fields = new Map<string, string>();
  for (const line of match[1].split(/\r?\n/)) {
    const pair = line.match(/^([A-Za-z]+)\s*:\s*(.+?)\s*$/);
    if (pair) {
      fields.set(pair[1].toLowerCase(), pair[2].replace(/^["']|["']$/g, ""));
    }
  }
  const bump = fields.get("bump")?.toLowerCase();
  if (bump !== "major" && bump !== "minor" && bump !== "patch") {
    throw new Error(`${file}: bump must be major, minor, or patch (got ${bump ?? "nothing"}).`);
  }
  const typeRaw = fields.get("type") ?? "";
  const type = SECTION_ORDER.find((s) => s.toLowerCase() === typeRaw.toLowerCase());
  if (!type) {
    throw new Error(`${file}: type must be one of ${SECTION_ORDER.join(", ")} (got ${typeRaw}).`);
  }
  const body = match[2].trim();
  if (body.length === 0) {
    throw new Error(`${file}: the body is empty.`);
  }
  if (!body.startsWith("-")) {
    throw new Error(`${file}: the body must be markdown bullets starting with "- ".`);
  }
  return { file, bump, type, body };
}

/** Read every pending fragment, sorted by filename so output is deterministic. */
export function readFragments(dir = FRAGMENT_DIR): Fragment[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".md") && name.toLowerCase() !== "readme.md")
    .sort()
    .map((name) => parseFragment(name, readFileSync(join(dir, name), "utf8")));
}

/** The highest bump requested across the pending fragments. */
export function resolveBump(fragments: Fragment[]): Bump {
  return fragments.reduce<Bump>(
    (highest, f) => (BUMP_RANK[f.bump] > BUMP_RANK[highest] ? f.bump : highest),
    "patch",
  );
}

/** Render the CHANGELOG section for a version from its fragments. */
export function renderSection(
  version: string,
  date: string,
  fragments: Fragment[],
  castPin?: { pkg: string; version: string },
): string {
  const lines = [`## [${version}] - ${date}`, ""];
  if (castPin) {
    lines.push(`> Built against \`${castPin.pkg}@${castPin.version}\` (see \`host/cast/package-pin.json\`).`, "");
  }
  for (const section of SECTION_ORDER) {
    const inSection = fragments.filter((f) => f.type === section);
    if (inSection.length === 0) {
      continue;
    }
    lines.push(`### ${section}`, "");
    for (const fragment of inSection) {
      lines.push(fragment.body, "");
    }
  }
  lines.push(
    "### Consumer install",
    "",
    "Pin to this version:",
    "",
    "```powershell",
    `npm install "${REPO_SLUG}#v${version}"`,
    "```",
    "",
    `[${version}]: https://github.com/${REPO_SLUG}/releases/tag/v${version}`,
    "",
  );
  return lines.join("\n");
}

/** Insert a section immediately above the first existing release heading. */
export function insertSection(changelog: string, section: string): string {
  const lines = changelog.split(/\r?\n/);
  const at = lines.findIndex((line) => /^## \[/.test(line));
  if (at < 0) {
    return `${changelog.replace(/\s*$/, "")}\n\n${section}`;
  }
  return [...lines.slice(0, at), ...section.split("\n"), ...lines.slice(at)].join("\n");
}

function currentVersion(): string {
  return (JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as { version: string }).version;
}

function castPin(): { pkg: string; version: string } | undefined {
  try {
    const pin = JSON.parse(
      readFileSync(join(REPO_ROOT, "host", "cast", "package-pin.json"), "utf8"),
    ) as { package: string; version: string };
    return { pkg: pin.package, version: pin.version };
  } catch {
    return undefined;
  }
}

interface Args {
  dryRun: boolean;
  bump?: Bump;
  version?: string;
  githubOutput: boolean;
  allowEmpty: boolean;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, githubOutput: false, allowEmpty: false };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--github-output":
        args.githubOutput = true;
        break;
      case "--allow-empty":
        args.allowEmpty = true;
        break;
      case "--bump": {
        const value = argv[(i += 1)];
        if (value !== "major" && value !== "minor" && value !== "patch") {
          throw new Error(`--bump must be major, minor, or patch (got ${value}).`);
        }
        args.bump = value;
        break;
      }
      case "--version":
        args.version = argv[(i += 1)];
        break;
      default:
        throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  return args;
}

export function runCli(argv: string[]): number {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  let fragments: Fragment[];
  try {
    fragments = readFragments();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const previous = currentVersion();
  const hasChanges = fragments.length > 0;

  if (!hasChanges && !args.allowEmpty) {
    process.stdout.write("No pending fragments under .changes/unreleased — nothing to release.\n");
    if (args.githubOutput && process.env.GITHUB_OUTPUT) {
      appendOutput({ has_changes: "false", version: previous, previous_version: previous });
    }
    return 0;
  }

  const version = args.version
    ? resolveTarget(args.version, previous)
    : nextVersion(previous, args.bump ?? resolveBump(fragments));
  const date = new Date().toISOString().slice(0, 10);
  const section = renderSection(version, date, fragments, castPin());

  process.stdout.write(`${section}\n`);
  process.stdout.write(`Version: ${previous} -> ${version} (${args.bump ?? resolveBump(fragments)})\n`);

  if (args.githubOutput && process.env.GITHUB_OUTPUT) {
    appendOutput({
      has_changes: String(hasChanges),
      version,
      previous_version: previous,
    });
  }

  if (args.dryRun) {
    process.stdout.write("--dry-run: nothing written.\n");
    return 0;
  }

  writeFileSync(CHANGELOG, insertSection(readFileSync(CHANGELOG, "utf8"), section), "utf8");
  for (const fragment of fragments) {
    rmSync(join(FRAGMENT_DIR, fragment.file), { force: true });
  }
  process.stdout.write(
    `Wrote CHANGELOG.md and consumed ${fragments.length} fragment(s). ` +
      `Run: npm run version:set -- ${version}\n`,
  );
  return 0;
}

function appendOutput(values: Record<string, string>): void {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) {
    return;
  }
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}\n`);
  writeFileSync(file, lines.join(""), { encoding: "utf8", flag: "a" });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(runCli(process.argv.slice(2)));
}
