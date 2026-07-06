/**
 * Server-allocated ephemeral per-request workspace (SEC-4).
 *
 * Tenant isolation is server-controlled and verifiable:
 *
 *   * Workspace roots are **server-allocated** under the OS temp dir, namespaced
 *     by a hash of the tenant id plus a CSPRNG run id. A caller can neither name
 *     nor predict the path — `request`/`context` never contribute to it.
 *   * `resolve()` confines every path to the workspace root: any `..` traversal
 *     or absolute path that would escape the root throws, so an injected path in
 *     a tool input cannot reach another tenant's workspace or the host FS.
 *   * `dispose()` guarantees teardown (recursive remove, idempotent, error-safe)
 *     so it can run in a `finally` even after a failed or timed-out run.
 *   * Every `allocate()` returns a fresh unique directory — there is no shared
 *     mutable state across tenants or across calls.
 *
 * The thin slice's hero tool does inference plus file/memory work inside this
 * directory ONLY; it never spawns a shell or process (SEC-7, enforced in the
 * embedded engine).
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

/** A single isolated, server-allocated workspace for one request. */
export interface Workspace {
  /** Unguessable run id (also the leaf directory name). */
  readonly id: string;
  /** The owning tenant — the isolation key. */
  readonly tenantId: string;
  /** The absolute workspace root (server-allocated; never caller-influenced). */
  readonly root: string;
  /**
   * Resolve a relative path INSIDE the workspace. Throws if the result would
   * escape the root (path-traversal / absolute-path containment, SEC-4).
   */
  resolve(relativePath: string): string;
  /** Remove the workspace and all contents. Idempotent and error-safe. */
  dispose(): Promise<void>;
}

/** Allocates {@link Workspace}s. `kind` marks whether state survives a restart. */
export interface WorkspaceManager {
  readonly kind: "ephemeral" | "durable";
  allocate(tenantId: string): Promise<Workspace>;
}

/** Stable, non-reversible per-tenant directory namespace (keeps the raw tenant id off the path). */
function tenantNamespace(tenantId: string): string {
  return createHash("sha256").update(tenantId).digest("hex").slice(0, 16);
}

class EphemeralWorkspace implements Workspace {
  constructor(
    readonly id: string,
    readonly tenantId: string,
    readonly root: string,
  ) {}

  resolve(relativePath: string): string {
    if (isAbsolute(relativePath)) {
      throw new Error("Workspace paths must be relative (SEC-4: containment).");
    }
    const candidate = resolve(this.root, relativePath);
    if (candidate !== this.root && !candidate.startsWith(this.root + sep)) {
      throw new Error("Path escapes the workspace root (SEC-4: containment).");
    }
    return candidate;
  }

  async dispose(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }
}

export interface EphemeralWorkspaceManagerOptions {
  /** Base directory for all workspaces (default: OS temp dir). */
  baseDir?: string;
}

/** Allocates fresh, isolated, ephemeral workspaces under the OS temp dir. */
export class EphemeralWorkspaceManager implements WorkspaceManager {
  readonly kind = "ephemeral" as const;
  private readonly baseDir: string;

  constructor(options: EphemeralWorkspaceManagerOptions = {}) {
    this.baseDir = options.baseDir ?? join(tmpdir(), "squad-mcp-workspaces");
  }

  async allocate(tenantId: string): Promise<Workspace> {
    if (!tenantId || tenantId.length === 0) {
      throw new Error("A tenant id is required to allocate a workspace (SEC-4).");
    }
    const id = randomUUID();
    const root = join(this.baseDir, tenantNamespace(tenantId), id);
    await mkdir(root, { recursive: true });
    return new EphemeralWorkspace(id, tenantId, root);
  }
}
