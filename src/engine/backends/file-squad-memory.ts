/**
 * File-backed squad-memory store (shared-state broker — file backend).
 *
 * The dev / single-replica realization of
 * {@link import("../squad-memory-state.js").SquadMemoryStore}, mirroring
 * {@link import("../durable-run-state.js").DurableRunStateStore}: it persists each
 * entry as a JSON envelope under `<memoryDir>/<tenantId>/<project>/<path>.json`
 * and carries an in-file `etag` (a version + content hash) so its compare-and-swap
 * behaves like the table store's ETag CAS. It survives process restarts but is
 * SINGLE-REPLICA (no cross-process atomicity); a multi-replica deployment uses the
 * {@link import("./azure-table-squad-memory.js").AzureTableSquadMemoryStore}.
 *
 * Security posture:
 *   * Tenant isolation — the on-disk layout is rooted at `<memoryDir>/<tenantId>`,
 *     so an entry is physically namespaced by the authenticated tenant.
 *   * SEC-4 — `tenantId` / `project` / `path` are validated as safe segments and
 *     the resolved file path is verified to stay within the project directory, so
 *     a traversal payload (`..`) can never reach outside the memory root.
 *   * MEDIUM-3 — `content` is encrypted at rest with the injected
 *     {@link FieldCipher} and decrypted on read, exactly as the durable run-state
 *     store protects `request`/`context`.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

import {
  isSafeMemoryPath,
  isSafeMemorySegment,
  type SquadMemoryEntry,
  type SquadMemoryStore,
  type SquadMemoryWriteResult,
} from "../squad-memory-state.js";
import { NullFieldCipher, type FieldCipher } from "../field-cipher.js";

/** The suffix every persisted memory envelope carries on disk. */
const ENVELOPE_SUFFIX = ".json";

export interface FileSquadMemoryStoreOptions {
  /** Base directory for memory documents (operator config `memoryDir`). */
  baseDir: string;
  /**
   * Field cipher for `content` at rest (default identity). Wire
   * {@link AesGcmFieldCipher} to make the caller's text opaque on disk (MEDIUM-3).
   */
  cipher?: FieldCipher;
}

/** The on-disk envelope for one memory entry (content sealed by the cipher). */
interface MemoryEnvelope {
  project: string;
  path: string;
  /** Sealed content (identity cipher = plaintext). */
  content?: string;
  /** The CAS token (version + content hash). */
  etag: string;
  /** Monotonic write counter (guarantees a fresh etag even for identical content). */
  version: number;
  updatedAt: number;
}

export class FileSquadMemoryStore implements SquadMemoryStore {
  private readonly baseDir: string;
  private readonly cipher: FieldCipher;

  constructor(options: FileSquadMemoryStoreOptions) {
    this.baseDir = resolve(options.baseDir);
    this.cipher = options.cipher ?? new NullFieldCipher();
    mkdirSync(this.baseDir, { recursive: true });
  }

  /** The project directory, or `undefined` when a segment is unsafe. */
  private projectDir(tenantId: string, project: string): string | undefined {
    if (!isSafeMemorySegment(tenantId) || !isSafeMemorySegment(project)) {
      return undefined;
    }
    return join(this.baseDir, tenantId, project);
  }

  /**
   * The envelope file for an entry, or `undefined` when a segment/path is unsafe
   * OR the resolved path escapes the project directory (SEC-4 traversal guard).
   */
  private pathFor(tenantId: string, project: string, path: string): string | undefined {
    const dir = this.projectDir(tenantId, project);
    if (dir === undefined || !isSafeMemoryPath(path)) {
      return undefined;
    }
    const file = resolve(join(dir, `${path}${ENVELOPE_SUFFIX}`));
    // Belt-and-suspenders: even with segment validation, verify containment.
    const dirPrefix = resolve(dir) + sep;
    if (!file.startsWith(dirPrefix)) {
      return undefined;
    }
    return file;
  }

  /** Compute the next CAS etag from the write counter + content. */
  private nextEtag(version: number, content: string): string {
    return createHash("sha256").update(`${version}:${content}`).digest("hex").slice(0, 32);
  }

  /** Read + decrypt the envelope at a file path (undefined when absent/corrupt). */
  private readEnvelope(file: string): MemoryEnvelope | undefined {
    if (!existsSync(file)) {
      return undefined;
    }
    try {
      const envelope = JSON.parse(readFileSync(file, "utf8")) as MemoryEnvelope;
      return { ...envelope, content: this.cipher.decrypt(envelope.content ?? "") };
    } catch {
      return undefined;
    }
  }

  list(tenantId: string, project: string): Promise<SquadMemoryEntry[]> {
    const dir = this.projectDir(tenantId, project);
    if (dir === undefined || !existsSync(dir)) {
      return Promise.resolve([]);
    }
    const entries: SquadMemoryEntry[] = [];
    for (const file of this.walk(dir)) {
      const envelope = this.readEnvelope(file);
      if (envelope) {
        entries.push({
          tenantId,
          project,
          path: envelope.path,
          content: envelope.content ?? "",
          etag: envelope.etag,
          updatedAt: envelope.updatedAt,
        });
      }
    }
    return Promise.resolve(entries);
  }

  read(tenantId: string, project: string, path: string): Promise<SquadMemoryEntry | undefined> {
    const file = this.pathFor(tenantId, project, path);
    if (file === undefined) {
      return Promise.resolve(undefined);
    }
    const envelope = this.readEnvelope(file);
    if (!envelope) {
      return Promise.resolve(undefined);
    }
    return Promise.resolve({
      tenantId,
      project,
      path: envelope.path,
      content: envelope.content ?? "",
      etag: envelope.etag,
      updatedAt: envelope.updatedAt,
    });
  }

  write(
    tenantId: string,
    project: string,
    path: string,
    content: string,
    expectedEtag?: string,
  ): Promise<SquadMemoryWriteResult> {
    const file = this.pathFor(tenantId, project, path);
    if (file === undefined) {
      // A malformed key never touches disk; treat as a lost race (no leakage).
      return Promise.resolve({ ok: false, conflict: true, current: undefined });
    }
    const existing = this.readEnvelope(file);
    if (expectedEtag !== undefined && (existing === undefined || existing.etag !== expectedEtag)) {
      // CAS lost: the caller's expected revision no longer matches (or is gone).
      const current =
        existing === undefined
          ? undefined
          : {
              tenantId,
              project,
              path: existing.path,
              content: existing.content ?? "",
              etag: existing.etag,
              updatedAt: existing.updatedAt,
            };
      return Promise.resolve({ ok: false, conflict: true, current });
    }
    const version = (existing?.version ?? 0) + 1;
    const etag = this.nextEtag(version, content);
    const updatedAt = Date.now();
    const envelope: MemoryEnvelope = {
      project,
      path,
      content: this.cipher.encrypt(content),
      etag,
      version,
      updatedAt,
    };
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(envelope), "utf8");
    return Promise.resolve({
      ok: true,
      etag,
      entry: { tenantId, project, path, content, etag, updatedAt },
    });
  }

  listProjects(tenantId: string): Promise<string[]> {
    if (!isSafeMemorySegment(tenantId)) {
      return Promise.resolve([]);
    }
    const tenantDir = join(this.baseDir, tenantId);
    if (!existsSync(tenantDir)) {
      return Promise.resolve([]);
    }
    let projects: string[];
    try {
      projects = readdirSync(tenantDir).filter((entry) => {
        try {
          return statSync(join(tenantDir, entry)).isDirectory();
        } catch {
          return false;
        }
      });
    } catch {
      return Promise.resolve([]);
    }
    return Promise.resolve(projects);
  }

  /** Recursively yield every envelope file path under a project directory. */
  private *walk(dir: string): Generator<string> {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        yield* this.walk(full);
      } else if (entry.endsWith(ENVELOPE_SUFFIX)) {
        yield full;
      }
    }
  }
}
