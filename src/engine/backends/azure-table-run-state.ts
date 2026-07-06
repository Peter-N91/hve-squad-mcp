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
  isRunClaimable,
  isRunExpired,
  type ClaimOptions,
  type CreateRunInit,
  type RunState,
  type RunStateStore,
  type RunStatus,
} from "../run-state.js";
import { isValidRunId } from "../durable-run-state.js";
import { NullFieldCipher, decryptField, encryptField, type FieldCipher } from "../field-cipher.js";
import { randomUUID } from "node:crypto";
import type { RedactingLogger } from "../../observability/logger.js";

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
}

/** The wire shape of a run entity (flat property bag; Table Storage has no nesting). */
interface RunEntity {
  PartitionKey: string;
  RowKey: string;
  toolId: string;
  status: RunStatus;
  createdAt: number;
  updatedAt?: number;
  holdReason?: string;
  artifact?: string;
  request?: string;
  context?: string;
  approvedBy?: string;
  approvedAt?: number;
  expiresAt?: number;
  leaseExpiresAt?: number;
  /**
   * Phase 4 — the advisory composites are flattened to JSON strings (Table Storage
   * has no nesting). `stages`/`councilVerdict` carry caller/model text so they are
   * encrypted with the field cipher before serialization; `history` is metadata and
   * stored as plain JSON.
   */
  stages?: string;
  councilVerdict?: string;
  history?: string;
  "odata.etag"?: string;
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

  constructor(options: AzureTableRunStateStoreOptions) {
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

  private entityUrl(tenantId: string, runId: string): string {
    return `${this.baseUrl}/${this.tableName}(PartitionKey='${encodeURIComponent(tenantId)}',RowKey='${encodeURIComponent(runId)}')`;
  }

  /** Map a decrypted RunState to the sealed wire entity (request/context encrypted). */
  private toEntity(run: RunState): RunEntity {
    const entity: RunEntity = {
      PartitionKey: run.tenantId,
      RowKey: run.runId,
      toolId: run.toolId,
      status: run.status,
      createdAt: run.createdAt,
    };
    if (run.updatedAt !== undefined) entity.updatedAt = run.updatedAt;
    if (run.holdReason !== undefined) entity.holdReason = run.holdReason;
    if (run.artifact !== undefined) entity.artifact = run.artifact;
    const sealedRequest = encryptField(this.cipher, run.request);
    if (sealedRequest !== undefined) entity.request = sealedRequest;
    const sealedContext = encryptField(this.cipher, run.context);
    if (sealedContext !== undefined) entity.context = sealedContext;
    if (run.approvedBy !== undefined) entity.approvedBy = run.approvedBy;
    if (run.approvedAt !== undefined) entity.approvedAt = run.approvedAt;
    if (run.expiresAt !== undefined) entity.expiresAt = run.expiresAt;
    if (run.leaseExpiresAt !== undefined) entity.leaseExpiresAt = run.leaseExpiresAt;
    // Phase 4 — flatten + encrypt the advisory composites; history is plain metadata.
    if (run.stages !== undefined) {
      const sealedStages = encryptField(this.cipher, JSON.stringify(run.stages));
      if (sealedStages !== undefined) entity.stages = sealedStages;
    }
    if (run.councilVerdict !== undefined) {
      const sealedVerdict = encryptField(this.cipher, JSON.stringify(run.councilVerdict));
      if (sealedVerdict !== undefined) entity.councilVerdict = sealedVerdict;
    }
    if (run.history !== undefined) entity.history = JSON.stringify(run.history);
    return entity;
  }

  /** Map a wire entity back to a decrypted RunState. */
  private fromEntity(entity: RunEntity): RunState {
    return {
      runId: entity.RowKey,
      tenantId: entity.PartitionKey,
      toolId: entity.toolId,
      status: entity.status,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
      holdReason: entity.holdReason,
      artifact: entity.artifact,
      request: decryptField(this.cipher, entity.request),
      context: decryptField(this.cipher, entity.context),
      approvedBy: entity.approvedBy,
      approvedAt: entity.approvedAt,
      expiresAt: entity.expiresAt,
      leaseExpiresAt: entity.leaseExpiresAt,
      stages:
        entity.stages !== undefined
          ? (JSON.parse(decryptField(this.cipher, entity.stages) as string) as RunState["stages"])
          : undefined,
      councilVerdict:
        entity.councilVerdict !== undefined
          ? (JSON.parse(decryptField(this.cipher, entity.councilVerdict) as string) as RunState["councilVerdict"])
          : undefined,
      history: entity.history !== undefined ? (JSON.parse(entity.history) as RunState["history"]) : undefined,
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
    const response = await this.fetchImpl(`${this.baseUrl}/${this.tableName}`, {
      method: "POST",
      headers: await this.headers({ Prefer: "return-no-content" }),
      body: JSON.stringify(this.toEntity(run)),
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
    const run = this.fromEntity(entity);
    if (isRunExpired(run, Date.now())) {
      await this.delete(runId);
      return undefined;
    }
    return run;
  }

  /** Overwrite an entity guarding on its ETag (CAS); returns false on 412 conflict. */
  private async putWithEtag(run: RunState, etag: string | undefined): Promise<boolean> {
    const response = await this.fetchImpl(this.entityUrl(run.tenantId, run.runId), {
      method: "PUT",
      headers: await this.headers({ "If-Match": etag ?? "*" }),
      body: JSON.stringify(this.toEntity(run)),
    });
    if (response.status === 412) {
      return false; // CAS lost — another replica won.
    }
    if (!response.ok) {
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
    const current = this.fromEntity(entity);
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
    const current = this.fromEntity(entity);
    if (isRunExpired(current, now) || !from.includes(current.status)) {
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
    // Query the candidate statuses cross-partition; decide claimability in-process
    // (the OData filter cannot express the approved/lease predicate portably).
    const filter = encodeURIComponent("status eq 'held' or status eq 'running'");
    const url = `${this.baseUrl}/${this.tableName}()?$filter=${filter}`;
    const response = await this.fetchImpl(url, { method: "GET", headers: await this.headers() });
    if (!response.ok) {
      throw new Error(`Table query failed with status ${response.status}.`);
    }
    const body = (await response.json()) as { value?: RunEntity[] };
    return (body.value ?? [])
      .map((entity) => this.fromEntity(entity))
      .filter((run) => !isRunExpired(run, now) && isRunClaimable(run, now));
  }

  async sweepExpired(now: number = Date.now()): Promise<number> {
    const filter = encodeURIComponent(`expiresAt le ${now}`);
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
