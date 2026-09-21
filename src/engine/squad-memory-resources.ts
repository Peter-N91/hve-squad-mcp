/**
 * Shared squad-memory MCP resource provider (shared-state broker — DR-01 / DR-10).
 *
 * Maps the `squad-memory://` URI scheme onto a {@link SquadMemoryStore} so the
 * SAME read surface serves BOTH transports:
 *   * stdio (`src/server.ts`) — inside the local trust boundary, keyed on the
 *     {@link LOCAL_MEMORY_TENANT} sentinel.
 *   * HTTP (`src/transports/http-core.ts`) — keyed on the authenticated
 *     `tenantId` from the validated Entra token (never caller input; SEC-3).
 *
 * MCP resources are READ-ONLY (write-back is the `squad_memory_write` tool doing
 * CAS — a later phase); the provider therefore exposes only `list` / `read` plus
 * the RFC 6570 `templates` families and never mutates the store.
 *
 * URI scheme (tenant IMPLICIT — never encoded in the URI, so a caller can never
 * name a foreign tenant):
 *   * `squad-memory://<project>/state`
 *   * `squad-memory://<project>/decisions`
 *   * `squad-memory://<project>/history/<agent>`
 *   * `squad-memory://<project>/repo-memory/<name>`
 *
 * SEC-4 — every `project` / `path` parsed out of a URI is re-validated with the
 * Phase 1 {@link isSafeMemorySegment} / {@link isSafeMemoryPath} guards before it
 * reaches the store, so a traversal payload can never escape its partition. An
 * unknown/malformed URI AND a missing entry surface the SAME generic
 * {@link McpError} (no detail that could enumerate another tenant's memory —
 * DR-01 no-leakage).
 */
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

import {
  isSafeMemoryPath,
  isSafeMemorySegment,
  type SquadMemoryStore,
} from "./squad-memory-state.js";
import { PROJECT_CONTEXT_REGISTRY_PATH } from "./project-context-bridge.js";

/** The custom URI scheme the broker publishes memory resources under. */
export const SQUAD_MEMORY_URI_SCHEME = "squad-memory";

/** The `squad-memory://` prefix every memory resource URI carries. */
const SCHEME_PREFIX = `${SQUAD_MEMORY_URI_SCHEME}://`;

/**
 * The tenant sentinel used on the stdio transport. stdio is inside the local
 * user's trust boundary (no Entra token to resolve a tenant from), so its memory
 * is namespaced under this single local tenant rather than a real tenant id.
 */
export const LOCAL_MEMORY_TENANT = "local";

/** The MIME type reported for squad memory + history (markdown documents). */
export const SQUAD_MEMORY_MIME_TYPE = "text/markdown";

/**
 * RFC 6570 template for the per-agent session-history family. Phase 3 + Phase 6
 * wire against this constant; the `{project}` / `{agent}` variables expand to a
 * concrete `squad-memory://<project>/history/<agent>` URI.
 */
export const SQUAD_MEMORY_HISTORY_URI_TEMPLATE = `${SCHEME_PREFIX}{project}/history/{agent}`;

/**
 * RFC 6570 template for the repository-memory family (e.g. `repo-memory/squad-<agent>`).
 * `{project}` / `{name}` expand to a concrete `squad-memory://<project>/repo-memory/<name>` URI.
 */
export const SQUAD_MEMORY_REPO_MEMORY_URI_TEMPLATE = `${SCHEME_PREFIX}{project}/repo-memory/{name}`;

/**
 * The single generic message returned for an unknown/malformed URI OR a missing
 * entry. Kept identical for both so a caller cannot distinguish "does not exist"
 * from "not accessible" and enumerate memory (DR-01 no-leakage).
 */
const UNRESOLVED_URI_MESSAGE = "Unknown or inaccessible resource URI.";

/** One MCP resource descriptor (the `resources/list` element shape). */
export interface MemoryResourceDescriptor {
  /** The addressable `squad-memory://<project>/<path>` URI. */
  readonly uri: string;
  /** A short human-readable name (`<project>/<path>`). */
  readonly name: string;
  /** A one-line description of the entry's role. */
  readonly description: string;
  /** The content MIME type. */
  readonly mimeType: string;
}

/** One MCP resource-template descriptor (the `resources/templates/list` element shape). */
export interface MemoryResourceTemplateDescriptor {
  /** The RFC 6570 URI template. */
  readonly uriTemplate: string;
  /** A short human-readable name. */
  readonly name: string;
  /** A one-line description of the family. */
  readonly description: string;
  /** The content MIME type of the resolved resources. */
  readonly mimeType: string;
}

/** The `resources/read` result shape (a single text content block). */
export interface MemoryResourceReadResult {
  readonly contents: {
    readonly uri: string;
    readonly mimeType: string;
    readonly text: string;
  }[];
}

/** A parsed `squad-memory://<project>/<path>` URI (tenant is never in the URI). */
interface ParsedMemoryUri {
  readonly project: string;
  readonly path: string;
}

/**
 * Parse and re-validate a `squad-memory://` URI. Returns `undefined` for any URI
 * that is not this scheme, is missing a project/path, or carries an unsafe
 * segment (SEC-4) — the caller surfaces those as a single generic error.
 */
function parseMemoryUri(uri: string): ParsedMemoryUri | undefined {
  if (!uri.startsWith(SCHEME_PREFIX)) {
    return undefined;
  }
  const rest = uri.slice(SCHEME_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) {
    return undefined;
  }
  const project = rest.slice(0, slash);
  const path = rest.slice(slash + 1);
  if (
    path.length === 0 ||
    path === PROJECT_CONTEXT_REGISTRY_PATH ||
    !isSafeMemorySegment(project) ||
    !isSafeMemoryPath(path)
  ) {
    return undefined;
  }
  return { project, path };
}

/** A one-line description keyed on the memory path family. */
function describePath(project: string, path: string): string {
  if (path === "state") {
    return `Current working state for project '${project}'.`;
  }
  if (path === "decisions") {
    return `Recorded decisions for project '${project}'.`;
  }
  if (path.startsWith("history/")) {
    return `Session history for agent '${path.slice("history/".length)}' in project '${project}'.`;
  }
  if (path.startsWith("repo-memory/")) {
    return `Repository memory '${path.slice("repo-memory/".length)}' for project '${project}'.`;
  }
  return `Squad memory entry '${path}' for project '${project}'.`;
}

/** Build a `resources/list` descriptor for a concrete `project`/`path` entry. */
function toDescriptor(project: string, path: string): MemoryResourceDescriptor {
  return {
    uri: `${SCHEME_PREFIX}${project}/${path}`,
    name: `${project}/${path}`,
    description: describePath(project, path),
    mimeType: SQUAD_MEMORY_MIME_TYPE,
  };
}

/**
 * The transport-agnostic memory read surface. Every method takes `tenantId`
 * FIRST — the isolation key is supplied by the transport (a validated token on
 * HTTP, the local sentinel on stdio) and is NEVER derived from the URI or any
 * other caller input.
 */
export class SquadMemoryResourceProvider {
  private readonly store: SquadMemoryStore;

  constructor(store: SquadMemoryStore) {
    this.store = store;
  }

  /**
   * List every stored memory resource for a tenant across all of its projects
   * (`state`, `decisions`, `history/<agent>`, `repo-memory/<name>`). Only entries
   * that actually exist are returned — the templates cover the open-ended families.
   */
  async list(tenantId: string): Promise<MemoryResourceDescriptor[]> {
    const projects = await this.store.listProjects(tenantId);
    const perProject = await Promise.all(
      projects.map((project) => this.store.list(tenantId, project)),
    );
    const descriptors: MemoryResourceDescriptor[] = [];
    projects.forEach((project, index) => {
      for (const entry of perProject[index]) {
        if (entry.path !== PROJECT_CONTEXT_REGISTRY_PATH) {
          descriptors.push(toDescriptor(project, entry.path));
        }
      }
    });
    return descriptors;
  }

  /**
   * Read one memory resource by URI, scoped to `tenantId`. Throws a single
   * generic {@link McpError} for an unknown/malformed URI OR a missing entry so a
   * caller cannot distinguish the two (DR-01 no-leakage).
   */
  async read(tenantId: string, uri: string): Promise<MemoryResourceReadResult> {
    const parsed = parseMemoryUri(uri);
    if (!parsed) {
      throw new McpError(ErrorCode.InvalidParams, UNRESOLVED_URI_MESSAGE);
    }
    const entry = await this.store.read(tenantId, parsed.project, parsed.path);
    if (!entry) {
      throw new McpError(ErrorCode.InvalidParams, UNRESOLVED_URI_MESSAGE);
    }
    return {
      contents: [{ uri, mimeType: SQUAD_MEMORY_MIME_TYPE, text: entry.content }],
    };
  }

  /**
   * The RFC 6570 templates for the open-ended memory families. Static metadata
   * (no store read, no tenant) describing how a caller composes a concrete
   * `history/<agent>` or `repo-memory/<name>` URI.
   */
  templates(): MemoryResourceTemplateDescriptor[] {
    return [
      {
        uriTemplate: SQUAD_MEMORY_HISTORY_URI_TEMPLATE,
        name: "Squad agent history",
        description: "Per-agent session history within a project.",
        mimeType: SQUAD_MEMORY_MIME_TYPE,
      },
      {
        uriTemplate: SQUAD_MEMORY_REPO_MEMORY_URI_TEMPLATE,
        name: "Squad repository memory",
        description: "Named repository-scoped memory within a project.",
        mimeType: SQUAD_MEMORY_MIME_TYPE,
      },
    ];
  }
}

/** The callback the registry invokes to emit a `notifications/resources/updated`. */
export type MemoryResourceUpdateNotifier = (uri: string) => void | Promise<void>;

/**
 * A tiny in-process subscription registry for live resource push (WI-01, stdio
 * ONLY — CON-1: the HTTP transport is POST-only, so `notifications/*` cannot be
 * delivered to Copilot Studio; that path stays poll-on-read).
 *
 * It tracks the set of `squad-memory://` URIs a connected client asked to watch
 * via `resources/subscribe` and exposes a single {@link onWrite} hook a mutation
 * path calls. When the mutated URI is subscribed, it invokes the injected
 * {@link MemoryResourceUpdateNotifier} EXACTLY ONCE (wired in `src/server.ts` to
 * `Server.sendResourceUpdated`), so a subscriber is refreshed without re-polling.
 *
 * Transport-agnostic and reusable by design: the write path that calls
 * {@link onWrite} is supplied by the caller, so a future stdio write tool and the
 * Phase 4 `squad_memory_sync` batch CAS tool can both trigger the same hook
 * without this module depending on either existing yet.
 */
export class SquadMemorySubscriptionRegistry {
  private readonly subscribed = new Set<string>();
  private readonly notify: MemoryResourceUpdateNotifier;

  constructor(notify: MemoryResourceUpdateNotifier) {
    this.notify = notify;
  }

  /** Record interest in a URI (idempotent — a Set collapses duplicate subscribes). */
  subscribe(uri: string): void {
    this.subscribed.add(uri);
  }

  /** Drop interest in a URI (idempotent — unsubscribing an unknown URI is a no-op). */
  unsubscribe(uri: string): void {
    this.subscribed.delete(uri);
  }

  /** True when a client currently holds a subscription for `uri`. */
  isSubscribed(uri: string): boolean {
    return this.subscribed.has(uri);
  }

  /**
   * The hook a memory mutation path calls AFTER a write commits. Emits a single
   * update notification for `uri` only when it is subscribed; an unwatched URI (or
   * no subscriptions at all) is a silent no-op, so a write never notifies a client
   * that did not ask for it.
   */
  async onWrite(uri: string): Promise<void> {
    if (this.subscribed.has(uri)) {
      await this.notify(uri);
    }
  }
}
