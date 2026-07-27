/**
 * Microsoft Graph drive realization of the {@link SquadMemoryStore} seam —
 * squad memory persisted to **SharePoint** (a document library) or **OneDrive**
 * instead of Azure Table / local disk.
 *
 * Motivation: the shipped broker could only persist to Azure (a Table partition or
 * a local directory). Teams that already govern their knowledge in SharePoint want
 * the squad's state, decisions, and per-agent history to land there — reviewable,
 * versioned, searchable, and subject to their existing retention and DLP policy.
 * Because the store seam takes `tenantId` first and speaks list/read/write/CAS,
 * a Graph drive slots in with no change to the resource surface or the memory
 * tools.
 *
 * Layout — one markdown file per memory entry:
 *
 *     <rootPath>/<tenantId>/<project>/<path>.md
 *
 * The `tenantId` prefix is the isolation key and is ALWAYS supplied by the caller
 * from the validated Entra token, never from tool input (SEC-3). Every segment is
 * re-validated with the Phase 1 traversal guards before it reaches a URL, so a
 * `..` payload can never escape the configured root (SEC-4).
 *
 * Concurrency: Graph gives DriveItems a native `eTag`, and `PUT .../content`
 * honours `If-Match`, which maps exactly onto the seam's compare-and-swap
 * contract — a stale token yields HTTP 412 and is surfaced as a conflict rather
 * than a silent clobber, identical to the Table backend's behavior.
 *
 * Encryption: the Table and file backends encrypt `content` at rest (MEDIUM-3).
 * That is deliberately OPT-IN here and defaults to OFF, because the entire point
 * of a SharePoint target is that a human can open the file. An operator that wants
 * ciphertext in SharePoint passes a real {@link FieldCipher}; the trade-off is
 * documented rather than silently chosen.
 *
 * Auth: an app-only Graph bearer token (`https://graph.microsoft.com/.default`)
 * obtained from the same managed-identity credential the other backends use. The
 * token is registered with the redacting logger so it can never surface in a log
 * line (SEC-10).
 */
import {
  isSafeMemoryPath,
  isSafeMemorySegment,
  type SquadMemoryEntry,
  type SquadMemoryStore,
  type SquadMemoryWriteResult,
} from "../squad-memory-state.js";
import { NullFieldCipher, type FieldCipher } from "../field-cipher.js";
import type { RedactingLogger } from "../../observability/logger.js";

/** The default Graph endpoint (overridable for sovereign clouds / tests). */
export const DEFAULT_GRAPH_ENDPOINT = "https://graph.microsoft.com/v1.0";

/** The file extension every memory entry is stored under (human-readable). */
const ENTRY_EXTENSION = ".md";

export interface GraphSquadMemoryStoreOptions {
  /**
   * The target drive id — a SharePoint document library's drive, or a OneDrive.
   * Operator-configured; never caller input.
   */
  driveId: string;
  /**
   * Folder within the drive that roots all squad memory (e.g. `squad-memory`).
   * Empty means the drive root. Each segment is shape-checked at construction.
   */
  rootPath?: string;
  /** Returns a fresh Graph bearer token (`https://graph.microsoft.com/.default`). */
  getAccessToken: () => Promise<string>;
  /** Optional field cipher; DEFAULT IS PLAINTEXT (see the module note). */
  cipher?: FieldCipher;
  /** Injectable fetch (default: global fetch). */
  fetchImpl?: typeof fetch;
  /** Logger used to register the bearer token as a secret (SEC-10). */
  logger?: RedactingLogger;
  /** Override the Graph endpoint (default {@link DEFAULT_GRAPH_ENDPOINT}). */
  endpoint?: string;
}

/** The subset of a Graph DriveItem this store consumes. */
interface DriveItem {
  name?: string;
  eTag?: string;
  lastModifiedDateTime?: string;
  folder?: unknown;
  file?: unknown;
}

interface DriveChildren {
  value?: DriveItem[];
  "@odata.nextLink"?: string;
}

/** Percent-encode one path segment for Graph's `root:/<path>:` addressing. */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment);
}

/** Epoch ms for a Graph ISO timestamp; 0 when absent/unparseable. */
function toEpoch(iso: string | undefined): number {
  if (!iso) {
    return 0;
  }
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : 0;
}

export class GraphSquadMemoryStore implements SquadMemoryStore {
  private readonly driveId: string;
  private readonly rootSegments: string[];
  private readonly getAccessToken: () => Promise<string>;
  private readonly cipher: FieldCipher;
  private readonly fetchImpl: typeof fetch;
  private readonly logger?: RedactingLogger;
  private readonly endpoint: string;

  constructor(options: GraphSquadMemoryStoreOptions) {
    if (!options.driveId || options.driveId.trim().length === 0) {
      throw new Error("GraphSquadMemoryStore requires a driveId (the SharePoint/OneDrive drive).");
    }
    this.driveId = options.driveId.trim();
    this.rootSegments = (options.rootPath ?? "")
      .split("/")
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0);
    // Fail fast on a misconfigured root rather than emitting a traversal URL.
    for (const segment of this.rootSegments) {
      if (!isSafeMemorySegment(segment)) {
        throw new Error(`GraphSquadMemoryStore rootPath segment "${segment}" is not a safe path segment.`);
      }
    }
    this.getAccessToken = options.getAccessToken;
    this.cipher = options.cipher ?? new NullFieldCipher();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger;
    this.endpoint = (options.endpoint ?? DEFAULT_GRAPH_ENDPOINT).replace(/\/$/, "");
  }

  private async headers(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    const token = await this.getAccessToken();
    this.logger?.registerSecret(token);
    return { Authorization: `Bearer ${token}`, Accept: "application/json", ...extra };
  }

  /** `<endpoint>/drives/<driveId>/root:/<encoded path>` (or `/root` at the root). */
  private itemUrl(segments: string[], suffix = ""): string {
    const base = `${this.endpoint}/drives/${encodeURIComponent(this.driveId)}`;
    if (segments.length === 0) {
      return suffix ? `${base}/root/${suffix.replace(/^\//, "")}` : `${base}/root`;
    }
    const path = segments.map(encodeSegment).join("/");
    return suffix ? `${base}/root:/${path}:/${suffix.replace(/^\//, "")}` : `${base}/root:/${path}`;
  }

  /**
   * Resolve the drive-relative segments for one entry, or `undefined` when any
   * component fails its shape check. Returning `undefined` (rather than throwing)
   * keeps the SEC-4 guard indistinguishable from "not found" at the caller, so a
   * traversal probe cannot be used to enumerate the drive.
   */
  private segmentsFor(tenantId: string, project: string, path: string): string[] | undefined {
    if (!isSafeMemorySegment(tenantId) || !isSafeMemorySegment(project) || !isSafeMemoryPath(path)) {
      return undefined;
    }
    const parts = path.split("/");
    const last = `${parts[parts.length - 1]}${ENTRY_EXTENSION}`;
    return [...this.rootSegments, tenantId, project, ...parts.slice(0, -1), last];
  }

  /** Folder segments for a tenant's project partition. */
  private projectSegments(tenantId: string, project: string): string[] | undefined {
    if (!isSafeMemorySegment(tenantId) || !isSafeMemorySegment(project)) {
      return undefined;
    }
    return [...this.rootSegments, tenantId, project];
  }

  async read(tenantId: string, project: string, path: string): Promise<SquadMemoryEntry | undefined> {
    const segments = this.segmentsFor(tenantId, project, path);
    if (!segments) {
      return undefined;
    }
    const metaResponse = await this.fetchImpl(this.itemUrl(segments), {
      method: "GET",
      headers: await this.headers(),
    });
    if (metaResponse.status === 404) {
      return undefined;
    }
    if (!metaResponse.ok) {
      throw new Error(`Graph item read failed with status ${metaResponse.status}.`);
    }
    const item = (await metaResponse.json()) as DriveItem;

    const contentResponse = await this.fetchImpl(this.itemUrl(segments, "content"), {
      method: "GET",
      headers: await this.headers(),
    });
    if (contentResponse.status === 404) {
      return undefined;
    }
    if (!contentResponse.ok) {
      throw new Error(`Graph content read failed with status ${contentResponse.status}.`);
    }
    const stored = await contentResponse.text();

    return {
      tenantId,
      project,
      path,
      content: this.cipher.decrypt(stored),
      etag: item.eTag ?? "",
      updatedAt: toEpoch(item.lastModifiedDateTime),
    };
  }

  async write(
    tenantId: string,
    project: string,
    path: string,
    content: string,
    expectedEtag?: string,
  ): Promise<SquadMemoryWriteResult> {
    const segments = this.segmentsFor(tenantId, project, path);
    if (!segments) {
      // Treat an unsafe key as a lost race rather than a write to a wrong location.
      return { ok: false, conflict: true, current: undefined };
    }
    // `If-Match` gives the CAS; omitting it is the unconditional first-write /
    // overwrite the seam specifies. Graph creates missing parent folders for a
    // `root:/path:/content` upload, so no explicit mkdir is needed.
    const headers = await this.headers({
      "Content-Type": "text/markdown",
      ...(expectedEtag ? { "If-Match": expectedEtag } : {}),
    });
    const response = await this.fetchImpl(this.itemUrl(segments, "content"), {
      method: "PUT",
      headers,
      body: this.cipher.encrypt(content),
    });

    if (response.status === 412 || response.status === 409) {
      // Lost the compare-and-swap: hand back the entry the caller lost to so it
      // can re-read and retry (never a silent clobber).
      const current = await this.read(tenantId, project, path).catch(() => undefined);
      return { ok: false, conflict: true, current };
    }
    if (!response.ok) {
      throw new Error(`Graph write failed with status ${response.status}.`);
    }
    const item = (await response.json()) as DriveItem;
    const etag = item.eTag ?? "";
    return {
      ok: true,
      etag,
      entry: {
        tenantId,
        project,
        path,
        content,
        etag,
        updatedAt: toEpoch(item.lastModifiedDateTime) || Date.now(),
      },
    };
  }

  async list(tenantId: string, project: string): Promise<SquadMemoryEntry[]> {
    const root = this.projectSegments(tenantId, project);
    if (!root) {
      return [];
    }
    const entries: SquadMemoryEntry[] = [];
    // Depth-first walk so nested families (`history/<agent>`, `repo-memory/<name>`)
    // are enumerated, not just the top level.
    const stack: { segments: string[]; logical: string[] }[] = [{ segments: root, logical: [] }];
    while (stack.length > 0) {
      const current = stack.pop() as { segments: string[]; logical: string[] };
      const children = await this.children(current.segments);
      for (const child of children) {
        const name = child.name ?? "";
        if (name.length === 0) {
          continue;
        }
        if (child.folder) {
          stack.push({ segments: [...current.segments, name], logical: [...current.logical, name] });
          continue;
        }
        if (!name.endsWith(ENTRY_EXTENSION)) {
          // Ignore anything a human dropped into the library that is not ours.
          continue;
        }
        const logicalPath = [...current.logical, name.slice(0, -ENTRY_EXTENSION.length)].join("/");
        entries.push({
          tenantId,
          project,
          path: logicalPath,
          // `list` is a metadata enumeration; content is fetched on demand by
          // `read` (one extra round-trip per entry would be pathological here).
          content: "",
          etag: child.eTag ?? "",
          updatedAt: toEpoch(child.lastModifiedDateTime),
        });
      }
    }
    return entries;
  }

  async listProjects(tenantId: string): Promise<string[]> {
    if (!isSafeMemorySegment(tenantId)) {
      return [];
    }
    const children = await this.children([...this.rootSegments, tenantId]);
    return children
      .filter((child) => Boolean(child.folder) && typeof child.name === "string")
      .map((child) => child.name as string)
      .filter((name) => isSafeMemorySegment(name));
  }

  /** Enumerate a folder's children, following `@odata.nextLink` pagination. */
  private async children(segments: string[]): Promise<DriveItem[]> {
    let url: string | undefined = this.itemUrl(segments, "children");
    const items: DriveItem[] = [];
    while (url) {
      const response: Response = await this.fetchImpl(url, {
        method: "GET",
        headers: await this.headers(),
      });
      if (response.status === 404) {
        // A partition that has never been written simply has no folder yet.
        return items;
      }
      if (!response.ok) {
        throw new Error(`Graph children listing failed with status ${response.status}.`);
      }
      const page = (await response.json()) as DriveChildren;
      items.push(...(page.value ?? []));
      url = page["@odata.nextLink"];
    }
    return items;
  }
}
