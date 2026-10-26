import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { GitHubLinkRecord, GitHubLinkStore, PutResult, StoredGitHubLink } from "./types.js";

/** Process-local store for tests and single-replica development. */
export class InMemoryGitHubLinkStore implements GitHubLinkStore {
  private readonly rows = new Map<string, { record: GitHubLinkRecord; etag: string }>();
  private counter = 0;

  async get(principalKey: string): Promise<StoredGitHubLink | undefined> {
    const row = this.rows.get(principalKey);
    return row ? { record: structuredClone(row.record), etag: row.etag } : undefined;
  }

  async putIfMatch(record: GitHubLinkRecord, expectedEtag: string | undefined): Promise<PutResult> {
    const key = keyOfRecord(record);
    const existing = this.rows.get(key);
    if (expectedEtag === undefined ? existing !== undefined : existing?.etag !== expectedEtag) {
      return { ok: false };
    }
    const etag = `m${++this.counter}`;
    this.rows.set(key, { record: structuredClone(record), etag });
    return { ok: true, etag };
  }

  async delete(principalKey: string, expectedEtag?: string): Promise<boolean> {
    const existing = this.rows.get(principalKey);
    if (!existing || (expectedEtag !== undefined && existing.etag !== expectedEtag)) {
      return false;
    }
    this.rows.delete(principalKey);
    return true;
  }
}

function keyOfRecord(record: GitHubLinkRecord): string {
  return `${record.tenantId}|${record.oid}`;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Entra object ids are GUIDs; anything else is hashed so it can never escape the directory. */
function safeSegment(value: string): string {
  return /^[A-Za-z0-9-]{1,64}$/.test(value) ? value.toLowerCase() : `h-${sha256Hex(value).slice(0, 32)}`;
}

/** On Windows a concurrent reader can briefly hold the target and make rename fail with EPERM/EBUSY. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") || attempt >= 20) {
        await rm(from, { force: true });
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

interface LinkFile {
  etag: string;
  record: GitHubLinkRecord;
}

const LOCK_TIMEOUT_MS = 30_000;

/**
 * File-backed store for single-host deployments. Each principal is one JSON file
 * named `<sha256(tenantId)[0..16]>__<oid>.json` (the tenant id is hashed, the
 * object id is a GUID). Writes go to a temp file then `rename` (atomic), and the
 * compare-and-swap is serialised by an exclusive `.lock` file so two processes on
 * the same host cannot both pass an etag check. Not safe on network file systems.
 * Token fields are already ciphertext (see token-seal.ts).
 */
export class FileGitHubLinkStore implements GitHubLinkStore {
  private static readonly localLocks = new Map<string, Promise<void>>();
  private ready: Promise<void> | undefined;

  constructor(private readonly directory: string) {}

  async get(principalKey: string): Promise<StoredGitHubLink | undefined> {
    await this.ensureDir();
    const file = await this.read(this.pathFor(principalKey));
    return file ? { record: file.record, etag: file.etag } : undefined;
  }

  async putIfMatch(record: GitHubLinkRecord, expectedEtag: string | undefined): Promise<PutResult> {
    await this.ensureDir();
    const path = this.pathFor(keyOfRecord(record));
    return this.withLock(path, async () => {
      const existing = await this.read(path);
      if (expectedEtag === undefined ? existing !== undefined : existing?.etag !== expectedEtag) {
        return { ok: false } as const;
      }
      const etag = randomUUID();
      const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(tmp, JSON.stringify({ etag, record } satisfies LinkFile), { encoding: "utf8", mode: 0o600 });
      await renameWithRetry(tmp, path);
      return { ok: true, etag } as const;
    });
  }

  async delete(principalKey: string, expectedEtag?: string): Promise<boolean> {
    await this.ensureDir();
    const path = this.pathFor(principalKey);
    return this.withLock(path, async () => {
      const existing = await this.read(path);
      if (!existing || (expectedEtag !== undefined && existing.etag !== expectedEtag)) {
        return false;
      }
      await rm(path, { force: true });
      return true;
    });
  }

  /** Exposed for tests and operators who need to locate a row. */
  pathFor(principalKey: string): string {
    const separator = principalKey.indexOf("|");
    const tenantId = separator < 0 ? principalKey : principalKey.slice(0, separator);
    const oid = separator < 0 ? "" : principalKey.slice(separator + 1);
    return join(this.directory, `${sha256Hex(tenantId).slice(0, 16)}__${safeSegment(oid)}.json`);
  }

  private ensureDir(): Promise<void> {
    this.ready ??= mkdir(this.directory, { recursive: true, mode: 0o700 }).then(() => undefined);
    return this.ready;
  }

  private async read(path: string): Promise<LinkFile | undefined> {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
    let parsed: LinkFile;
    try { parsed = JSON.parse(text) as LinkFile; }
    catch { throw new Error("GitHub link file is malformed."); }
    if (typeof parsed?.etag !== "string" || typeof parsed.record !== "object" || parsed.record === null) {
      throw new Error("GitHub link file is malformed.");
    }
    return parsed;
  }

  private async withLock<T>(path: string, action: () => Promise<T>): Promise<T> {
    const previous = FileGitHubLinkStore.localLocks.get(path) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const queued = previous.then(() => gate);
    FileGitHubLinkStore.localLocks.set(path, queued);
    await previous;
    try {
      return await this.withFileLock(path, action);
    } finally {
      release();
      if (FileGitHubLinkStore.localLocks.get(path) === queued) FileGitHubLinkStore.localLocks.delete(path);
    }
  }

  private async withFileLock<T>(path: string, action: () => Promise<T>): Promise<T> {
    const lock = `${path}.lock`;
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        const handle = await open(lock, "wx");
        await handle.close();
        break;
      } catch (error) {
        if (!["EEXIST", "EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) {
          throw error;
        }
        // Never steal a live process's lock based on elapsed time. A crashed
        // writer's lock needs operator cleanup after confirming it is stopped.
        if (Date.now() > deadline) {
          throw new Error("Timed out waiting for the GitHub link file lock.");
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    try {
      return await action();
    } finally {
      await rm(lock, { force: true });
    }
  }
}
