/**
 * Durable storage for Copilot runtime session state.
 *
 * With a server-provided session filesystem, the Copilot runtime keeps its
 * conversation log (`events.jsonl`), checkpoints and plan through the server
 * rather than on the sandbox disk. Persisting them here lets a later attempt of
 * the same stage resume the conversation in a brand-new sandbox.
 *
 * This is deliberately separate from the project artifact store: session logs
 * are runtime state, not deliverables, they grow on every turn, and the artifact
 * store truncates oversized content, which would corrupt a log.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface CopilotSessionKey {
  tenantId: string;
  project: string;
  sessionId: string;
}

export interface CopilotSessionStateStore {
  read(key: CopilotSessionKey, path: string): Promise<string | undefined>;
  write(key: CopilotSessionKey, path: string, content: string): Promise<void>;
  append(key: CopilotSessionKey, path: string, content: string): Promise<void>;
  remove(key: CopilotSessionKey, path: string): Promise<void>;
  /** Every stored path for the session. */
  list(key: CopilotSessionKey): Promise<string[]>;
}

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PROJECT = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;

function assertKey(key: CopilotSessionKey): void {
  if (!key.tenantId || !PROJECT.test(key.project) || !SESSION_ID.test(key.sessionId)) {
    throw new Error("Copilot session state requires a tenant, a safe project name and a safe session id.");
  }
}

function assertPath(path: string): void {
  if (!path.startsWith("/") || path.includes("\0") || path.split("/").some((segment) => segment === "..")) {
    throw new Error(`Unsafe session-state path: ${JSON.stringify(path)}.`);
  }
}

/** In-process store for tests and single-run local use. */
export class InMemoryCopilotSessionStateStore implements CopilotSessionStateStore {
  private readonly data = new Map<string, Map<string, string>>();

  private session(key: CopilotSessionKey): Map<string, string> {
    assertKey(key);
    const id = `${key.tenantId}\0${key.project}\0${key.sessionId}`;
    let session = this.data.get(id);
    if (!session) {
      session = new Map();
      this.data.set(id, session);
    }
    return session;
  }

  async read(key: CopilotSessionKey, path: string) { assertPath(path); return this.session(key).get(path); }
  async write(key: CopilotSessionKey, path: string, content: string) { assertPath(path); this.session(key).set(path, content); }
  async append(key: CopilotSessionKey, path: string, content: string) {
    assertPath(path);
    const session = this.session(key);
    session.set(path, (session.get(path) ?? "") + content);
  }
  async remove(key: CopilotSessionKey, path: string) { assertPath(path); this.session(key).delete(path); }
  async list(key: CopilotSessionKey) { return [...this.session(key).keys()].sort(); }
}

/**
 * File-backed store: `<baseDir>/<tenant hash>/<project>/<sessionId>/<encoded path>`.
 * The raw tenant id never appears on disk, and each runtime path maps to one
 * file whose name is its URI-encoded path, so listing needs no separate index.
 */
export class FileCopilotSessionStateStore implements CopilotSessionStateStore {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly baseDir: string) {}

  private dir(key: CopilotSessionKey): string {
    assertKey(key);
    const tenant = createHash("sha256").update(key.tenantId).digest("hex").slice(0, 16);
    return join(this.baseDir, tenant, key.project, key.sessionId);
  }

  private file(key: CopilotSessionKey, path: string): string {
    assertPath(path);
    return join(this.dir(key), encodeURIComponent(path));
  }

  /** Serialize operations per file so concurrent appends are never lost. */
  private serial<T>(file: string, operation: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(file) ?? Promise.resolve()).catch(() => undefined).then(operation);
    this.queues.set(file, next);
    void next.catch(() => undefined).finally(() => { if (this.queues.get(file) === next) this.queues.delete(file); });
    return next;
  }

  private async atomicWrite(file: string, content: string): Promise<void> {
    await mkdir(join(file, ".."), { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, content, "utf8");
    await rename(temp, file);
  }

  async read(key: CopilotSessionKey, path: string): Promise<string | undefined> {
    try {
      return await readFile(this.file(key, path), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async write(key: CopilotSessionKey, path: string, content: string): Promise<void> {
    const file = this.file(key, path);
    return this.serial(file, () => this.atomicWrite(file, content));
  }

  async append(key: CopilotSessionKey, path: string, content: string): Promise<void> {
    const file = this.file(key, path);
    return this.serial(file, async () => {
      const current = await this.read(key, path);
      await this.atomicWrite(file, (current ?? "") + content);
    });
  }

  async remove(key: CopilotSessionKey, path: string): Promise<void> {
    const file = this.file(key, path);
    return this.serial(file, () => rm(file, { force: true }));
  }

  async list(key: CopilotSessionKey): Promise<string[]> {
    try {
      return (await readdir(this.dir(key)))
        .filter((name) => !name.endsWith(".tmp"))
        .map((name) => decodeURIComponent(name))
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}
