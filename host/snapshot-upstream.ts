import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import { parseApmDependencies, validateBundlePath } from "./snapshot-cast.js";

const root = dirname(fileURLToPath(import.meta.url));
const target = join(root, "upstream-runtime");
interface Pin { package: string; ref: string; commit: string }
interface TreeEntry { path: string; type: string; sha: string; mode: string }
interface FileRecord { path: string; source: string; commit: string; blob: string; sha256: string; bytes: number }
interface Snapshot { sourcePackage: string; sourceRef: string; sourceCommit: string; declaredVersion: string; manifestSha256: string; files: FileRecord[] }

export function upstreamDestination(source: string): string | undefined {
  const github = source.indexOf(".github/");
  if (github >= 0) return source.slice(github);
  if (source.startsWith("skills/")) return `.github/${source}`;
  return undefined;
}

export function verifyGitBlob(bytes: Uint8Array, expected: string): void {
  const hash = createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
  if (hash !== expected) throw new Error("Fetched upstream file does not match its immutable Git blob.");
}

async function fetchBytes(url: string): Promise<Buffer> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000), headers: { Accept: "application/vnd.github+json" } });
    if (response.ok) return Buffer.from(await response.arrayBuffer());
    if (response.status < 500 && response.status !== 429) throw new Error(`Upstream snapshot GET ${url}: HTTP ${response.status}`);
    if (attempt === 2) throw new Error(`Upstream snapshot GET ${url}: HTTP ${response.status}`);
    await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
  }
  throw new Error("Upstream snapshot retries exhausted.");
}

function onDiskPaths(dir: string, prefix = ""): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap(name => {
    const full = join(dir, name), rel = prefix ? `${prefix}/${name}` : name;
    return statSync(full).isDirectory() ? onDiskPaths(full, rel) : [rel];
  });
}

export async function snapshotUpstream(check: boolean): Promise<void> {
  const pin = JSON.parse(readFileSync(join(root, "upstream-pin.json"), "utf8")) as Pin;
  if (!/^[\w.-]+\/[\w.-]+$/.test(pin.package) || !/^[a-f0-9]{40}$/.test(pin.commit)) throw new Error("Full upstream snapshot requires a package slug and immutable commit SHA.");
  const raw = (slug: string, sha: string, path: string) => `https://raw.githubusercontent.com/${slug}/${sha}/${path}`;
  const manifest = await fetchBytes(raw(pin.package, pin.commit, "apm.yml"));
  const yaml = parseYaml(manifest.toString("utf8")) as { version?: string };
  const trees = new Map<string, TreeEntry[]>();
  const getTree = async (slug: string, sha: string) => {
    const key = `${slug}#${sha}`;
    if (!trees.has(key)) {
      const tree = JSON.parse((await fetchBytes(`https://api.github.com/repos/${slug}/git/trees/${sha}?recursive=1`)).toString("utf8")) as { truncated?: boolean; tree: TreeEntry[] };
      if (tree.truncated) throw new Error(`Upstream tree is truncated: ${key}`);
      trees.set(key, tree.tree);
    }
    return trees.get(key)!;
  };
  const planned = new Map<string, { slug: string; commit: string; entry: TreeEntry }>();
  for (const dep of parseApmDependencies(manifest.toString("utf8"))) {
    const commit = dep.slug === pin.package ? pin.commit : dep.ref;
    if (!commit || !/^[a-f0-9]{40}$/.test(commit)) throw new Error(`Floating upstream dependency: ${dep.slug}/${dep.path}`);
    const files = (await getTree(dep.slug, commit)).filter(entry => entry.type === "blob" && (entry.path === dep.path || entry.path.startsWith(`${dep.path}/`)));
    if (!files.length) throw new Error(`Missing declared dependency: ${dep.slug}/${dep.path}`);
    for (const entry of files) {
      if (entry.mode === "120000") throw new Error(`Symbolic link in upstream dependency: ${entry.path}`);
      const dest = upstreamDestination(entry.path);
      if (!dest) throw new Error(`Unsupported upstream dependency layout: ${dep.slug}/${entry.path}`);
      validateBundlePath(dest);
      const prior = planned.get(dest);
      if (prior && (prior.slug !== dep.slug || prior.commit !== commit || prior.entry.sha !== entry.sha)) throw new Error(`Upstream destination collision: ${dest}`);
      planned.set(dest, { slug: dep.slug, commit, entry });
    }
  }
  for (const [key, tree] of trees) {
    const split = key.lastIndexOf("#"), slug = key.slice(0, split), commit = key.slice(split + 1);
    const licenses = tree.filter(entry => entry.type === "blob" && /^(?:LICENSE(?:\.[\w-]+)?|COPYING|NOTICE|THIRD-PARTY-NOTICES(?:\.md)?)$/i.test(entry.path));
    if (!licenses.some(entry => /^LICENSE/i.test(entry.path))) throw new Error(`No root license found for ${slug}; review licensing before bundling.`);
    for (const entry of licenses) planned.set(`licenses/${slug}/${entry.path}`, { slug, commit, entry });
  }
  const expectedPaths = [...planned.keys(), "apm.yml", "manifest.json", "README.md"];
  const extra = onDiskPaths(target).filter(path => !expectedPaths.includes(path));
  if (extra.length) throw new Error(`Existing upstream snapshot contains obsolete files; explicit scoped cleanup required: ${extra.slice(0, 10).join(", ")}`);
  const records: FileRecord[] = [];
  const work = [...planned.entries()].sort(([a], [b]) => a.localeCompare(b));
  let next = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (next < work.length) {
      const [dest, item] = work[next++];
      const bytes = await fetchBytes(raw(item.slug, item.commit, item.entry.path));
      verifyGitBlob(bytes, item.entry.sha);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const file = join(target, ...dest.split("/"));
      if (check) {
        if (!existsSync(file) || createHash("sha256").update(readFileSync(file)).digest("hex") !== sha256) throw new Error(`Upstream snapshot drift: ${dest}`);
      } else { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, bytes); }
      records.push({ path: dest, source: `${item.slug}/${item.entry.path}`, commit: item.commit, blob: item.entry.sha, sha256, bytes: bytes.length });
    }
  }));
  const snapshot: Snapshot = { sourcePackage: pin.package, sourceRef: pin.ref, sourceCommit: pin.commit, declaredVersion: String(yaml.version), manifestSha256: createHash("sha256").update(manifest).digest("hex"), files: records.sort((a, b) => a.path.localeCompare(b.path)) };
  const serialized = JSON.stringify(snapshot, null, 2) + "\n";
  if (check) {
    if (readFileSync(join(target, "manifest.json"), "utf8") !== serialized || !readFileSync(join(target, "apm.yml")).equals(manifest)) throw new Error("Full upstream snapshot manifest drift.");
  } else { writeFileSync(join(target, "apm.yml"), manifest); writeFileSync(join(target, "manifest.json"), serialized); }
  console.log(`Full upstream dependency snapshot ${check ? "verified" : "resolved"}: ${records.length} files at ${pin.ref} (${pin.commit.slice(0, 7)}). This does not activate upstream execution.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  snapshotUpstream(process.argv.includes("--check")).catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
