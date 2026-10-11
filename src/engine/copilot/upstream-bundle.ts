import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";
import { parse as parseYaml } from "yaml";
import { packageRoot } from "../../paths.js";

interface UpstreamFile { path: string; source: string; commit: string; sha256: string; bytes: number; blob: string }
export interface UpstreamSkill { name: string; description: string; path: string; resources: string[] }
export interface UpstreamBundleIdentity { sourcePackage: string; sourceRef: string; sourceCommit: string; declaredVersion: string; files: UpstreamFile[] }

/** The immutable upstream package; callers can read declared resources, never arbitrary host files. */
export class UpstreamBundle {
  readonly identity: UpstreamBundleIdentity;
  private readonly files: Map<string, UpstreamFile>;
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  constructor(readonly root: string) {
    this.identity = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as UpstreamBundleIdentity;
    if (!this.identity.sourcePackage || !/^[a-f0-9]{40}$/.test(this.identity.sourceCommit) || !Array.isArray(this.identity.files)) throw new Error("Invalid immutable upstream bundle manifest.");
    this.files = new Map();
    for (const file of this.identity.files) {
      if (this.files.has(file.path)) throw new Error("Duplicate upstream bundle path: " + file.path);
      this.assertPath(file.path);
      if (!/^[a-f0-9]{40}$/.test(file.commit) || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error("Invalid upstream resource provenance: " + file.path);
      const bytes = readFileSync(this.diskPath(file.path));
      if (bytes.length !== file.bytes || createHash("sha256").update(bytes).digest("hex") !== file.sha256) throw new Error("Upstream bundle integrity mismatch: " + file.path);
      this.files.set(file.path, file);
    }
  }
  private assertPath(path: string): void {
    if (!path || path.includes("\\") || path.includes("\0") || path.startsWith("/") || path.split("/").some(p => !p || p === "." || p === "..") || path.includes(":")) throw new Error("Unsafe upstream resource path.");
  }
  private diskPath(path: string): string {
    const full = resolve(this.root, ...path.split("/"));
    if (!full.startsWith(resolve(this.root) + sep)) throw new Error("Upstream resource escapes its bundle.");
    return full;
  }
  read(path: string, start = 1, maxLines = 160): { path: string; source: string; commit: string; sha256: string; content: string; firstLine: number; lastLine: number; totalLines: number; truncated: boolean } {
    this.assertPath(path);
    const file = this.files.get(path);
    if (!file) throw new Error("Resource is not declared in the upstream package: " + path);
    if (!Number.isInteger(start) || start < 1 || !Number.isInteger(maxLines) || maxLines < 1 || maxLines > 400) throw new Error("Upstream resource range must use a positive first line and at most 400 lines.");
    const bytes = readFileSync(this.diskPath(path));
    if (createHash("sha256").update(bytes).digest("hex") !== file.sha256) throw new Error("Upstream resource changed after verification: " + path);
    let text: string;
    try { text = this.decoder.decode(bytes); } catch (cause) { throw new Error("Binary upstream assets cannot be read as instructions: " + path, { cause }); }
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    if (start > lines.length) throw new Error("Upstream resource range starts after end of file.");
    const end = Math.min(lines.length, start - 1 + maxLines);
    const content = lines.slice(start - 1, end).join("\n");
    if (content.length > 64_000) throw new Error("Upstream resource range exceeds 64000 characters; request a smaller range.");
    return { path, source: file.source, commit: file.commit, sha256: file.sha256, content, firstLine: start, lastLine: end, totalLines: lines.length, truncated: end < lines.length };
  }
  skills(): UpstreamSkill[] {
    return [...this.files.keys()].filter(path => path.endsWith("/SKILL.md")).map(path => {
      const text = this.decoder.decode(readFileSync(this.diskPath(path)));
      const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
      if (!match) throw new Error("Upstream skill frontmatter is missing: " + path);
      const frontmatter = parseYaml(match[1]) as { name?: unknown; description?: unknown };
      if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") throw new Error("Upstream skill metadata is invalid: " + path);
      const prefix = path.slice(0, -"SKILL.md".length);
      return { name: frontmatter.name, description: frontmatter.description, path, resources: [...this.files.keys()].filter(p => p.startsWith(prefix) && p !== path) };
    }).sort((a,b) => a.path.localeCompare(b.path));
  }
  paths(prefix = ""): string[] { return [...this.files.keys()].filter(path => path.startsWith(prefix)).sort(); }
}

export function installedUpstreamBundle(): UpstreamBundle {
  const root = packageRoot();
  const candidates = [join(root, "host", "upstream-runtime"), join(root, "upstream-runtime")];
  const found = candidates.find(path => existsSync(join(path, "manifest.json")));
  if (!found) throw new Error("Full upstream runtime was enabled without its verified dependency bundle.");
  return new UpstreamBundle(found);
}
