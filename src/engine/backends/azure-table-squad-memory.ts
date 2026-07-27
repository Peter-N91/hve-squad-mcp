/**
 * Azure Table Storage squad-memory store (shared-state broker — table backend).
 *
 * The file-backed {@link import("../backends/file-squad-memory.js").FileSquadMemoryStore}
 * survives restarts but is single-replica; Azure Table Storage gives a shared,
 * cross-replica store whose optimistic concurrency (ETag `If-Match`) is a true
 * compare-and-swap. This mirrors
 * {@link import("./azure-table-run-state.js").AzureTableRunStateStore}: it talks
 * to the Table REST API with `fetch` and an INJECTED managed-identity token
 * provider, so there is NO Azure SDK dependency and the build/tests stay SDK-free.
 * It is live-only: wired by `server-http.ts`, never imported by a test.
 *
 * Security posture:
 *   * Tenant isolation — `PartitionKey = <tenantId>:<project>`, so an entry is
 *     physically partitioned by the authenticated tenant; a caller can never read
 *     or write another tenant's partition (the `tenantId` is never caller input).
 *   * SEC-3 — the storage account + table come from operator config, never a
 *     caller; a caller cannot redirect persistence elsewhere.
 *   * SEC-4 — `project` / `path` are re-validated as safe segments before they
 *     build a PartitionKey / RowKey, so a traversal or injection payload cannot
 *     escape the partition.
 *   * SEC-10 — the access token is registered with the logger for redaction and
 *     never logged; error paths never include the response body.
 *   * MEDIUM-3 — `content` is encrypted with the injected {@link FieldCipher}
 *     before it leaves the process, so the caller's text is opaque at rest even to
 *     an operator with raw table access.
 */
import {
  isSafeMemoryPath,
  isSafeMemorySegment,
  type SquadMemoryEntry,
  type SquadMemoryStore,
  type SquadMemoryWriteResult,
} from "../squad-memory-state.js";
import { NullFieldCipher, decryptField, encryptField, type FieldCipher } from "../field-cipher.js";
import type { RedactingLogger } from "../../observability/logger.js";

/** The Table REST API version this client speaks. */
const TABLE_API_VERSION = "2019-02-02";

export interface AzureTableSquadMemoryStoreOptions {
  /** Storage account name (operator config). */
  account: string;
  /** Table name that holds memory records (created out-of-band or on first write). */
  tableName: string;
  /** Returns a fresh Storage bearer token (`https://storage.azure.com/.default`). */
  getAccessToken: () => Promise<string>;
  /** Field cipher for `content` at rest (default identity). */
  cipher?: FieldCipher;
  /** Injectable fetch (default: global fetch). */
  fetchImpl?: typeof fetch;
  /** Logger to register the token as a secret (SEC-10). */
  logger?: RedactingLogger;
  /** Override the table endpoint host (default `<account>.table.core.windows.net`). */
  endpoint?: string;
}

/** The wire shape of a memory entity (flat property bag; Table Storage has no nesting). */
interface MemoryEntity {
  PartitionKey: string;
  RowKey: string;
  project: string;
  path: string;
  /** Encrypted `content` at rest (MEDIUM-3). */
  content?: string;
  updatedAt: number;
  "odata.etag"?: string;
}

export class AzureTableSquadMemoryStore implements SquadMemoryStore {
  private readonly account: string;
  private readonly tableName: string;
  private readonly getAccessToken: () => Promise<string>;
  private readonly cipher: FieldCipher;
  private readonly fetchImpl: typeof fetch;
  private readonly logger?: RedactingLogger;
  private readonly baseUrl: string;
  /**
   * WI-07 — memoized create-if-not-exists guard. Resolved once the table is known
   * to exist (or was just created); a failure clears it so the next write retries
   * rather than poisoning every subsequent write with a cached rejection.
   */
  private tableEnsured?: Promise<void>;

  constructor(options: AzureTableSquadMemoryStoreOptions) {
    this.account = options.account;
    this.tableName = options.tableName;
    this.getAccessToken = options.getAccessToken;
    this.cipher = options.cipher ?? new NullFieldCipher();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger;
    const host = options.endpoint ?? `https://${this.account}.table.core.windows.net`;
    this.baseUrl = host.replace(/\/$/, "");
  }

  private async headers(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    const token = await this.getAccessToken();
    this.logger?.registerSecret(token);
    return {
      Authorization: `Bearer ${token}`,
      "x-ms-version": TABLE_API_VERSION,
      "x-ms-date": new Date().toUTCString(),
      Accept: "application/json;odata=nometadata",
      "Content-Type": "application/json",
      ...extra,
    };
  }

  /**
   * WI-07 — idempotently create the backing table before the first write. Issues
   * `POST <baseUrl>/Tables` with `{"TableName": <tableName>}`; a 201/204 means it
   * was created and a 409 means it already exists — both are success. The result
   * is memoized so only the FIRST write pays the round-trip; a failure clears the
   * memo so a later write can retry instead of inheriting a cached rejection.
   * Never called on read / list / listProjects paths (a missing table already
   * yields `[]` / `undefined` there).
   */
  private ensureTable(): Promise<void> {
    if (this.tableEnsured === undefined) {
      this.tableEnsured = this.createTable().catch((error: unknown) => {
        this.tableEnsured = undefined;
        throw error;
      });
    }
    return this.tableEnsured;
  }

  private async createTable(): Promise<void> {
    const response = await this.fetchImpl(`${this.baseUrl}/Tables`, {
      method: "POST",
      headers: await this.headers({ Prefer: "return-no-content" }),
      body: JSON.stringify({ TableName: this.tableName }),
    });
    // 201/204 -> created; 409 -> already exists. Both mean the table is ready.
    if (response.status === 201 || response.status === 204 || response.status === 409) {
      return;
    }
    throw new Error(`Table create failed with status ${response.status}.`);
  }

  /** The tenant/project partition key (isolation boundary; never caller-derivable). */
  private partitionKey(tenantId: string, project: string): string {
    return `${tenantId}:${project}`;
  }  /**
   * The stored RowKey for a memory `path`. Azure Table Storage forbids `/`, `\`,
   * `#`, and `?` in key fields, so a multi-segment family (`history/<agent>`,
   * `repo-memory/<name>`) cannot be stored verbatim. Percent-encoding the path
   * yields a valid RowKey (`/` -> `%2F`) that still round-trips one-to-one with
   * the raw `path`; the raw value is preserved in the entity's `path` property,
   * so reads reconstruct it without decoding the key.
   */
  private rowKey(path: string): string {
    return encodeURIComponent(path);
  }

  private entityUrl(partitionKey: string, path: string): string {
    // The RowKey value itself is percent-encoded (see rowKey); the OData URL then
    // percent-encodes that value again for transport, so Azure decodes exactly one
    // layer back to the stored key and no forbidden `/` ever reaches the key field.
    return `${this.baseUrl}/${this.tableName}(PartitionKey='${encodeURIComponent(partitionKey)}',RowKey='${encodeURIComponent(this.rowKey(path))}')`;
  }

  /** Map a wire entity back to a decrypted entry. */
  private fromEntity(entity: MemoryEntity, tenantId: string): SquadMemoryEntry {
    return {
      tenantId,
      project: entity.project,
      path: entity.path,
      content: decryptField(this.cipher, entity.content) ?? "",
      etag: entity["odata.etag"] ?? "",
      updatedAt: entity.updatedAt,
    };
  }

  /** Build the sealed wire entity for a write (content encrypted). */
  private toEntity(tenantId: string, project: string, path: string, content: string): MemoryEntity {
    const entity: MemoryEntity = {
      PartitionKey: this.partitionKey(tenantId, project),
      RowKey: this.rowKey(path),
      project,
      path,
      updatedAt: Date.now(),
    };
    const sealed = encryptField(this.cipher, content);
    if (sealed !== undefined) entity.content = sealed;
    return entity;
  }

  async list(tenantId: string, project: string): Promise<SquadMemoryEntry[]> {
    if (!isSafeMemorySegment(tenantId) || !isSafeMemorySegment(project)) {
      return [];
    }
    const filter = `PartitionKey eq '${this.partitionKey(tenantId, project)}'`;
    const url = `${this.baseUrl}/${this.tableName}()?$filter=${encodeURIComponent(filter)}`;
    const response = await this.fetchImpl(url, { method: "GET", headers: await this.headers() });
    if (response.status === 404) {
      return [];
    }
    if (!response.ok) {
      throw new Error(`Table query failed with status ${response.status}.`);
    }
    const body = (await response.json()) as { value?: MemoryEntity[] };
    return (body.value ?? []).map((entity) => this.fromEntity(entity, tenantId));
  }

  async read(tenantId: string, project: string, path: string): Promise<SquadMemoryEntry | undefined> {
    if (!isSafeMemorySegment(tenantId) || !isSafeMemorySegment(project) || !isSafeMemoryPath(path)) {
      return undefined;
    }
    const entity = await this.fetchEntity(this.partitionKey(tenantId, project), path);
    return entity ? this.fromEntity(entity, tenantId) : undefined;
  }

  /** Fetch the raw (still-sealed) entity + its ETag by exact key. */
  private async fetchEntity(partitionKey: string, path: string): Promise<MemoryEntity | undefined> {
    const response = await this.fetchImpl(this.entityUrl(partitionKey, path), {
      method: "GET",
      headers: await this.headers(),
    });
    if (response.status === 404) {
      return undefined;
    }
    if (!response.ok) {
      throw new Error(`Table read failed with status ${response.status}.`);
    }
    return (await response.json()) as MemoryEntity;
  }

  async write(
    tenantId: string,
    project: string,
    path: string,
    content: string,
    expectedEtag?: string,
  ): Promise<SquadMemoryWriteResult> {
    if (!isSafeMemorySegment(tenantId) || !isSafeMemorySegment(project) || !isSafeMemoryPath(path)) {
      // A malformed key never touches storage; treat as a lost race (no leakage).
      return { ok: false, conflict: true, current: undefined };
    }
    // WI-07 — create the backing table on first write (memoized); never on reads.
    await this.ensureTable();
    const partitionKey = this.partitionKey(tenantId, project);
    const entity = this.toEntity(tenantId, project, path, content);
    // Insert-Or-Replace (no If-Match) for a first/unconditional write; Update
    // (If-Match: <etag>) makes a CAS write a true compare-and-swap — a stale etag
    // (or a since-deleted entry) fails 412/404 and we return the current revision.
    const conditional = expectedEtag !== undefined;
    const response = await this.fetchImpl(this.entityUrl(partitionKey, path), {
      method: "PUT",
      headers: await this.headers(conditional ? { "If-Match": expectedEtag } : {}),
      body: JSON.stringify(entity),
    });
    if (conditional && (response.status === 412 || response.status === 404)) {
      const current = await this.fetchEntity(partitionKey, path);
      return { ok: false, conflict: true, current: current ? this.fromEntity(current, tenantId) : undefined };
    }
    if (!response.ok) {
      throw new Error(`Table write failed with status ${response.status}.`);
    }
    const etag = response.headers.get("etag") ?? "";
    return {
      ok: true,
      etag,
      entry: { tenantId, project, path, content, etag, updatedAt: entity.updatedAt },
    };
  }

  async listProjects(tenantId: string): Promise<string[]> {
    if (!isSafeMemorySegment(tenantId)) {
      return [];
    }
    // PartitionKey range scan bounded to this tenant: every `tenantId:<project>`
    // sorts >= `tenantId:` and < `tenantId;` (`;` = the codepoint after `:`),
    // so the range selects exactly this tenant's partitions without startswith.
    const lower = `${tenantId}:`;
    const upper = `${tenantId};`;
    const filter = `PartitionKey ge '${lower}' and PartitionKey lt '${upper}'`;
    const url = `${this.baseUrl}/${this.tableName}()?$filter=${encodeURIComponent(filter)}&$select=PartitionKey`;
    const response = await this.fetchImpl(url, { method: "GET", headers: await this.headers() });
    if (response.status === 404) {
      return [];
    }
    if (!response.ok) {
      throw new Error(`Table query failed with status ${response.status}.`);
    }
    const body = (await response.json()) as { value?: Array<{ PartitionKey: string }> };
    const projects = new Set<string>();
    for (const row of body.value ?? []) {
      const project = row.PartitionKey.slice(lower.length);
      if (project.length > 0) {
        projects.add(project);
      }
    }
    return [...projects];
  }
}
