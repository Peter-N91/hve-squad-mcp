/**
 * Azure Table one-time grant store for the server-owned OAuth authority.
 *
 * PartitionKey is the grant kind; RowKey is SHA-256(secret). Payloads are already
 * encrypted by the OAuth key ring. GET + ETag DELETE is the consume CAS: exactly
 * one replica can delete and receive a login, authorization, or refresh grant.
 */
import type { RedactingLogger } from "../observability/logger.js";
import {
  oauthSecretHash,
  type OAuthGrantKind,
  type OAuthGrantStore,
  type OAuthStoredGrant,
} from "./oauth-store.js";

const TABLE_API_VERSION = "2019-02-02";

interface OAuthGrantEntity {
  PartitionKey: OAuthGrantKind;
  RowKey: string;
  payload: string;
  /** Azure Table requires Int64 values to be decimal strings with type annotations. */
  expiresAt: string;
  "expiresAt@odata.type": "Edm.Int64";
  createdAt: string;
  "createdAt@odata.type": "Edm.Int64";
  consumed?: boolean;
  "odata.etag"?: string;
}

export interface AzureTableOAuthGrantStoreOptions {
  account: string;
  tableName: string;
  getAccessToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
  logger?: RedactingLogger;
  endpoint?: string;
  now?: () => number;
}

export class AzureTableOAuthGrantStore implements OAuthGrantStore {
  private readonly tableName: string;
  private readonly getAccessToken: () => Promise<string>;
  private readonly fetchImpl: typeof fetch;
  private readonly logger?: RedactingLogger;
  private readonly baseUrl: string;
  private readonly now: () => number;
  private tableEnsured?: Promise<void>;

  constructor(options: AzureTableOAuthGrantStoreOptions) {
    this.tableName = options.tableName;
    this.getAccessToken = options.getAccessToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    const endpoint = options.endpoint ?? `https://${options.account}.table.core.windows.net`;
    this.baseUrl = endpoint.replace(/\/$/, "");
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
    if (response.status === 201 || response.status === 204 || response.status === 409) {
      return;
    }
    throw new Error(`OAuth table create failed with status ${response.status}.`);
  }

  private entityUrl(kind: OAuthGrantKind, secret: string): string {
    return this.entityUrlByRowKey(kind, oauthSecretHash(secret));
  }

  private entityUrlByRowKey(kind: OAuthGrantKind, rowKey: string): string {
    return `${this.baseUrl}/${this.tableName}(PartitionKey='${kind}',RowKey='${rowKey}')`;
  }

  async put(kind: OAuthGrantKind, secret: string, grant: OAuthStoredGrant): Promise<void> {
    await this.ensureTable();
    const entity: OAuthGrantEntity = {
      PartitionKey: kind,
      RowKey: oauthSecretHash(secret),
      payload: grant.payload,
      expiresAt: String(grant.expiresAt),
      "expiresAt@odata.type": "Edm.Int64",
      createdAt: String(this.now()),
      "createdAt@odata.type": "Edm.Int64",
    };
    const response = await this.fetchImpl(`${this.baseUrl}/${this.tableName}`, {
      method: "POST",
      headers: await this.headers({ Prefer: "return-no-content" }),
      body: JSON.stringify(entity),
    });
    if (response.status === 201 || response.status === 204) {
      return;
    }
    if (response.status === 409) {
      throw new Error("OAuth grant collision.");
    }
    throw new Error(`OAuth grant write failed with status ${response.status}.`);
  }

  async consume(
    kind: OAuthGrantKind,
    secret: string,
  ): Promise<OAuthStoredGrant | undefined> {
    const url = this.entityUrl(kind, secret);
    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: await this.headers(),
    });
    if (response.status === 404) {
      return undefined;
    }
    if (!response.ok) {
      throw new Error(`OAuth grant read failed with status ${response.status}.`);
    }
    const entity = (await response.json()) as OAuthGrantEntity;
    const expiresAt = Number(entity.expiresAt);
    if (!Number.isSafeInteger(expiresAt) || expiresAt < 0) {
      throw new Error("OAuth grant read returned an invalid expiresAt value.");
    }
    const etag = response.headers.get("etag") ?? entity["odata.etag"];
    if (!etag) {
      throw new Error("OAuth grant read returned no ETag.");
    }

    const removed = await this.fetchImpl(url, {
      method: "DELETE",
      headers: await this.headers({ "If-Match": etag }),
    });
    if (removed.status === 404 || removed.status === 412) {
      return undefined;
    }
    if (removed.status !== 204) {
      throw new Error(`OAuth grant consume failed with status ${removed.status}.`);
    }
    if (expiresAt <= this.now()) {
      return undefined;
    }
    return { payload: entity.payload, expiresAt };
  }

  async consumeWithTombstone(
    kind: OAuthGrantKind,
    secret: string,
    makeTombstone: (grant: OAuthStoredGrant) => OAuthStoredGrant,
  ): Promise<
    | { status: "consumed"; grant: OAuthStoredGrant }
    | { status: "replayed"; tombstone: OAuthStoredGrant }
    | undefined
  > {
    const url = this.entityUrl(kind, secret);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers: await this.headers(),
      });
      if (response.status === 404) {
        return undefined;
      }

      if (!response.ok) {
        throw new Error(`OAuth grant read failed with status ${response.status}.`);
      }
      const entity = (await response.json()) as OAuthGrantEntity;
      const expiresAt = Number(entity.expiresAt);
      if (!Number.isSafeInteger(expiresAt) || expiresAt <= this.now()) {
        return undefined;
      }
      if (entity.consumed === true) {
        return {
          status: "replayed",
          tombstone: { payload: entity.payload, expiresAt },
        };
      }
      const etag = response.headers.get("etag") ?? entity["odata.etag"];
      if (!etag) {
        throw new Error("OAuth grant read returned no ETag.");
      }
      const original = { payload: entity.payload, expiresAt };
      const tombstone = makeTombstone(original);
      const replacement: OAuthGrantEntity = {
        ...entity,
        payload: tombstone.payload,
        expiresAt: String(tombstone.expiresAt),
        "expiresAt@odata.type": "Edm.Int64",
        consumed: true,
      };
      delete replacement["odata.etag"];
      const updated = await this.fetchImpl(url, {
        method: "PUT",
        headers: await this.headers({
          "If-Match": etag,
          Prefer: "return-no-content",
        }),
        body: JSON.stringify(replacement),
      });
      if (updated.status === 204) {
        return { status: "consumed", grant: original };
      }
      if (updated.status !== 412) {
        throw new Error(`OAuth grant tombstone failed with status ${updated.status}.`);
      }
    }
    return undefined;
  }

  async update(
    kind: OAuthGrantKind,
    secret: string,
    transform: (grant: OAuthStoredGrant) => OAuthStoredGrant | undefined,
  ): Promise<"updated" | "missing" | "rejected"> {
    const url = this.entityUrl(kind, secret);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers: await this.headers(),
      });
      if (response.status === 404) {
        return "missing";
      }
      if (!response.ok) {
        throw new Error(`OAuth grant read failed with status ${response.status}.`);
      }
      const entity = (await response.json()) as OAuthGrantEntity;
      const expiresAt = Number(entity.expiresAt);
      if (!Number.isSafeInteger(expiresAt) || expiresAt <= this.now()) {
        return "missing";
      }
      if (entity.consumed === true) {
        return "rejected";
      }
      const etag = response.headers.get("etag") ?? entity["odata.etag"];
      if (!etag) {
        throw new Error("OAuth grant read returned no ETag.");
      }
      const updatedGrant = transform({ payload: entity.payload, expiresAt });
      if (!updatedGrant) {
        return "rejected";
      }
      const replacement: OAuthGrantEntity = {
        ...entity,
        payload: updatedGrant.payload,
        expiresAt: String(updatedGrant.expiresAt),
        "expiresAt@odata.type": "Edm.Int64",
      };
      delete replacement["odata.etag"];
      const updated = await this.fetchImpl(url, {
        method: "PUT",
        headers: await this.headers({
          "If-Match": etag,
          Prefer: "return-no-content",
        }),
        body: JSON.stringify(replacement),
      });
      if (updated.status === 204) {
        return "updated";
      }
      if (updated.status !== 412) {
        throw new Error(`OAuth grant update failed with status ${updated.status}.`);
      }
    }
    return "rejected";
  }

  async sweepExpired(limit = 100): Promise<number> {
    const boundedLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    const query = new URL(`${this.baseUrl}/${this.tableName}`);
    query.searchParams.set("$filter", `expiresAt lt ${this.now()}L`);
    query.searchParams.set("$select", "PartitionKey,RowKey");
    query.searchParams.set("$top", String(boundedLimit));
    const response = await this.fetchImpl(query, {
      method: "GET",
      headers: await this.headers(),
    });
    if (response.status === 404) {
      return 0;
    }
    if (!response.ok) {
      throw new Error(`OAuth grant sweep query failed with status ${response.status}.`);
    }
    const body = (await response.json()) as {
      value?: { PartitionKey?: string; RowKey?: string }[];
    };
    let removed = 0;
    for (const entity of body.value ?? []) {
      const kind = entity.PartitionKey as OAuthGrantKind | undefined;
      const rowKey = entity.RowKey;
      if (!kind || !rowKey) {
        continue;
      }
      const deleted = await this.fetchImpl(this.entityUrlByRowKey(kind, rowKey), {
        method: "DELETE",
        headers: await this.headers({ "If-Match": "*" }),
      });
      if (deleted.status === 204) {
        removed += 1;
      } else if (deleted.status !== 404 && deleted.status !== 412) {
        throw new Error(`OAuth grant sweep delete failed with status ${deleted.status}.`);
      }
    }
    return removed;
  }
}
