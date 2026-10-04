/**
 * Cast snapshot resolver (build-time, reproducible from PUBLIC sources).
 *
 * Produces the pinned cast bundle under `host/cast-active/.github` that the container
 * `Containerfile` COPYs to `/app/.github`, so `resolveSquadAgentsRoots()` /
 * `resolveSquadGithubRoot()` resolve REAL persona bytes at runtime (the
 * single-source invariant) instead of the paraphrased fallback.
 *
 * WHY THIS IS A RESOLVER AND NOT A FILE COPY
 * The previous implementation copied from a sibling `../hve-squad` checkout,
 * including `<package>/.github/agents` — the DEPLOYED cast. That directory is
 * gitignored in the package repo and ships in no release asset, so it exists only
 * on a workstation that has run `apm install`, holding whatever that install left
 * behind. The bundle was reproducible on exactly one machine, and a stale install
 * silently produced a bundle mixing current squad charters with retired upstream
 * agents — which every existing check then certified as good.
 *
 * `apm.yml` at the package tag IS the deployment manifest, and it IS committed:
 * every deployed file is one `<owner>/<repo>/<path>[#<ref>]` entry. This resolver
 * reads that manifest and fetches each file from its pinned source, so the bundle
 * is derivable on any machine with network access and nothing else.
 *
 * Sources (READ-ONLY, fetched over HTTPS):
 *   - `<package>@<tag>/apm.yml` .............. the deployment manifest
 *   - `microsoft/hve-core/...#<sha>` ......... upstream personas + boundary instruction
 *   - `<package>/squad-src/...@<tag>` ........ squad-owned charters + instructions
 *
 * Run `npm run snapshot:cast` to write the bundle, or `npm run snapshot:cast:check`
 * to verify the committed bundle still matches what the pin resolves to (no writes,
 * non-zero exit on drift). The offline counterpart — bundle bytes versus the hashes
 * recorded in `manifest.json` — lives in `test/cast-bundle.test.ts` and needs no
 * network.
 *
 * This runtime ships only the pinned agents and instructions. Agent Skill trees
 * are deliberately rejected: the native runtime does not expose skill loading.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, posix, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";

const HOST_DIR = dirname(fileURLToPath(import.meta.url));
const CAST_DIR = join(HOST_DIR, "cast-active");
const PACKAGE_PIN_PATH = join(CAST_DIR, "package-pin.json");
const MANIFEST_PATH = join(CAST_DIR, "manifest.json");

const CAST_ROOT = join(CAST_DIR, ".github");
const CAST_AGENTS = join(CAST_ROOT, "agents");
const CAST_INSTRUCTIONS = join(CAST_ROOT, "instructions");
export const RESEARCH_DEST = "skills/rpi/rpi-research";
export const TRACKING_DEST = "instructions/hve-core/copilot-tracking.instructions.md";
export const DISCLAIMER_DEST = "instructions/shared/disclaimer-language.instructions.md";
export const LICENSING_DEST = "instructions/hve-core/licensing-posture.instructions.md";

const BOUNDARY_FILE = "untrusted-content-boundary.instructions.md";
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Bounded so a snapshot cannot look like abuse to the origin. */
const FETCH_CONCURRENCY = 8;

interface Pin {
  package: string;
  version: string;
}

/** One `<owner>/<repo>/<path>[#<ref>]` entry from the package's `apm.yml`. */
export interface Dependency {
  slug: string;
  path: string;
  ref?: string;
}

/** A dependency selected for the bundle, resolved to a destination and commit. */
interface PlannedFile extends Dependency {
  dest: string;
  commit: string;
}

/** A materialized bundle file and its integrity record. */
interface ResolvedFile extends PlannedFile {
  content: string;
  sha256: string;
  agentName?: string;
}

interface CastManifest {
  generatedBy: string;
  sourcePackage: string;
  linkedPackageVersion: string;
  sourceRef: string;
  sourceCommit: string;
  sourceManifestSha256: string;
  upstreamCommits: Record<string, string>;
  generatedAt: string;
  agentFileCount: number;
  instructionFileCount: number;
  skillFileCount: number;
  dataFileCount: number;
  skillCount: number;
  skills: SkillRecord[];
  excludedFiles: ExcludedFile[];
  referenceIssues: ReferenceIssue[];
  agentNames: string[];
  duplicateAgentNames: string[];
  files: { path: string; sha256: string; source: string; kind?: "data" }[];
  note: string;
}

interface Resolution {
  files: ResolvedFile[];
  sourceCommit: string;
  sourceManifestSha256: string;
  upstreamCommits: Record<string, string>;
  duplicateAgentNames: string[];
  skills: SkillRecord[];
  excludedFiles: ExcludedFile[];
  referenceIssues: ReferenceIssue[];
}

interface SkillRecord {
  name: string;
  path: string;
  source: string;
}

interface ExcludedFile {
  source: string;
  reason: "execution-unavailable" | "non-markdown-asset";
}

export interface ReferenceIssue {
  from: string;
  target: string;
  reason: "outside-bundle" | "missing-markdown" | "non-markdown-resource";
}

/** Preserve upstream skill categories, including package-owned and root-level skills. */
export function skillDestination(sourcePath: string): string | undefined {
  const match = sourcePath.match(/(?:^|\/)(skills\/.+)$/);
  return match?.[1];
}

export function validateBundlePath(dest: string): void {
  if (!dest || /[\\:]/.test(dest) || dest.startsWith("/") ||
    dest.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`Unsafe bundle destination: ${dest}`);
  }
}

function isLicenseNotice(path: string): boolean {
  return /^(?:LICENSE(?:[-.].*)?|COPYING|NOTICE|THIRD-PARTY-NOTICES)$/i.test(posix.basename(path));
}

/** An extension allowlist admits inert reference data, never interpreter entrypoints. */
export function isDeclarativeDataFile(path: string): boolean {
  return /\.(?:json|yaml|yml|txt|csv)$/i.test(path) && !isLicenseNotice(path);
}

/**
 * Normalize to LF before hashing and writing.
 *
 * This repository has `core.autocrlf=true`, so the same blob is CRLF in a Windows
 * working tree and LF on a Linux runner. Hashing raw bytes would make the integrity
 * record platform-dependent and fail a bundle that is in fact identical.
 * `.gitattributes` pins the bundle to `eol=lf` too; this keeps the hash correct
 * even for a checkout that does not.
 */
export function normalizeContent(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

export function sha256(text: string): string {
  return createHash("sha256").update(normalizeContent(text), "utf8").digest("hex");
}

/** Read the `name:` frontmatter value from a persona file, if present. */
function agentNameOf(content: string): string | undefined {
  const match = content.match(FRONTMATTER);
  if (!match) {
    return undefined;
  }
  try {
    const fm = (parseYaml(match[1]) ?? {}) as Record<string, unknown>;
    return typeof fm.name === "string" && fm.name.trim().length > 0 ? fm.name.trim() : undefined;
  } catch {
    return undefined;
  }
}

function readPin(): Pin {
  const pin = JSON.parse(readFileSync(PACKAGE_PIN_PATH, "utf8")) as Pin;
  if (!pin.package || !pin.version) {
    throw new Error(`${PACKAGE_PIN_PATH} must declare both "package" and "version".`);
  }
  return pin;
}

/** Split `<owner>/<repo>/<path>[#<ref>]` into its parts. */
export function parseDependency(entry: string): Dependency {
  const [spec, ref] = entry.trim().split("#");
  const segments = spec.split("/").filter((segment) => segment.length > 0);
  if (segments.length < 3) {
    throw new Error(`Malformed apm dependency entry: "${entry}".`);
  }
  return {
    slug: `${segments[0]}/${segments[1]}`,
    path: segments.slice(2).join("/"),
    ref: ref && ref.length > 0 ? ref : undefined,
  };
}

/** Read the `dependencies.apm` list out of a package `apm.yml`. */
export function parseApmDependencies(apmYaml: string): Dependency[] {
  const doc = (parseYaml(apmYaml) ?? {}) as { dependencies?: { apm?: unknown } };
  const entries = doc.dependencies?.apm;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("apm.yml declares no dependencies.apm entries.");
  }
  return entries.map((entry) => parseDependency(String(entry)));
}

/**
 * Resolve a dependency to its bundle destination, or `undefined` when the bundle
 * deliberately does not carry it.
 *
 * The layout is this snapshot's own contract (the runtime resolvers probe
 * `instructions/squad/squad-routing.instructions.md` and scan `agents/`), NOT the
 * flat tree APM deploys. Squad charters live under `agents/squad/` and upstream
 * personas sit flat beside them, so each charter appears exactly once — copying
 * both the flat APM deploy and the `squad-src` sources is what previously
 * duplicated all 18 and left persona lookup decided by directory-walk order.
 */
export function bundleDestination(dep: Dependency, packageSlug: string): string | undefined {
  const file = dep.path.split("/").pop() ?? "";
  if (file === BOUNDARY_FILE) {
    return `instructions/${BOUNDARY_FILE}`;
  }
  if (file.endsWith(".agent.md") && dep.path.includes("/agents/")) {
    return dep.slug === packageSlug ? `agents/squad/${file}` : `agents/${file}`;
  }
  if (file.endsWith(".instructions.md") && dep.path.includes("/instructions/squad/")) {
    return `instructions/squad/${file}`;
  }
  return undefined;
}

/** Static relative links and explicitly path-shaped inline resource references. */
function referenceCandidates(content: string): string[] {
  return [...new Set([
    // Bare code-formatted filenames in schema prose include illustrative future
    // versions, not links. Explicit relative reference/template paths are dependencies.
    ...Array.from(content.matchAll(/`([^`\r\n]+)`/g), (match) => match[1])
      .filter((target) => /^(?:references\/|templates\/|assets\/|scripts\/|\.\.?[\\/]|[\\/]|[a-z]:)/i.test(target) ||
        target === "copilot-tracking.instructions.md"),
    ...Array.from(content.matchAll(/\[[^\]\r\n]*\]\(\s*<?([^\s)>]+)>?(?:\s+"[^"]*")?\s*\)/g), (match) => match[1]),
    ...Array.from(content.matchAll(/^\s*\[[^\]]+\]:\s*<?([^\s>]+)>?/gm), (match) => match[1]),
  ])].filter((target) => !/^(?:https?:|mailto:|#)/i.test(target) &&
    !/[{}<>*]|\s/.test(target) && !target.startsWith(".copilot-tracking/"));
}

function declarativeReferences(content: string): string[] {
  return [...new Set([
    ...Array.from(content.matchAll(/"\$ref"\s*:\s*"([^"]+)"/g), (match) => match[1]),
    ...Array.from(content.matchAll(/^\s*\$ref:\s*["']?([^"'\s]+)["']?\s*$/gm), (match) => match[1]),
  ])].filter((target) => !/^(?:https?:|#)/i.test(target));
}

function resolveReference(candidate: string, from: string): string {
  const target = decodeURIComponent(candidate.split(/[?#]/)[0]);
  // This instruction is named, rather than linked, in the upstream skill.
  if (target === "copilot-tracking.instructions.md") return TRACKING_DEST;
  if (/^[\\/]|^[a-z]:|\\/i.test(target)) {
    throw new Error(`Unsafe skill reference in ${from}: ${candidate}`);
  }
  const resolved = posix.normalize(posix.join(posix.dirname(from), target));
  if (resolved === ".." || resolved.startsWith("../") || posix.isAbsolute(resolved)) {
    throw new Error(`Skill reference escapes the bundle in ${from}: ${candidate}`);
  }
  return resolved;
}

/** Resolve static Markdown dependencies, not dynamic output-artifact examples. */
export function skillReferences(content: string, from: string): string[] {
  return [...new Set(referenceCandidates(content)
    .filter((target) => /(?:\.|%2e)md(?:[?#].*)?$/i.test(target))
    .map((target) => resolveReference(target, from)))].sort();
}

export function collectReferenceIssues(files: { dest: string; content: string }[]): ReferenceIssue[] {
  const paths = new Set(files.map((file) => file.dest));
  const issues: ReferenceIssue[] = [];
  for (const file of files.filter((entry) => (entry.dest.endsWith(".md") || isDeclarativeDataFile(entry.dest)) &&
    (entry.dest.startsWith("skills/") || entry.dest.startsWith("instructions/")))) {
    const candidates = isDeclarativeDataFile(file.dest) ? declarativeReferences(file.content) : referenceCandidates(file.content);
    for (const target of candidates) {
      if (!/\.[a-z0-9]+(?:[?#].*)?$/i.test(target)) continue;
      try {
        const dest = resolveReference(target, file.dest);
        if (!paths.has(dest)) {
          issues.push({ from: file.dest, target, reason: dest.endsWith(".md") ? "missing-markdown" : "non-markdown-resource" });
        }
      } catch {
        issues.push({ from: file.dest, target, reason: "outside-bundle" });
      }
    }
  }
  return issues.sort((a, b) => a.from.localeCompare(b.from) || a.target.localeCompare(b.target));
}

export function validateSkillReferences(
  files: { dest: string; content: string }[],
  recordedIssues: ReferenceIssue[] = [],
): void {
  const actual = collectReferenceIssues(files);
  if (JSON.stringify(actual) !== JSON.stringify(recordedIssues)) {
    throw new Error(`Missing skill dependency or unsafe reference: ${JSON.stringify(actual)}`);
  }
}

function authHeaders(): Record<string, string> {
  const token = (process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "").trim();
  // Public repos need no token; one raises the rate limit and lets CI use its own.
  return token.length > 0 ? { Authorization: `Bearer ${token}` } : {};
}

async function fetchText(url: string, accept = "text/plain"): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { Accept: accept, "User-Agent": "hve-squad-mcp-snapshot", ...authHeaders() },
      });
      if (response.ok) {
        return await response.text();
      }
      // A 4xx other than rate limiting is deterministic — retrying cannot help.
      if (response.status < 500 && response.status !== 429) {
        throw new Error(`GET ${url} -> ${response.status} ${response.statusText}`);
      }
      lastError = new Error(`GET ${url} -> ${response.status} ${response.statusText}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`GET ${url} failed.`);
}

/** Resolve a ref (tag, branch, or sha) to the immutable commit it points at. */
async function resolveCommit(slug: string, ref: string): Promise<string> {
  const body = await fetchText(
    `https://api.github.com/repos/${slug}/commits/${ref}`,
    "application/vnd.github+json",
  );
  const sha = (JSON.parse(body) as { sha?: string }).sha;
  if (!sha) {
    throw new Error(`Could not resolve ${slug}@${ref} to a commit sha.`);
  }
  return sha;
}

function rawUrl(slug: string, commit: string, path: string): string {
  return `https://raw.githubusercontent.com/${slug}/${commit}/${path}`;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function resolveBundle(pin: Pin): Promise<Resolution> {
  const tag = `v${pin.version}`;
  const sourceCommit = await resolveCommit(pin.package, tag);
  const apmYaml = await fetchText(rawUrl(pin.package, sourceCommit, "apm.yml"));

  // Enforce the version LINK: the tag we resolve MUST declare the pinned version,
  // so a moved tag or a mistyped pin cannot ship a bundle labelled as something else.
  const declared = String(((parseYaml(apmYaml) ?? {}) as { version?: string }).version ?? "").trim();
  if (declared !== pin.version) {
    throw new Error(
      `Package version mismatch: host/cast-active/package-pin.json pins ${pin.package}@${pin.version} ` +
        `but ${pin.package}@${tag} declares ${declared || "<none>"}. ` +
        "Bump the pin (and this server's version) or correct the pin.",
    );
  }

  // Every entry must be reachable at a fixed commit. The package's own entries resolve
  // at the tag's commit; anything else unpinned would float and is refused.
  const upstreamCommits: Record<string, string> = { [pin.package]: sourceCommit };
  const planned: PlannedFile[] = [];
  const byDest = new Map<string, PlannedFile>();
  const skills: SkillRecord[] = [];
  const excludedFiles: ExcludedFile[] = [];

  for (const dep of parseApmDependencies(apmYaml)) {
    const dest = bundleDestination(dep, pin.package);
    if (!dest) {
      continue;
    }
    let commit: string;
    if (dep.slug === pin.package) {
      // Package releases from v0.15.2 on rewrite the self-references to the tag being
      // cut; earlier tags left them bare, which APM resolved against the default branch.
      // Either way this bundle takes the tag's OWN commit, never `main` — so a
      // self-reference naming some other release is a mis-cut tag, not a choice.
      if (dep.ref && dep.ref !== tag && dep.ref !== sourceCommit) {
        throw new Error(
          `${pin.package}@${tag} self-references ${dep.path} at "${dep.ref}" rather than ${tag}. ` +
            "A release tag's manifest must point at the release it ships.",
        );
      }
      commit = sourceCommit;
    } else if (dep.ref && /^[a-f0-9]{40}$/i.test(dep.ref)) {
      commit = dep.ref;
      if (upstreamCommits[dep.slug] && upstreamCommits[dep.slug] !== commit) {
        throw new Error(`Mixed upstream commits for ${dep.slug}.`);
      }
      upstreamCommits[dep.slug] ??= dep.ref;
    } else {
      throw new Error(
        `Dependency outside the package repo requires a full commit SHA: ${dep.slug}/${dep.path}. ` +
          "A floating ref cannot produce a reproducible bundle.",
      );
    }
    let entries = [{ path: dep.path, dest }];
    if (dep.path.endsWith(`/${BOUNDARY_FILE}`)) {
      // Keep the existing runtime probe and its original source-relative location.
      entries.push({ path: dep.path, dest: `instructions/shared/${BOUNDARY_FILE}` });
    }
    for (const entry of entries) {
      validateBundlePath(entry.dest);
      const clash = byDest.get(entry.dest);
      if (clash) {
        throw new Error(
          `Two dependencies resolve to the same bundle path "${entry.dest}": ` +
            `${clash.slug}/${clash.path} and ${dep.slug}/${entry.path}.`,
        );
      }
      const file: PlannedFile = { ...dep, ...entry, commit };
      byDest.set(entry.dest, file);
      planned.push(file);
    }
  }

  if (!planned.some((file) => file.dest.startsWith("agents/"))) {
    throw new Error("apm.yml yielded no agent personas — the manifest layout changed.");
  }
  if (!planned.some((file) => file.dest.startsWith("instructions/squad/"))) {
    throw new Error("apm.yml yielded no squad instructions — the manifest layout changed.");
  }
  if (!planned.some((file) => file.dest === `instructions/${BOUNDARY_FILE}`)) {
    throw new Error(`apm.yml does not carry ${BOUNDARY_FILE} — boundary enforcement would ship absent.`);
  }
  const contentCache = new Map<string, Promise<string>>();
  const files = await mapWithConcurrency(planned, FETCH_CONCURRENCY, async (file) => {
    const url = rawUrl(file.slug, file.commit, file.path);
    if (!contentCache.has(url)) contentCache.set(url, fetchText(url).then(normalizeContent));
    const content = await contentCache.get(url)!;
    return {
      ...file,
      content,
      sha256: sha256(content),
      agentName: file.dest.startsWith("agents/") ? agentNameOf(content) : undefined,
    } satisfies ResolvedFile;
  });
  files.sort((a, b) => a.dest.localeCompare(b.dest));
  const referenceIssues = collectReferenceIssues(files);
  validateSkillReferences(files, referenceIssues);

  // Two files claiming one `name:` means two candidates for the same dispatch target,
  // resolved by directory-walk order. Upstream ships at least one such pair, so this
  // is recorded rather than fatal; the bundle test fails only when a colliding name is
  // one the catalog or roster actually dispatches.
  const counts = new Map<string, number>();
  for (const file of files) {
    if (file.agentName) {
      counts.set(file.agentName, (counts.get(file.agentName) ?? 0) + 1);
    }
  }
  const duplicateAgentNames = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([name]) => name)
    .sort((a, b) => a.localeCompare(b));

  return {
    files,
    sourceCommit,
    sourceManifestSha256: sha256(apmYaml),
    upstreamCommits,
    duplicateAgentNames,
    skills: skills.sort((a, b) => a.path.localeCompare(b.path)),
    excludedFiles: excludedFiles.sort((a, b) => a.source.localeCompare(b.source)),
    referenceIssues,
  };
}

function buildManifest(pin: Pin, resolution: Resolution, generatedAt: string): CastManifest {
  const agents = resolution.files.filter((file) => file.dest.startsWith("agents/"));
  const names = agents
    .map((file) => file.agentName)
    .filter((name): name is string => Boolean(name))
    .sort((a, b) => a.localeCompare(b));
  return {
    generatedBy: "host/snapshot-cast.ts",
    sourcePackage: pin.package,
    linkedPackageVersion: pin.version,
    sourceRef: `v${pin.version}`,
    sourceCommit: resolution.sourceCommit,
    sourceManifestSha256: resolution.sourceManifestSha256,
    upstreamCommits: Object.fromEntries(
      Object.entries(resolution.upstreamCommits).sort(([a], [b]) => a.localeCompare(b)),
    ),
    generatedAt,
    agentFileCount: agents.length,
    instructionFileCount: resolution.files.filter((file) => file.dest.startsWith("instructions/")).length,
    skillFileCount: resolution.files.filter((file) => file.dest.startsWith("skills/")).length,
    dataFileCount: resolution.files.filter((file) => isDeclarativeDataFile(file.dest)).length,
    skillCount: resolution.skills.length,
    skills: resolution.skills,
    excludedFiles: resolution.excludedFiles,
    referenceIssues: resolution.referenceIssues,
    agentNames: [...new Set(names)],
    duplicateAgentNames: resolution.duplicateAgentNames,
    files: resolution.files.map((file) => ({
      path: file.dest,
      sha256: file.sha256,
      source: `${file.slug}/${file.path}#${file.commit}`,
      ...(isDeclarativeDataFile(file.dest) ? { kind: "data" as const } : {}),
    })),
    note: "Only pinned agent charters and instruction files are bundled. Agent Skill resources are not bundled or executable in this runtime; native server procedures and artifact validators replace those dependencies. Provenance is preserved for every bundled file. Code execution and deployment remain unavailable.",
  };
}

function writeBundle(resolution: Resolution, manifest: CastManifest): void {
  // Clean the generated subtrees so a removed agent does not linger.
  rmSync(CAST_AGENTS, { recursive: true, force: true });
  rmSync(CAST_INSTRUCTIONS, { recursive: true, force: true });
  rmSync(join(CAST_ROOT, "skills"), { recursive: true, force: true });
  for (const file of resolution.files) {
    const target = join(CAST_ROOT, file.dest);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content, "utf8");
  }
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

/** Every file currently in the bundle tree, bundle-relative with POSIX separators. */
function bundledPaths(dir = CAST_ROOT, acc: string[] = []): string[] {
  if (!existsSync(dir)) {
    return acc;
  }
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      bundledPaths(full, acc);
    } else {
      acc.push(relative(CAST_ROOT, full).replace(/\\/g, "/"));
    }
  }
  return acc;
}

function checkBundle(resolution: Resolution, manifest: CastManifest): string[] {
  const problems: string[] = [];
  const expected = new Map(resolution.files.map((file) => [file.dest, file.sha256]));

  for (const [dest, expectedHash] of expected) {
    const target = join(CAST_ROOT, dest);
    if (!existsSync(target)) {
      problems.push(`missing from the bundle: ${dest}`);
      continue;
    }
    if (sha256(readFileSync(target, "utf8")) !== expectedHash) {
      problems.push(`content differs from the pinned source: ${dest}`);
    }
  }
  for (const dest of bundledPaths()) {
    if (!expected.has(dest)) {
      problems.push(`present in the bundle but not in the pinned manifest: ${dest}`);
    }
  }

  if (!existsSync(MANIFEST_PATH)) {
    problems.push("host/cast-active/manifest.json is missing");
    return problems;
  }
  const committed = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as CastManifest;
  // `generatedAt` is a timestamp, not a fact about the content.
  const comparable = (m: CastManifest): string => JSON.stringify({ ...m, generatedAt: "" });
  if (comparable(committed) !== comparable(manifest)) {
    problems.push("host/cast-active/manifest.json does not match what the pin resolves to");
  }
  return problems;
}

export async function runCli(argv: string[]): Promise<number> {
  const pin = readPin();
  const resolution = await resolveBundle(pin);
  const manifest = buildManifest(pin, resolution, new Date().toISOString().slice(0, 10));

  if (argv.includes("--check")) {
    const problems = checkBundle(resolution, manifest);
    if (problems.length > 0) {
      const shown = problems.slice(0, 25).map((problem) => `  - ${problem}`);
      process.stderr.write(
        `Cast bundle is out of date with ${pin.package}@${pin.version} (${problems.length} problem(s)):\n` +
          `${shown.join("\n")}\n` +
          (problems.length > shown.length ? `  ... and ${problems.length - shown.length} more\n` : "") +
          "Run `npm run snapshot:cast` and commit the result.\n",
      );
      return 1;
    }
    process.stdout.write(
      `Cast bundle matches ${pin.package}@${pin.version} ` +
        `(${manifest.agentFileCount} agents, ${manifest.instructionFileCount} instructions, ${manifest.skillCount} skills / ${manifest.skillFileCount} skill files).\n`,
    );
    return 0;
  }

  writeBundle(resolution, manifest);
  if (manifest.duplicateAgentNames.length > 0) {
    process.stdout.write(
      `Note: duplicate persona name(s) in the resolved cast: ${manifest.duplicateAgentNames.join(", ")}.\n`,
    );
  }
  process.stdout.write(
    `Snapshot: ${manifest.agentFileCount} agent files, ${manifest.agentNames.length} named personas, ` +
      `${manifest.instructionFileCount} instruction files, ${manifest.skillCount} skills / ${manifest.skillFileCount} skill files; ` +
      `linked ${pin.package}@${pin.version} (${manifest.sourceCommit.slice(0, 7)}).\n`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
}
