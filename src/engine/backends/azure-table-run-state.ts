/**
 * Azure Table Storage run-state store (WI-06 — the multi-replica backbone).
 *
 * The file-backed {@link import("../durable-run-state.js").DurableRunStateStore}
 * survives restarts but is single-replica: its `claim` is atomic only within one
 * process, so two Container App replicas could both drive the same approved run.
 * Azure Table Storage gives a shared, cross-replica store whose optimistic
 * concurrency (ETag `If-Match`) is a true compare-and-swap: a claim PUT with a
 * stale ETag fails 412, so EXACTLY ONE replica wins a held->running transition.
 *
 * Consistent with the house style (`backends/azure-openai.ts`), this talks to the
 * Table REST API with `fetch` and an INJECTED managed-identity token provider, so
 * there is NO Azure SDK dependency and the build/tests stay SDK-free. It is
 * live-only: wired by `server-http.ts` / `worker-main.ts`, never imported by a
 * test. Security posture:
 *
 *   * SEC-3 — the storage account + table come from operator config, never a
 *     caller; a caller cannot redirect persistence elsewhere.
 *   * SEC-10 — the access token is registered with the logger for redaction and
 *     never logged; error paths never include the response body.
 *   * MEDIUM-3 — `request`/`context` are encrypted with the injected
 *     {@link FieldCipher} before they leave the process, so the caller's prompt
 *     text is opaque at rest even to an operator with raw table access.
 *
 * Partitioning: PartitionKey = tenantId (tenant partition; isolation is ALSO
 * enforced in the engine by comparing `tenantId`), RowKey = runId (an unguessable
 * CSPRNG UUID). `get(runId)` — which has no tenant in hand — resolves via a
 * bounded cross-partition RowKey query (a run id is globally unique).
 */
import {
  DEFAULT_LEASE_MS,
  answerRunInput,
  hasUnansweredHumanInput,
  isRunClaimable,
  isRunExpired,
  type ClaimOptions,
  type CreateRunInit,
  type HumanInputResponse,
  type RunState,
  type RunStateStore,
  type RunStatus,
} from "../run-state.js";
import { isValidRunId } from "../durable-run-state.js";
import { NullFieldCipher, decryptField, encryptField, type FieldCipher } from "../field-cipher.js";
import { createHash, randomUUID } from "node:crypto";
import type { RedactingLogger } from "../../observability/logger.js";
import type { MemoryBlobWriter } from "./overflow-squad-memory.js";
import { isSafeMemorySegment } from "../squad-memory-state.js";
import { readModelFailure } from "../model-backend.js";

/** The Table REST API version this client speaks. */
const TABLE_API_VERSION = "2019-02-02";

export interface AzureTableRunStateStoreOptions {
  /** Storage account name (operator config). */
  account: string;
  /** Table name that holds run records (created out-of-band or on first write). */
  tableName: string;
  /** Returns a fresh Storage bearer token (`https://storage.azure.com/.default`). */
  getAccessToken: () => Promise<string>;
  /** Field cipher for `request`/`context` at rest (default identity). */
  cipher?: FieldCipher;
  /** Injectable fetch (default: global fetch). */
  fetchImpl?: typeof fetch;
  /** Logger to register the token as a secret (SEC-10). */
  logger?: RedactingLogger;
  /** Override the table endpoint host (default `<account>.table.core.windows.net`). */
  endpoint?: string;
  /** Private content-addressed overflow; the table ETag remains the CAS authority. */
  blob?: MemoryBlobWriter;
}

/** The wire shape of a run entity (flat property bag; Table Storage has no nesting). */
interface RunEntity {
  [key: string]: string | number | undefined;
  PartitionKey: string;
  RowKey: string;
  toolId: string;
  status: RunStatus;
  createdAt: number;
  updatedAt?: number;
  holdReason?: string;
  failureReason?: string;
  responsibleAi?: string;
  modelFailure?: string;
  artifact?: string;
  request?: string;
  context?: string;
  /** The remaining coordinator inputs, JSON-serialized then field-encrypted. */
  params?: string;
  approvedBy?: string;
  approvedAt?: number;
  expiresAt?: number;
  leaseExpiresAt?: number;
  /**
   * Phase 4 — the advisory composites are flattened to JSON strings (Table Storage
   * has no nesting). `stages`/`councilVerdict` carry caller/model text so they are
   * encrypted with the field cipher before serialization; `history` and
   * prompt-free completion usage are metadata stored as plain JSON.
   */
  stages?: string;
  councilVerdict?: string;
  history?: string;
  completionUsage?: string;
  humanInput?: string;
  advisoryCheckpoint?: string;
  "odata.etag"?: string;
}

/**
 * Azure Table Edm.String values are UTF-16 and limited to 64 KiB. Keep each
 * chunk below that hard ceiling so model artifacts and encrypted context can
 * use the entity's larger 1 MiB aggregate allowance.
 */
export const AZURE_TABLE_STRING_CHUNK_BYTES = 60 * 1024;
const CHUNK_COUNT_SUFFIX = "__chunkCount";
const CHUNK_VALUE_PREFIX = "__chunk";

type ChunkableRunProperty =
  | "artifact"
  | "request"
  | "context"
  | "params"
  | "stages"
  | "councilVerdict"
  | "humanInput"
  | "advisoryCheckpoint"
  | "history"
  | "completionUsage";

const RUN_PAYLOAD_PROPERTIES: ChunkableRunProperty[] = [
  "artifact", "request", "context", "params", "stages", "councilVerdict",
  "humanInput", "advisoryCheckpoint", "history", "completionUsage",
];
const INLINE_PAYLOAD_BYTES = 32_000;
const MAX_OVERFLOW_BYTES = 16_000_000;
const BLOB_SUFFIX = "__blob";

function overflowPath(entity: RunEntity, property: ChunkableRunProperty, digest: string): string {
  if (!isSafeMemorySegment(entity.PartitionKey) || !isValidRunId(entity.RowKey)) {
    throw new Error("Invalid run-state overflow identity.");
  }
  return `run-state/${encodeURIComponent(entity.PartitionKey)}/${entity.RowKey}/${property}/${digest}`;
}

function splitTableString(value: string): string[] {
  const chunks: string[] = [];
  let chunkStart = 0;
  let index = 0;
  let chunkBytes = 0;

  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf16le");
    if (
      chunkBytes + characterBytes > AZURE_TABLE_STRING_CHUNK_BYTES &&
      index > chunkStart
    ) {
      chunks.push(value.slice(chunkStart, index));
      chunkStart = index;
      chunkBytes = 0;
    }
    chunkBytes += characterBytes;
    index += character.length;
  }
  chunks.push(value.slice(chunkStart));
  return chunks;
}

function chunkName(property: ChunkableRunProperty, index: number): string {
  return `${property}${CHUNK_VALUE_PREFIX}${String(index).padStart(3, "0")}`;
}

function writeTableString(
  entity: RunEntity,
  property: ChunkableRunProperty,
  value: string | undefined,
): void {
  if (value === undefined) {
    return;
  }
  const chunks = splitTableString(value);
  if (chunks.length === 1) {
    entity[property] = value;
    return;
  }
  entity[`${property}${CHUNK_COUNT_SUFFIX}`] = chunks.length;
  chunks.forEach((chunk, index) => {
    entity[chunkName(property, index)] = chunk;
  });
}

function readTableString(
  entity: RunEntity,
  property: ChunkableRunProperty,
): string | undefined {
  const direct = entity[property];
  if (typeof direct === "string") {
    return direct;
  }
  const count = entity[`${property}${CHUNK_COUNT_SUFFIX}`];
  if (count === undefined) {
    return undefined;
  }
  if (
    typeof count !== "number" ||
    !Number.isInteger(count) ||
    count < 2 ||
    count > 252
  ) {
    throw new Error(`Malformed chunk metadata for run-state property '${property}'.`);
  }
  const chunks: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const chunk = entity[chunkName(property, index)];
    if (typeof chunk !== "string") {
      throw new Error(`Missing chunk for run-state property '${property}'.`);
    }
    chunks.push(chunk);
  }
  return chunks.join("");
}

function entityStorageStats(entity: RunEntity): Record<string, number> {
  const stringSizes = Object.values(entity)
    .filter((value): value is string => typeof value === "string")
    .map((value) => Buffer.byteLength(value, "utf16le"));
  return {
    propertyCount: Object.keys(entity).length,
    payloadBytes: Buffer.byteLength(JSON.stringify(entity), "utf8"),
    largestStringBytes: Math.max(0, ...stringSizes),
  };
}

export class AzureTableRunStateStore implements RunStateStore {
  readonly kind = "durable" as const;
  private readonly account: string;
  private readonly tableName: string;
  private readonly getAccessToken: () => Promise<string>;
  private readonly cipher: FieldCipher;
  private readonly fetchImpl: typeof fetch;
  private readonly logger?: RedactingLogger;
  private readonly baseUrl: string;
  private readonly blob?: MemoryBlobWriter;
  /**
   * WI-07 — memoized create-if-not-exists guard. Resolved once the table is known
   * to exist (or was just created); a failure clears it so the next write retries
   * rather than poisoning every subsequent write with a cached rejection.
   */
  private tableEnsured?: Promise<void>;

  constructor(options: AzureTableRunStateStoreOptions) {
    this.account = options.account;
    this.tableName = options.tableName;
    this.getAccessToken = options.getAccessToken;
    this.cipher = options.cipher ?? new NullFieldCipher();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger;
    this.blob = options.blob;
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
      // Only fullmetadata includes the entity ETag needed by query-based CAS.
      Accept: "application/json;odata=fullmetadata",
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

  private entityUrl(tenantId: string, runId: string): string {
    return `${this.baseUrl}/${this.tableName}(PartitionKey='${encodeURIComponent(tenantId)}',RowKey='${encodeURIComponent(runId)}')`;
  }

  /** Map a decrypted RunState to the sealed wire entity (request/context encrypted). */
  private async writePayload(entity: RunEntity, property: ChunkableRunProperty, value: string | undefined): Promise<void> {
    if (value === undefined || !this.blob || Buffer.byteLength(value, "utf16le") <= INLINE_PAYLOAD_BYTES) {
      writeTableString(entity, property, value);
      return;
    }
    const bytes = Buffer.from(value, "utf8");
    if (bytes.length > MAX_OVERFLOW_BYTES) throw new Error("Run-state overflow payload exceeds its storage limit.");
    const digest = createHash("sha256").update(bytes).digest("hex");
    await this.blob.put(overflowPath(entity, property, digest), bytes);
    entity[`${property}${BLOB_SUFFIX}`] = `${digest}:${bytes.length}`;
  }

  private async hydratePayloads(entity: RunEntity): Promise<RunEntity> {
    const hydrated = { ...entity };
    await Promise.all(RUN_PAYLOAD_PROPERTIES.map(async (property) => {
      const marker = entity[`${property}${BLOB_SUFFIX}`];
      if (marker === undefined) return;
      if (!this.blob) throw new Error("Run-state overflow storage is not configured.");
      const match = typeof marker === "string" ? /^([0-9a-f]{64}):([1-9]\d{0,7})$/.exec(marker) : null;
      if (!match || Number(match[2]) > MAX_OVERFLOW_BYTES ||
          entity[property] !== undefined || entity[`${property}${CHUNK_COUNT_SUFFIX}`] !== undefined) {
        throw new Error("Malformed run-state overflow metadata.");
      }
      const bytes = await this.blob.get(overflowPath(entity, property, match[1]));
      if (!bytes) throw new Error("Run-state overflow payload is missing.");
      if (bytes.length !== Number(match[2]) || createHash("sha256").update(bytes).digest("hex") !== match[1]) {
        throw new Error("Run-state overflow integrity mismatch.");
      }
      hydrated[property] = Buffer.from(bytes).toString("utf8");
      delete hydrated[`${property}${BLOB_SUFFIX}`];
    }));
    return hydrated;
  }

  private async toEntity(run: RunState): Promise<RunEntity> {
    const entity: RunEntity = {
      PartitionKey: run.tenantId,
      RowKey: run.runId,
      toolId: run.toolId,
      status: run.status,
      createdAt: run.createdAt,
    };
    if (run.updatedAt !== undefined) entity.updatedAt = run.updatedAt;
    if (run.holdReason !== undefined) entity.holdReason = run.holdReason;
    if (run.failureReason !== undefined) entity.failureReason = run.failureReason;
    if (run.responsibleAi !== undefined) entity.responsibleAi = JSON.stringify(run.responsibleAi);
    if (run.modelFailure !== undefined) entity.modelFailure = JSON.stringify(readModelFailure(run.modelFailure));
    await this.writePayload(entity, "artifact", run.artifact);
    const sealedRequest = encryptField(this.cipher, run.request);
    await this.writePayload(entity, "request", sealedRequest);
    const sealedContext = encryptField(this.cipher, run.context);
    await this.writePayload(entity, "context", sealedContext);
    const sealedParams = encryptField(this.cipher, run.params);
    await this.writePayload(entity, "params", sealedParams);
    await this.writePayload(entity, "humanInput", encryptField(
      this.cipher, run.humanInput === undefined ? undefined : JSON.stringify(run.humanInput),
    ));
    await this.writePayload(entity, "advisoryCheckpoint", encryptField(this.cipher, run.advisoryCheckpoint));
    if (run.approvedBy !== undefined) entity.approvedBy = run.approvedBy;
    if (run.approvedAt !== undefined) entity.approvedAt = run.approvedAt;
    if (run.expiresAt !== undefined) entity.expiresAt = run.expiresAt;
    if (run.leaseExpiresAt !== undefined) entity.leaseExpiresAt = run.leaseExpiresAt;
    // Phase 4 — flatten + encrypt model text; history/usage remain plain metadata.
    if (run.stages !== undefined) {
      const sealedStages = encryptField(this.cipher, JSON.stringify(run.stages));
      await this.writePayload(entity, "stages", sealedStages);
    }
    if (run.councilVerdict !== undefined) {
      const sealedVerdict = encryptField(this.cipher, JSON.stringify(run.councilVerdict));
      await this.writePayload(entity, "councilVerdict", sealedVerdict);
    }
    await this.writePayload(
      entity,
      "history",
      run.history === undefined ? undefined : JSON.stringify(run.history),
    );
    await this.writePayload(
      entity,
      "completionUsage",
      run.completionUsage === undefined ? undefined : JSON.stringify(run.completionUsage),
    );
    return entity;
  }

  /** Map a wire entity back to a decrypted RunState. */
  private async fromEntity(sealed: RunEntity): Promise<RunState> {
    const entity = await this.hydratePayloads(sealed);
    const stages = readTableString(entity, "stages");
    const councilVerdict = readTableString(entity, "councilVerdict");
    const history = readTableString(entity, "history");
    const completionUsage = readTableString(entity, "completionUsage");
    const humanInput = readTableString(entity, "humanInput");
    return {
      runId: entity.RowKey,
      tenantId: entity.PartitionKey,
      toolId: entity.toolId,
      status: entity.status,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
      holdReason: entity.holdReason,
      failureReason: entity.failureReason,
      responsibleAi: entity.responsibleAi === undefined
        ? undefined : JSON.parse(entity.responsibleAi) as RunState["responsibleAi"],
      modelFailure: entity.modelFailure === undefined
        ? undefined : readModelFailure(JSON.parse(entity.modelFailure)),
      artifact: readTableString(entity, "artifact"),
      request: decryptField(this.cipher, readTableString(entity, "request")),
      context: decryptField(this.cipher, readTableString(entity, "context")),
      params: decryptField(this.cipher, readTableString(entity, "params")),
      humanInput: humanInput === undefined
        ? undefined : JSON.parse(this.cipher.decrypt(humanInput)) as RunState["humanInput"],
      advisoryCheckpoint: decryptField(this.cipher, readTableString(entity, "advisoryCheckpoint")),
      approvedBy: entity.approvedBy,
      approvedAt: entity.approvedAt,
      expiresAt: entity.expiresAt,
      leaseExpiresAt: entity.leaseExpiresAt,
      stages:
        stages !== undefined
          ? (JSON.parse(decryptField(this.cipher, stages) as string) as RunState["stages"])
          : undefined,
      councilVerdict:
        councilVerdict !== undefined
          ? (JSON.parse(decryptField(this.cipher, councilVerdict) as string) as RunState["councilVerdict"])
          : undefined,
      history: history !== undefined ? (JSON.parse(history) as RunState["history"]) : undefined,
      completionUsage: completionUsage !== undefined
        ? (JSON.parse(completionUsage) as RunState["completionUsage"])
        : undefined,
    };
  }

  /** Fetch the raw (still-sealed) entity + its ETag via a bounded RowKey query. */
  private async fetchEntity(runId: string): Promise<RunEntity | undefined> {
    if (!isValidRunId(runId)) {
      return undefined;
    }
    const url =
      `${this.baseUrl}/${this.tableName}()?$filter=${encodeURIComponent(`RowKey eq '${runId}'`)}&$top=1`;
    const response = await this.fetchImpl(url, { method: "GET", headers: await this.headers() });
    if (response.status === 404) {
      return undefined;
    }
    if (!response.ok) {
      throw new Error(`Table query failed with status ${response.status}.`);
    }
    const body = (await response.json()) as { value?: RunEntity[] };
    return body.value?.[0];
  }

  async create(init: CreateRunInit): Promise<RunState> {
    const now = Date.now();
    const run: RunState = {
      runId: randomUUID(),
      tenantId: init.tenantId,
      toolId: init.toolId,
      status: "running",
      createdAt: now,
      updatedAt: now,
      expiresAt: init.ttlMs !== undefined ? now + init.ttlMs : undefined,
    };
    // WI-07 — create the backing table on first write (memoized).
    await this.ensureTable();
    const response = await this.fetchImpl(`${this.baseUrl}/${this.tableName}`, {
      method: "POST",
      headers: await this.headers({ Prefer: "return-no-content" }),
      body: JSON.stringify(await this.toEntity(run)),
    });
    if (!response.ok) {
      throw new Error(`Table insert failed with status ${response.status}.`);
    }
    return run;
  }

  async get(runId: string): Promise<RunState | undefined> {
    const entity = await this.fetchEntity(runId);
    if (!entity) {
      return undefined;
    }
    const run = await this.fromEntity(entity);
    if (isRunExpired(run, Date.now())) {
      await this.delete(runId);
      return undefined;
    }
    return run;
  }

  /** Overwrite an entity guarding on its ETag (CAS); returns false on 412 conflict. */
  private async putWithEtag(run: RunState, etag: string | undefined): Promise<boolean> {
    if (!etag || etag === "*") {
      throw new Error("Table run-state response is missing an entity ETag; refusing an unconditional update.");
    }
    const entity = await this.toEntity(run);
    const response = await this.fetchImpl(this.entityUrl(run.tenantId, run.runId), {
      method: "PUT",
      headers: await this.headers({ "If-Match": etag }),
      body: JSON.stringify(entity),
    });
    if (response.status === 412) {
      return false; // CAS lost — another replica won.
    }
    if (!response.ok) {
      this.logger?.error("Table run-state update rejected", {
        status: response.status,
        ...entityStorageStats(entity),
      });
      throw new Error(`Table update failed with status ${response.status}.`);
    }
    return true;
  }

  async update(
    runId: string,
    patch: Partial<Omit<RunState, "runId" | "tenantId" | "toolId" | "createdAt">>,
  ): Promise<RunState | undefined> {
    const entity = await this.fetchEntity(runId);
    if (!entity) {
      return undefined;
    }
    const current = await this.fromEntity(entity);
    const next: RunState = { ...current, ...patch, updatedAt: Date.now() };
    const ok = await this.putWithEtag(next, entity["odata.etag"]);
    // A lost race on a plain update means a concurrent writer moved on; the caller
    // treats undefined as "not applied" and re-reads if needed.
    return ok ? next : undefined;
  }

  async delete(runId: string): Promise<void> {
    const entity = await this.fetchEntity(runId);
    if (!entity) {
      return;
    }
    await this.fetchImpl(this.entityUrl(entity.PartitionKey, entity.RowKey), {
      method: "DELETE",
      headers: await this.headers({ "If-Match": "*" }),
    });
  }

  async answerInput(runId: string, questionId: string, response: HumanInputResponse): Promise<RunState | undefined> {
    const entity = await this.fetchEntity(runId);
    if (!entity) return undefined;
    const current = await this.fromEntity(entity);
    const next = answerRunInput(current, questionId, response, Date.now());
    if (!next || next === current) return next;
    // Compare and write against the SAME fetched version, never update()'s re-read.
    if (await this.putWithEtag(next, entity["odata.etag"])) return next;
    // A concurrent identical answer is an idempotent success, not another write.
    const latestEntity = await this.fetchEntity(runId);
    if (!latestEntity) return undefined;
    const latest = await this.fromEntity(latestEntity);
    return answerRunInput(latest, questionId, response, Date.now()) === latest ? latest : undefined;
  }

  async claim(
    runId: string,
    from: RunStatus[],
    to: RunStatus,
    options: ClaimOptions = {},
  ): Promise<RunState | undefined> {
    const now = options.now ?? Date.now();
    const entity = await this.fetchEntity(runId);
    if (!entity) {
      return undefined;
    }
    const current = await this.fromEntity(entity);
    if (isRunExpired(current, now) || !from.includes(current.status) || hasUnansweredHumanInput(current)) {
      return undefined;
    }
    if (current.status === "running" && (current.leaseExpiresAt ?? 0) > now) {
      return undefined;
    }
    const next: RunState = {
      ...current,
      status: to,
      leaseExpiresAt: now + (options.leaseMs ?? DEFAULT_LEASE_MS),
      updatedAt: now,
    };
    // ETag If-Match makes this a true CAS: a stale ETag (another replica claimed
    // first) fails 412 and we return undefined — exactly one winner.
    const won = await this.putWithEtag(next, entity["odata.etag"]);
    return won ? next : undefined;
  }

  async listClaimable(now: number = Date.now()): Promise<RunState[]> {
    // Azure Table's OData subset is inconsistent for cross-partition `or`
    // predicates. Query each status separately and merge by run id; the approved/
    // lease predicate remains an in-process decision.
    const queryStatus = async (status: "held" | "running"): Promise<RunEntity[]> => {
      const filter = encodeURIComponent(`status eq '${status}'`);
      const url = `${this.baseUrl}/${this.tableName}()?$filter=${filter}`;
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers: await this.headers(),
      });
      if (!response.ok) {
        throw new Error(`Table query failed with status ${response.status}.`);
      }
      const body = (await response.json()) as { value?: RunEntity[] };
      return body.value ?? [];
    };
    const candidates = [...(await queryStatus("held")), ...(await queryStatus("running"))];
    const unique = [...new Map(candidates.map((entity) => [entity.RowKey, entity])).values()];
    return (await Promise.all(unique.map((entity) => this.fromEntity(entity))))
      .filter((run) => !isRunExpired(run, now) && isRunClaimable(run, now));
  }

  async sweepExpired(now: number = Date.now()): Promise<number> {
    // Epoch milliseconds exceed Edm.Int32. Azure Table parses an un-suffixed
    // integer literal as Int32 and rejects it; `L` binds the comparison as Int64.
    const filter = encodeURIComponent(`expiresAt le ${now}L`);
    const url = `${this.baseUrl}/${this.tableName}()?$filter=${filter}`;
    const response = await this.fetchImpl(url, { method: "GET", headers: await this.headers() });
    if (!response.ok) {
      throw new Error(`Table query failed with status ${response.status}.`);
    }
    const body = (await response.json()) as { value?: RunEntity[] };
    let removed = 0;
    for (const entity of body.value ?? []) {
      await this.delete(entity.RowKey);
      removed += 1;
    }
    return removed;
  }
}
