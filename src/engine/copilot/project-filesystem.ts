/**
 * The persistent project, served to a Copilot sandbox as its `/workspace`.
 *
 * The Copilot runtime routes its file tools (`view`, `create`, `edit`) and its
 * own session state through a client-provided session filesystem. This class
 * is that provider. Measured against runtime 1.0.90:
 *
 *   * `/workspace/<path>` is the project tree in the artifact store. Reads are
 *     served from the store; writes go straight back to it, limited to the
 *     stage's write scope and arbitrated by compare-and-swap, so nothing an
 *     agent writes with a file tool is lost when the sandbox is discarded.
 *   * Every other path is the runtime's session state (conversation log,
 *     checkpoints), kept in a {@link CopilotSessionStateStore} so the session
 *     can resume in a fresh sandbox.
 *
 * `bash`, `glob` and `grep` do not use this provider; they see the sandbox's own
 * disk. The executor collects text files they write inside the write scope when
 * the stage completes.
 */
import { createHash } from "node:crypto";
import { posix } from "node:path";

import { ARTIFACT_MAX_CHARS, assertSafeArtifactPath, type SquadArtifactStore } from "../artifact-store.js";
import type { CopilotSessionKey, CopilotSessionStateStore } from "./session-state-store.js";

/** Structural match for the SDK's `SessionFsProvider`. */
export interface SessionFsProviderPort {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string, mode?: number): Promise<void>;
  appendFile(path: string, content: string, mode?: number): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<{ isFile: boolean; isDirectory: boolean; size: number; mtime: string; birthtime: string }>;
  mkdir(path: string, recursive: boolean, mode?: number): Promise<void>;
  readdir(path: string): Promise<string[]>;
  readdirWithTypes(path: string): Promise<{ name: string; type: "file" | "directory" }[]>;
  rm(path: string, recursive: boolean, force: boolean): Promise<void>;
  rename(src: string, dest: string): Promise<void>;
}

export interface WriteScope {
  exactPaths: string[];
  prefixes: string[];
}

export interface ProjectFileSystemOptions {
  store: SquadArtifactStore;
  tenantId: string;
  project: string;
  /** Absolute POSIX mount point of the project inside the sandbox. */
  mount: string;
  writeScope: WriteScope;
  /** Read-only virtual files, keyed by project-relative path (e.g. `input/request.md`). */
  inputs: Record<string, string>;
  sessionState: CopilotSessionStateStore;
  sessionKey: CopilotSessionKey;
}

export interface ProjectWrite {
  path: string;
  sha256: string;
  origin: "file_tool" | "submit_artifact" | "sandbox_disk";
}

export const PROJECT_TEXT_EXTENSIONS = /\.(md|json|csv|txt|ya?ml)$/i;
const MAX_LISTED = 500;

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function fsError(code: string, message: string): Error {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

function ancestors(path: string): string[] {
  const parts = path.split("/");
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
}

export class ProjectFileSystem implements SessionFsProviderPort {
  /** Project paths written during this session, with the hash of the content written. */
  readonly writes = new Map<string, ProjectWrite>();
  /** Project paths read from the store during this session, with the hash served. */
  readonly served = new Map<string, string>();
  readonly refusals: string[] = [];

  private readonly mount: string;
  private readonly etags = new Map<string, string>();
  private readonly projectDirs = new Set<string>();
  private readonly sessionDirs = new Set<string>();
  private listing = new Set<string>();

  constructor(private readonly options: ProjectFileSystemOptions) {
    this.mount = posix.normalize(options.mount).replace(/\/$/, "");
    for (const prefix of options.writeScope.prefixes) this.projectDirs.add(prefix.replace(/\/$/, ""));
  }

  /** Load the project listing; call once before handing the provider to a session. */
  async initialize(): Promise<this> {
    const entries = await this.options.store.list(this.options.tenantId, this.options.project);
    this.listing = new Set(entries.map((entry) => entry.path));
    return this;
  }

  // -- Classification ------------------------------------------------------

  private classify(path: string): { kind: "project"; rel: string } | { kind: "session"; path: string } {
    const normalized = posix.normalize(path.replace(/\\/g, "/"));
    if (normalized === this.mount) return { kind: "project", rel: "" };
    if (normalized.startsWith(`${this.mount}/`)) {
      const rel = normalized.slice(this.mount.length + 1).replace(/\/$/, "");
      if (rel.split("/").some((segment) => segment === ".." || segment === "")) throw fsError("EACCES", `Unsafe path ${path}`);
      return { kind: "project", rel };
    }
    return { kind: "session", path: normalized };
  }

  private isInput(rel: string): boolean {
    return Object.hasOwn(this.options.inputs, rel);
  }

  private knownFiles(): string[] {
    return [...new Set([...this.listing, ...Object.keys(this.options.inputs), ...this.writes.keys()])];
  }

  private isProjectDir(rel: string): boolean {
    if (rel === "") return true;
    if (this.projectDirs.has(rel)) return true;
    const dirs = new Set<string>();
    for (const file of [...this.knownFiles(), ...this.options.writeScope.exactPaths]) for (const dir of ancestors(file)) dirs.add(dir);
    for (const dir of this.projectDirs) for (const ancestor of [...ancestors(dir), dir]) dirs.add(ancestor);
    if (dirs.has(rel)) return true;
    // Extension-less paths inside a writable root behave as directories so `create` can nest files.
    return this.options.writeScope.prefixes.some((prefix) => rel.startsWith(prefix)) && !/\.[^/]+$/.test(rel);
  }

  /** Whether a project-relative path may be written by this stage. */
  canWrite(rel: string): boolean {
    try { assertSafeArtifactPath(rel); } catch { return false; }
    const { exactPaths, prefixes } = this.options.writeScope;
    return PROJECT_TEXT_EXTENSIONS.test(rel) && (exactPaths.includes(rel) || prefixes.some((prefix) => rel.startsWith(prefix)));
  }

  // -- Project operations shared with the executor ---------------------------

  async readProject(rel: string): Promise<string | undefined> {
    if (this.isInput(rel)) {
      const input = this.options.inputs[rel];
      this.served.set(rel, sha256(input));
      return input;
    }
    try { assertSafeArtifactPath(rel); } catch { return undefined; }
    const artifact = await this.options.store.get(this.options.tenantId, this.options.project, rel);
    if (!artifact) return undefined;
    this.etags.set(rel, artifact.etag);
    this.listing.add(rel);
    this.served.set(rel, sha256(artifact.content));
    return artifact.content;
  }

  /** Create-only for unseen paths; compare-and-swap for paths read or written in this session. */
  async writeProject(rel: string, content: string, origin: ProjectWrite["origin"]): Promise<ProjectWrite> {
    if (!this.canWrite(rel)) {
      const scope = JSON.stringify(this.options.writeScope);
      this.refusals.push(`Write outside the stage write scope refused: ${rel}`);
      throw fsError("EACCES", `${rel} is outside this stage's write scope ${scope} or is not a text artifact (.md, .json, .csv, .txt, .yaml).`);
    }
    if (content.length > ARTIFACT_MAX_CHARS) throw fsError("EFBIG", `${rel} exceeds ${ARTIFACT_MAX_CHARS} characters.`);
    const { tenantId, project, store } = this.options;
    const result = await store.put(tenantId, project, rel, content, this.etags.get(rel) ?? "");
    if (!result.ok) {
      throw fsError("EEXIST", `${rel} already exists or changed since it was read; view it first, then edit it.`);
    }
    const saved = await store.get(tenantId, project, rel);
    if (!saved || saved.content !== content) throw fsError("EIO", `Read-back of ${rel} did not match the written content.`);
    this.etags.set(rel, saved.etag);
    this.listing.add(rel);
    const write: ProjectWrite = { path: rel, sha256: sha256(content), origin };
    this.writes.set(rel, write);
    return write;
  }

  /** Readable project paths, optionally under a prefix. */
  listProject(prefix = ""): { paths: string[]; truncated: boolean } {
    const normalized = prefix.replace(/^\/+|\/+$/g, "");
    const paths = this.knownFiles()
      .filter((path) => !normalized || path === normalized || path.startsWith(`${normalized}/`))
      .sort();
    return { paths: paths.slice(0, MAX_LISTED), truncated: paths.length > MAX_LISTED };
  }

  /** Case-insensitive substring search over readable project text. Reads are not evidence. */
  async searchProject(query: string, prefix = "", maxMatches = 100): Promise<{ matches: { path: string; line: number; text: string }[]; truncated: boolean }> {
    const needle = query.toLowerCase();
    const matches: { path: string; line: number; text: string }[] = [];
    for (const path of this.listProject(prefix).paths) {
      const content = this.isInput(path)
        ? this.options.inputs[path]
        : (await this.options.store.get(this.options.tenantId, this.options.project, path))?.content;
      if (content === undefined) continue;
      const lines = content.split("\n");
      for (let index = 0; index < lines.length; index++) {
        if (!lines[index].toLowerCase().includes(needle)) continue;
        matches.push({ path, line: index + 1, text: lines[index].slice(0, 240) });
        if (matches.length >= maxMatches) return { matches, truncated: true };
      }
    }
    return { matches, truncated: false };
  }

  // -- Session-state helpers -------------------------------------------------

  private async sessionPaths(): Promise<string[]> {
    return this.options.sessionState.list(this.options.sessionKey);
  }

  private async isSessionDir(path: string): Promise<boolean> {
    if (path === "/" || this.sessionDirs.has(path)) return true;
    return (await this.sessionPaths()).some((stored) => stored.startsWith(`${path}/`));
  }

  private async children(path: string, files: string[], dirs: string[]): Promise<{ name: string; type: "file" | "directory" }[]> {
    const prefix = path === "" || path === "/" ? (path === "/" ? "/" : "") : `${path}/`;
    const entries = new Map<string, "file" | "directory">();
    for (const file of files) {
      if (!file.startsWith(prefix) || file === path) continue;
      const rest = file.slice(prefix.length).split("/");
      entries.set(rest[0], rest.length === 1 && entries.get(rest[0]) !== "directory" ? "file" : "directory");
    }
    for (const dir of dirs) {
      if (!dir.startsWith(prefix) || dir === path) continue;
      entries.set(dir.slice(prefix.length).split("/")[0], "directory");
    }
    return [...entries].map(([name, type]) => ({ name, type })).sort((a, b) => a.name.localeCompare(b.name));
  }

  // -- SessionFsProvider ----------------------------------------------------

  async readFile(path: string): Promise<string> {
    const target = this.classify(path);
    if (target.kind === "session") {
      const content = await this.options.sessionState.read(this.options.sessionKey, target.path);
      if (content === undefined) throw fsError("ENOENT", path);
      return content;
    }
    if (this.isProjectDir(target.rel) && !this.isInput(target.rel)) throw fsError("EISDIR", path);
    const content = await this.readProject(target.rel);
    if (content === undefined) throw fsError("ENOENT", path);
    return content;
  }

  async writeFile(path: string, content: string): Promise<void> {
    const target = this.classify(path);
    if (target.kind === "session") return this.options.sessionState.write(this.options.sessionKey, target.path, content);
    if (this.isInput(target.rel)) throw fsError("EACCES", `${target.rel} is read-only caller input.`);
    await this.writeProject(target.rel, content, "file_tool");
  }

  async appendFile(path: string, content: string): Promise<void> {
    const target = this.classify(path);
    if (target.kind === "session") return this.options.sessionState.append(this.options.sessionKey, target.path, content);
    const current = await this.readProject(target.rel);
    await this.writeProject(target.rel, (current ?? "") + content, "file_tool");
  }

  async exists(path: string): Promise<boolean> {
    const target = this.classify(path);
    if (target.kind === "session") {
      return (await this.options.sessionState.read(this.options.sessionKey, target.path)) !== undefined || this.isSessionDir(target.path);
    }
    if (this.isInput(target.rel) || this.listing.has(target.rel) || this.writes.has(target.rel)) return true;
    if (this.isProjectDir(target.rel)) return true;
    return (await this.readProject(target.rel)) !== undefined;
  }

  async stat(path: string): Promise<{ isFile: boolean; isDirectory: boolean; size: number; mtime: string; birthtime: string }> {
    const now = new Date().toISOString();
    const file = (size: number) => ({ isFile: true, isDirectory: false, size, mtime: now, birthtime: now });
    const dir = { isFile: false, isDirectory: true, size: 0, mtime: now, birthtime: now };
    const target = this.classify(path);
    if (target.kind === "session") {
      const content = await this.options.sessionState.read(this.options.sessionKey, target.path);
      if (content !== undefined) return file(Buffer.byteLength(content));
      if (await this.isSessionDir(target.path)) return dir;
      throw fsError("ENOENT", path);
    }
    if (this.isInput(target.rel)) return file(Buffer.byteLength(this.options.inputs[target.rel]));
    if (!this.listing.has(target.rel) && !this.writes.has(target.rel) && this.isProjectDir(target.rel)) return dir;
    const content = await this.readProject(target.rel);
    if (content === undefined) throw fsError("ENOENT", path);
    return file(Buffer.byteLength(content));
  }

  async mkdir(path: string, _recursive = true): Promise<void> {
    const target = this.classify(path);
    if (target.kind === "session") {
      for (const ancestor of [...ancestors(target.path), target.path]) if (ancestor) this.sessionDirs.add(ancestor);
      return;
    }
    if (this.isProjectDir(target.rel)) return;
    if (!this.options.writeScope.prefixes.some((prefix) => `${target.rel}/`.startsWith(prefix))) {
      this.refusals.push(`Directory outside the stage write scope refused: ${target.rel}`);
      throw fsError("EACCES", `${target.rel} is outside this stage's write scope.`);
    }
    this.projectDirs.add(target.rel);
  }

  async readdir(path: string): Promise<string[]> {
    return (await this.readdirWithTypes(path)).map((entry) => entry.name);
  }

  async readdirWithTypes(path: string): Promise<{ name: string; type: "file" | "directory" }[]> {
    const target = this.classify(path);
    if (target.kind === "session") {
      if (!(await this.isSessionDir(target.path))) throw fsError("ENOENT", path);
      return this.children(target.path, await this.sessionPaths(), [...this.sessionDirs]);
    }
    if (!this.isProjectDir(target.rel)) throw fsError("ENOTDIR", path);
    const dirs = [...this.projectDirs, ...this.options.writeScope.exactPaths.flatMap(ancestors)];
    return this.children(target.rel, this.knownFiles(), dirs);
  }

  async rm(path: string, recursive: boolean, force: boolean): Promise<void> {
    const target = this.classify(path);
    if (target.kind === "project") {
      this.refusals.push(`Deleting project content refused: ${target.rel}`);
      throw fsError("EACCES", "Project files cannot be deleted from a stage.");
    }
    const stored = await this.sessionPaths();
    const victims = stored.filter((entry) => entry === target.path || (recursive && entry.startsWith(`${target.path}/`)));
    if (victims.length === 0 && !force && !(await this.isSessionDir(target.path))) throw fsError("ENOENT", path);
    for (const victim of victims) await this.options.sessionState.remove(this.options.sessionKey, victim);
    for (const dir of [...this.sessionDirs]) if (dir === target.path || dir.startsWith(`${target.path}/`)) this.sessionDirs.delete(dir);
  }

  async rename(src: string, dest: string): Promise<void> {
    const from = this.classify(src);
    const to = this.classify(dest);
    if (from.kind !== "session" || to.kind !== "session") {
      this.refusals.push(`Renaming project content refused: ${src} -> ${dest}`);
      throw fsError("EACCES", "Project files cannot be renamed from a stage.");
    }
    const content = await this.options.sessionState.read(this.options.sessionKey, from.path);
    if (content === undefined) throw fsError("ENOENT", src);
    await this.options.sessionState.write(this.options.sessionKey, to.path, content);
    await this.options.sessionState.remove(this.options.sessionKey, from.path);
  }
}
