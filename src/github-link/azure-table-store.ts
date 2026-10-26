/**
 * Azure Table Storage implementations of the two GitHub-link stores, so every
 * web replica sees the same link rows and the same single-use flow entries.
 *
 * Same house style as `engine/backends/azure-table-run-state.ts`: the Table REST
 * API over `fetch`, an INJECTED managed-identity token provider, no Azure SDK.
 *
 *   * {@link AzureTableGitHubLinkStore}: one entity per principal. PartitionKey =
 *     sha256(tenantId) hex, RowKey = the Entra object id. Insert (POST) for
 *     create-only, Update Entity (PUT) with `If-Match: <etag>` for compare and
 *     swap, never an upsert. Token fields stay the sealed strings the service
 *     produced; this module never decrypts, parses or logs them.
 *   * {@link AzureTableLinkFlowStore}: one entity per flow step. `take` reads the
 *     entity then deletes it with `If-Match: <exact etag>`; only the replica whose
 *     delete returns 204 gets the entry, so two replicas racing on one nonce or
 *     state produce exactly one success.
 *
 * Failure handling: a 412/404/409 that the store contract models (lost CAS, row
 * gone, row exists) is a normal result. Any other non-2xx throws an Error that
 * carries only the status code, never a response body, URL or header.
 */
import { createHash } from "node:crypto";

import type { FieldCipher } from "../engine/field-cipher.js";
import { PrincipalVault } from "../auth/principal-vault.js";
import { secureEndpoint } from "./url-policy.js";
import type { LinkFlowEntry, LinkFlowStore } from "./flow-store.js";
import type {
  GitHubLinkRecord,
  GitHubLinkStore,
  GitHubTokenKind,
  LinkLogger,
  PutResult,
  StoredGitHubLink,
} from "./types.js";

/** The Table REST API version this client speaks (same as the run-state store). */
const TABLE_API_VERSION = "2019-02-02";

/** Table Storage allows 64 KiB per string property and 1 MiB per entity; stay far below both. */
export const MAX_STRING_PROPERTY_CHARS = 8 * 1024;
export const MAX_ENTITY_CHARS = 32 * 1024;

const TENANT_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const OID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const FLOW_KEY_PATTERN = /^[\x21-\x7e]{1,512}$/;
const ACCOUNT_PATTERN = /^[a-z0-9]{3,24}$/;
const TABLE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9]{2,62}$/;
const TOKEN_KINDS: readonly GitHubTokenKind[] = ["ghu", "gho", "other"];
const INT32_MAX = 2_147_483_647;

export interface AzureTableConnectionOptions {
  /** Storage account name (operator config, never caller input). */
  account: string;
  /** Table name (operator config). Created on first write when absent. */
  tableName: string;
  /** Returns a fresh Storage bearer token (`https://storage.azure.com/.default`). */
  getAccessToken: () => Promise<string>;
  /** Injectable fetch (default: global fetch). */
  fetchImpl?: typeof fetch;
  /** Receives the access token as a secret to redact; the client never logs it. */
  logger?: LinkLogger;
  /** Override the table endpoint (default `https://<account>.table.core.windows.net`). */
  endpoint?: string;
  /** Extra attempts after a 429 or 503 (default 3). Other failures are never retried. */
  maxRetries?: number;
  /** Injectable delay for the throttle back-off. */
  sleep?: (ms: number) => Promise<void>;
}

type Scalar = string | number;
type TableEntity = Record<string, Scalar | undefined>;

interface Fetched {
  entity: TableEntity;
  etag: string;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Thin Table REST client shared by both stores. Everything that touches the wire
 * lives here so headers, retries, error text and the ETag rules are identical.
 */
class TableClient {
  private readonly tableName: string;
  private readonly baseUrl: string;
  private readonly getAccessToken: () => Promise<string>;
  private readonly fetchImpl: typeof fetch;
  private readonly logger?: LinkLogger;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private tableEnsured?: Promise<void>;

  constructor(options: AzureTableConnectionOptions) {
    if (options.endpoint === undefined && !ACCOUNT_PATTERN.test(options.account)) {
      throw new Error("Azure Table account name is invalid.");
    }
    if (!TABLE_NAME_PATTERN.test(options.tableName)) {
      throw new Error("Azure Table name is invalid (3-63 alphanumerics, starting with a letter).");
    }
    this.tableName = options.tableName;
    this.getAccessToken = options.getAccessToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger;
    this.maxRetries = options.maxRetries ?? 3;
    if (!Number.isInteger(this.maxRetries) || this.maxRetries < 0 || this.maxRetries > 8) {
      throw new Error("Azure Table retry count must be between 0 and 8.");
    }
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const host = options.endpoint ?? `https://${options.account}.table.core.windows.net`;
    this.baseUrl = secureEndpoint(host);
  }

  /** Create the table once per client; a failure clears the memo so the next write retries. */
  ensureTable(): Promise<void> {
    if (this.tableEnsured === undefined) {
      this.tableEnsured = this.createTable().catch((error: unknown) => {
        this.tableEnsured = undefined;
        throw error;
      });
    }
    return this.tableEnsured;
  }

  private async createTable(): Promise<void> {
    const response = await this.send("POST", `${this.baseUrl}/Tables`, {
      body: { TableName: this.tableName },
      prefer: true,
    });
    // 201/204 created, 409 already exists: both mean the table is ready.
    if (response.status === 201 || response.status === 204 || response.status === 409) {
      return;
    }
    throw new Error(`Table create failed with status ${response.status}.`);
  }

  /** Insert Entity. `undefined` means the row already exists (409). */
  async insert(entity: TableEntity): Promise<{ etag: string } | undefined> {
    assertEntityWithinLimits(entity);
    await this.ensureTable();
    const response = await this.send("POST", `${this.baseUrl}/${this.tableName}`, { body: entity, prefer: true });
    if (response.status === 409) {
      return undefined;
    }
    if (!response.ok) {
      throw new Error(`Table insert failed with status ${response.status}.`);
    }
    return { etag: requireEtag(response, "insert") };
  }

  /** Entity point read. `undefined` when the row (or the table) does not exist. */
  async get(partitionKey: string, rowKey: string): Promise<Fetched | undefined> {
    const response = await this.send("GET", this.entityUrl(partitionKey, rowKey), {});
    if (response.status === 404) {
      return undefined;
    }
    if (!response.ok) {
      throw new Error(`Table read failed with status ${response.status}.`);
    }
    let entity: TableEntity;
    try { entity = (await response.json()) as TableEntity; }
    catch { throw new Error("Azure Table response is malformed."); }
    if (entity === null || typeof entity !== "object" || Array.isArray(entity)) throw new Error("Azure Table response is malformed.");
    const etag = response.headers.get("etag") ?? (typeof entity["odata.etag"] === "string" ? entity["odata.etag"] : "");
    if (!etag || etag === "*") {
      throw new Error("Table read response is missing an entity ETag.");
    }
    return { entity, etag };
  }

  /**
   * Update Entity (PUT, full replace) guarded by `If-Match`. `undefined` means the
   * compare failed (412) or the row is gone (404); the caller's view is stale.
   */
  async replace(
    partitionKey: string,
    rowKey: string,
    entity: TableEntity,
    etag: string,
  ): Promise<{ etag: string } | undefined> {
    if (!etag || etag === "*") {
      throw new Error("A conditional update needs the exact entity ETag; refusing an unconditional write.");
    }
    assertEntityWithinLimits(entity);
    const response = await this.send("PUT", this.entityUrl(partitionKey, rowKey), {
      body: entity,
      ifMatch: etag,
      prefer: true,
    });
    if (response.status === 412 || response.status === 404) {
      return undefined;
    }
    if (!response.ok) {
      throw new Error(`Table update failed with status ${response.status}.`);
    }
    return { etag: requireEtag(response, "update") };
  }

  /** Delete Entity with `If-Match`. True only when THIS request removed the row. */
  async remove(partitionKey: string, rowKey: string, etag: string): Promise<boolean> {
    const response = await this.send("DELETE", this.entityUrl(partitionKey, rowKey), { ifMatch: etag });
    if (response.status === 404 || response.status === 412) {
      return false;
    }
    if (!response.ok) {
      throw new Error(`Table delete failed with status ${response.status}.`);
    }
    return true;
  }

  /** Keys of up to `top` entities matching an OData filter (single page). */
  async queryKeys(filter: string, top: number): Promise<Array<{ partitionKey: string; rowKey: string }>> {
    const query = `$filter=${encodeURIComponent(filter)}&$select=PartitionKey,RowKey&$top=${top}`;
    const response = await this.send("GET", `${this.baseUrl}/${this.tableName}()?${query}`, {});
    if (response.status === 404) {
      return [];
    }
    if (!response.ok) {
      throw new Error(`Table query failed with status ${response.status}.`);
    }
    let body: { value?: Array<{ PartitionKey: string; RowKey: string }> };
    try { body = (await response.json()) as typeof body; }
    catch { throw new Error("Azure Table response is malformed."); }
    return (body.value ?? []).map((row) => ({ partitionKey: row.PartitionKey, rowKey: row.RowKey }));
  }

  private entityUrl(partitionKey: string, rowKey: string): string {
    return `${this.baseUrl}/${this.tableName}(PartitionKey='${encodeURIComponent(partitionKey)}',RowKey='${encodeURIComponent(rowKey)}')`;
  }

  private async send(
    method: "GET" | "POST" | "PUT" | "DELETE",
    url: string,
    options: { body?: unknown; ifMatch?: string; prefer?: boolean },
  ): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      let token: string;
      try { token = await this.getAccessToken(); }
      catch { throw new Error("Azure Table authentication failed."); }
      this.logger?.registerSecret?.(token);
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        "x-ms-version": TABLE_API_VERSION,
        "x-ms-date": new Date().toUTCString(),
        // Point reads return the entity ETag in the ETag header whatever the odata level is.
        Accept: method === "GET" ? "application/json;odata=fullmetadata" : "application/json;odata=nomsmetadata",
      };
      if (options.body !== undefined) {
        headers["Content-Type"] = "application/json";
      }
      if (options.prefer) {
        headers.Prefer = "return-no-content";
      }
      if (options.ifMatch !== undefined) {
        headers["If-Match"] = options.ifMatch;
      }
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: AbortSignal.timeout(15_000), redirect: "error",
        });
      } catch { throw new Error("Azure Table request failed."); }
      // 429 (throttled) and 503 (ServerBusy) mean the request was not applied, so a retry is safe.
      if ((response.status === 429 || (method === "GET" && response.status === 503)) && attempt < this.maxRetries) {
        this.logger?.warn("Azure Table request throttled", { status: response.status, attempt: attempt + 1 });
        await this.sleep(100 * 2 ** attempt);
        continue;
      }
      return response;
    }
  }
}

function requireEtag(response: Response, operation: string): string {
  const etag = response.headers.get("etag");
  if (!etag || etag === "*") {
    throw new Error(`Table ${operation} response is missing an entity ETag.`);
  }
  return etag;
}

/** Fails loudly (without echoing any value) when a property or the entity is too large. */
function assertEntityWithinLimits(entity: TableEntity): void {
  let total = 0;
  for (const [name, value] of Object.entries(entity)) {
    if (typeof value === "string") {
      if (value.length > MAX_STRING_PROPERTY_CHARS) {
        throw new Error(`Table property "${name}" is ${value.length} characters, over the ${MAX_STRING_PROPERTY_CHARS} limit.`);
      }
      total += name.length + value.length;
    }
  }
  if (total > MAX_ENTITY_CHARS) {
    throw new Error(`Table entity is ${total} characters, over the ${MAX_ENTITY_CHARS} limit.`);
  }
}

// ---------------------------------------------------------------- link store

export type AzureTableGitHubLinkStoreOptions = AzureTableConnectionOptions;

/** Split `tenantId|oid` and validate both halves before anything reaches the wire. */
function parsePrincipalKey(principalKey: string): { tenantId: string; oid: string } {
  const separator = typeof principalKey === "string" ? principalKey.indexOf("|") : -1;
  const tenantId = separator < 0 ? "" : principalKey.slice(0, separator);
  const oid = separator < 0 ? "" : principalKey.slice(separator + 1);
  if (!TENANT_PATTERN.test(tenantId) || !OID_PATTERN.test(oid)) {
    throw new Error("GitHub link principal key is malformed.");
  }
  return { tenantId, oid };
}

export function partitionKeyForTenant(tenantId: string): string {
  return sha256Hex(tenantId);
}

function setIfDefined(entity: TableEntity, name: string, value: Scalar | undefined): void {
  if (value !== undefined) {
    entity[name] = value;
  }
}

function toLinkEntity(record: GitHubLinkRecord): TableEntity {
  const { tenantId, oid } = parsePrincipalKey(`${record.tenantId}|${record.oid}`);
  if (!Number.isSafeInteger(record.githubUserId) || record.githubUserId < 0) {
    throw new Error("GitHub user id must be a non-negative safe integer.");
  }
  if (!Number.isInteger(record.credentialVersion) || record.credentialVersion < 0 || record.credentialVersion > INT32_MAX) {
    throw new Error("Credential version must be a non-negative 32-bit integer.");
  }
  const entity: TableEntity = {
    PartitionKey: partitionKeyForTenant(tenantId),
    RowKey: oid,
    tenantId,
    oid,
    // Edm.Int32 would overflow for large ids and a bare JSON number is not Int64; keep it a string.
    githubUserId: String(record.githubUserId),
    githubLogin: record.githubLogin,
    tokenKind: record.tokenKind,
    accessTokenEnc: record.accessTokenEnc,
    credentialVersion: record.credentialVersion,
    linkedAt: record.linkedAt,
    updatedAt: record.updatedAt,
  };
  setIfDefined(entity, "refreshTokenEnc", record.refreshTokenEnc);
  setIfDefined(entity, "accessExpiresAt", record.accessExpiresAt);
  setIfDefined(entity, "refreshExpiresAt", record.refreshExpiresAt);
  setIfDefined(entity, "refreshLeaseId", record.refreshLease?.id);
  setIfDefined(entity, "refreshLeaseExpiresAt", record.refreshLease?.expiresAt);
  setIfDefined(entity, "linkGeneration", record.linkGeneration);
  setIfDefined(entity, "state", record.state);
  return entity;
}

function malformed(): Error {
  return new Error("Stored GitHub link entity is malformed.");
}

function str(entity: TableEntity, name: string): string {
  const value = entity[name];
  if (typeof value !== "string") {
    throw malformed();
  }
  return value;
}

function optStr(entity: TableEntity, name: string): string | undefined {
  const value = entity[name];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw malformed();
  }
  return value;
}

function fromLinkEntity(entity: TableEntity, expected: { tenantId: string; oid: string }): GitHubLinkRecord {
  const tenantId = str(entity, "tenantId");
  const oid = str(entity, "oid");
  // A planted or copied row must not be served under another key.
  if (
    tenantId !== expected.tenantId ||
    oid !== expected.oid ||
    entity.PartitionKey !== partitionKeyForTenant(tenantId) ||
    entity.RowKey !== oid
  ) {
    throw malformed();
  }
  const githubUserId = Number(str(entity, "githubUserId"));
  const tokenKind = str(entity, "tokenKind") as GitHubTokenKind;
  const credentialVersion = entity.credentialVersion;
  if (
    !Number.isSafeInteger(githubUserId) ||
    !TOKEN_KINDS.includes(tokenKind) ||
    typeof credentialVersion !== "number" ||
    !Number.isInteger(credentialVersion)
  ) {
    throw malformed();
  }
  const record: GitHubLinkRecord = {
    tenantId,
    oid,
    githubUserId,
    githubLogin: str(entity, "githubLogin"),
    tokenKind,
    accessTokenEnc: str(entity, "accessTokenEnc"),
    credentialVersion,
    linkedAt: str(entity, "linkedAt"),
    updatedAt: str(entity, "updatedAt"),
  };
  const refreshTokenEnc = optStr(entity, "refreshTokenEnc");
  const accessExpiresAt = optStr(entity, "accessExpiresAt");
  const refreshExpiresAt = optStr(entity, "refreshExpiresAt");
  const leaseId = optStr(entity, "refreshLeaseId");
  const leaseExpiresAt = optStr(entity, "refreshLeaseExpiresAt");
  const generation = optStr(entity, "linkGeneration");
  const state = optStr(entity, "state");
  if (generation !== undefined) record.linkGeneration = generation;
  if (state !== undefined) {
    if (!["active", "unlinked", "reauth-required"].includes(state)) throw malformed();
    record.state = state as GitHubLinkRecord["state"];
  }
  if (refreshTokenEnc !== undefined) record.refreshTokenEnc = refreshTokenEnc;
  if (accessExpiresAt !== undefined) record.accessExpiresAt = accessExpiresAt;
  if (refreshExpiresAt !== undefined) record.refreshExpiresAt = refreshExpiresAt;
  if (leaseId !== undefined && leaseExpiresAt !== undefined) {
    record.refreshLease = { id: leaseId, expiresAt: leaseExpiresAt };
  } else if (leaseId !== undefined || leaseExpiresAt !== undefined) {
    throw malformed();
  }
  return record;
}

/**
 * Shared, optimistic-concurrency link store. The ETag is the one Table Storage
 * returns (`ETag` header of the insert/update/read response); it is compared for
 * equality only and always sent back verbatim in `If-Match`.
 */
export class AzureTableGitHubLinkStore implements GitHubLinkStore {
  private readonly client: TableClient;

  constructor(options: AzureTableGitHubLinkStoreOptions) {
    this.client = new TableClient(options);
  }

  async get(principalKey: string): Promise<StoredGitHubLink | undefined> {
    const key = parsePrincipalKey(principalKey);
    const fetched = await this.client.get(partitionKeyForTenant(key.tenantId), key.oid);
    return fetched ? { record: fromLinkEntity(fetched.entity, key), etag: fetched.etag } : undefined;
  }

  async putIfMatch(record: GitHubLinkRecord, expectedEtag: string | undefined): Promise<PutResult> {
    const entity = toLinkEntity(record);
    const written =
      expectedEtag === undefined
        ? await this.client.insert(entity)
        : await this.client.replace(entity.PartitionKey as string, entity.RowKey as string, entity, expectedEtag);
    return written ? { ok: true, etag: written.etag } : { ok: false };
  }

  async delete(principalKey: string, expectedEtag?: string): Promise<boolean> {
    const key = parsePrincipalKey(principalKey);
    return this.client.remove(partitionKeyForTenant(key.tenantId), key.oid, expectedEtag ?? "*");
  }
}

// ---------------------------------------------------------------- flow store

export interface AzureTableLinkFlowStoreOptions extends AzureTableConnectionOptions {
  /**
   * Seals the flow entry (PKCE verifiers, OIDC nonce, principal) before it is
   * stored. Production should pass the same AES-GCM cipher as the link service.
   * Mandatory in production. Null ciphers and plaintext fallthrough are rejected.
   */
  cipher?: FieldCipher | PrincipalVault;
}

function flowRowKey(key: string): string {
  if (typeof key !== "string" || !FLOW_KEY_PATTERN.test(key)) {
    throw new Error("Link flow key is malformed.");
  }
  return sha256Hex(key);
}

/**
 * Cross-replica single-use flow state. The service already hashes nonces and
 * states into the key; this store hashes the key again for the row, so a table
 * reader sees neither a raw nonce nor a usable service key.
 */
export class AzureTableLinkFlowStore implements LinkFlowStore {
  private readonly client: TableClient;
  private readonly cipher: FieldCipher | PrincipalVault;

  constructor(options: AzureTableLinkFlowStoreOptions) {
    this.client = new TableClient(options);
    if (!options.cipher || (!(options.cipher instanceof PrincipalVault) && !options.cipher.encrypts)) {
      throw new Error("Shared GitHub flow state encryption is required.");
    }
    this.cipher = options.cipher;
  }

  async put(key: string, entry: LinkFlowEntry): Promise<void> {
    const rowKey = flowRowKey(key);
    if (!Number.isFinite(entry.expiresAtMs)) {
      throw new Error("Link flow entry needs a finite expiry.");
    }
    if (entry.expiresAtMs > Date.now() + 600_000) throw new Error("Link flow lifetime exceeds ten minutes.");
    const payload = this.cipher instanceof PrincipalVault
      ? this.cipher.seal(`github-flow|${rowKey}`, entry)
      : this.cipher.encrypt(JSON.stringify({ key: rowKey, entry }));
    if (!(this.cipher instanceof PrincipalVault) && !payload.startsWith("gcm1:")) throw new Error("GitHub flow encryption did not produce an authenticated envelope.");
    const entity: TableEntity = {
      PartitionKey: rowKey.slice(0, 2),
      RowKey: rowKey,
      kind: entry.kind,
      // Plain ISO copy of the expiry, only so a sweep can filter on it; `take` trusts the sealed payload.
      expiresAtIso: new Date(entry.expiresAtMs).toISOString(),
      payload,
    };
    if ((await this.client.insert(entity)) === undefined) {
      throw new Error("Link flow entry already exists.");
    }
  }

  async take(key: string, nowMs: number): Promise<LinkFlowEntry | undefined> {
    const rowKey = flowRowKey(key);
    const partitionKey = rowKey.slice(0, 2);
    const fetched = await this.client.get(partitionKey, rowKey);
    if (!fetched) {
      return undefined;
    }
    // Atomic consume: only the caller whose conditional delete succeeds owns the entry.
    if (!(await this.client.remove(partitionKey, rowKey, fetched.etag))) {
      return undefined;
    }
    const payload = fetched.entity.payload;
    if (typeof payload !== "string") {
      throw new Error("Stored link flow entity is malformed.");
    }
    let entry: LinkFlowEntry;
    try {
      if (this.cipher instanceof PrincipalVault) entry = this.cipher.open<LinkFlowEntry>(`github-flow|${rowKey}`, payload);
      else {
        if (!payload.startsWith("gcm1:")) throw new Error();
        const decoded = JSON.parse(this.cipher.decrypt(payload)) as { key: string; entry: LinkFlowEntry };
        if (decoded.key !== rowKey) throw new Error();
        entry = decoded.entry;
      }
    } catch { throw new Error("Stored GitHub flow authentication failed."); }
    return typeof entry.expiresAtMs === "number" && entry.expiresAtMs > nowMs ? entry : undefined;
  }

  /**
   * Delete entries whose expiry is before `nowMs`. Call it from a timer or an
   * occasional request; abandoned flows would otherwise stay in the table.
   * Returns how many rows this call removed (at most `limit`).
   */
  async sweepExpired(nowMs: number, limit = 100): Promise<number> {
    if (!Number.isFinite(nowMs)) {
      throw new Error("sweepExpired needs a finite clock value.");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("Invalid flow cleanup limit.");
    const cutoff = new Date(nowMs).toISOString();
    const expired = await this.client.queryKeys(`expiresAtIso lt '${cutoff}'`, limit);
    let removed = 0;
    for (const row of expired) {
      // `*` is fine here: the row is already past its expiry and nobody may consume it.
      if (await this.client.remove(row.partitionKey, row.rowKey, "*")) {
        removed += 1;
      }
    }
    return removed;
  }
}
