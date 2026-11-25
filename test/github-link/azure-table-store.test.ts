import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, describe, it } from "node:test";

import { principalKeyOf } from "../../src/auth/entra.js";
import { AesGcmFieldCipher, NullFieldCipher } from "../../src/engine/field-cipher.js";
import { PrincipalVault } from "../../src/auth/principal-vault.js";
import {
  AzureTableGitHubLinkStore,
  AzureTableLinkFlowStore,
  MAX_STRING_PROPERTY_CHARS,
} from "../../src/github-link/azure-table-store.js";
import type { LinkFlowEntry } from "../../src/github-link/flow-store.js";
import { LINK_START_PATH, type GitHubLinkService } from "../../src/github-link/service.js";
import type { GitHubLinkRecord, LinkLogger } from "../../src/github-link/types.js";
import {
  ALICE,
  BOB,
  Browser,
  GH_ALICE,
  GH_BOB,
  TENANT,
  asIdentity,
  runLinkFlow,
  startHarness,
  type Harness,
} from "./harness.js";

const sha256Hex = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const ACCESS_TOKEN = "TOKEN-sealed-access-AAAA";
const REFRESH_TOKEN = "TOKEN-sealed-refresh-BBBB";
const BEARER = "fake-bearer-credential-123";

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

interface Row {
  entity: Record<string, unknown>;
  etag: string;
}

/**
 * A fake Azure Table Storage account. It emulates the semantics the stores rely on:
 * idempotent table create, insert (409 on duplicate), point read with ETag, replace
 * and delete guarded by If-Match (412 on mismatch, 404 when absent), a filter query,
 * and the 64 KiB string property limit. A PUT or DELETE without If-Match is rejected
 * (400) so any accidental upsert fails the test.
 */
class FakeTableStorage {
  readonly tables = new Map<string, Map<string, Row>>();
  readonly requests: RecordedRequest[] = [];
  /** Statuses to answer with (before touching state) for the next matching requests. */
  readonly failures: Array<{ status: number; body?: string; times: number; match?: (r: RecordedRequest) => boolean }> = [];
  onRequest?: (request: RecordedRequest) => Promise<void> | void;
  omitEtagHeader = false;
  private tick = 0;

  rows(table: string): Map<string, Row> {
    return this.tables.get(table) ?? new Map();
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const request: RecordedRequest = {
      method: init?.method ?? "GET",
      url,
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    this.requests.push(request);
    await this.onRequest?.(request);
    await Promise.resolve();
    return this.handle(request);
  };

  private etag(): string {
    this.tick += 1;
    return `W/"datetime'2026-10-17T08%3A00%3A00.${String(this.tick).padStart(7, "0")}Z'"`;
  }

  private respond(status: number, extra: { etag?: string; json?: unknown } = {}): Response {
    const headers: Record<string, string> = {};
    if (extra.etag && !this.omitEtagHeader) headers.etag = extra.etag;
    if (extra.json !== undefined) headers["content-type"] = "application/json";
    return new Response(extra.json === undefined ? null : JSON.stringify(extra.json), { status, headers });
  }

  private handle(request: RecordedRequest): Response {
    const injected = this.failures.find((f) => f.times > 0 && (f.match?.(request) ?? true));
    if (injected) {
      injected.times -= 1;
      return new Response(injected.body ?? null, { status: injected.status });
    }
    if (request.headers.Authorization !== `Bearer ${BEARER}` || !request.headers["x-ms-version"] || !request.headers["x-ms-date"]) {
      return this.respond(401);
    }
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path === "/Tables") {
      const { TableName } = JSON.parse(request.body ?? "{}") as { TableName: string };
      if (this.tables.has(TableName)) return this.respond(409);
      this.tables.set(TableName, new Map());
      return this.respond(204);
    }
    const insert = /^\/([A-Za-z0-9]+)$/.exec(path);
    if (request.method === "POST" && insert) {
      const table = this.tables.get(insert[1]);
      if (!table) return this.respond(404);
      const entity = JSON.parse(request.body ?? "{}") as Record<string, unknown>;
      const problem = this.validate(entity);
      if (problem) return this.respond(400);
      const key = `${entity.PartitionKey}\u0000${entity.RowKey}`;
      if (table.has(key)) return this.respond(409);
      const etag = this.etag();
      table.set(key, { entity, etag });
      return this.respond(204, { etag });
    }
    const query = /^\/([A-Za-z0-9]+)\(\)$/.exec(path);
    if (request.method === "GET" && query) {
      const table = this.tables.get(query[1]);
      if (!table) return this.respond(404);
      const filter = new URL(request.url).searchParams.get("$filter") ?? "";
      const match = /^expiresAtIso lt '([^']+)'$/.exec(filter);
      if (!match) return this.respond(400);
      const value = [...table.values()]
        .filter((row) => (row.entity.expiresAtIso as string) < match[1])
        .map((row) => ({ PartitionKey: row.entity.PartitionKey, RowKey: row.entity.RowKey }));
      return this.respond(200, { json: { value } });
    }
    const point = /^\/([A-Za-z0-9]+)\(PartitionKey='([^']*)',RowKey='([^']*)'\)$/.exec(path);
    if (!point) return this.respond(400);
    const table = this.tables.get(point[1]);
    const key = `${decodeURIComponent(point[2])}\u0000${decodeURIComponent(point[3])}`;
    const row = table?.get(key);
    if (request.method === "GET") {
      if (!row) return this.respond(404);
      const accept = request.headers.Accept ?? "";
      const withEtag = accept.includes("fullmetadata") && !this.omitEtagHeader;
      const body = withEtag ? { ...row.entity, "odata.etag": row.etag } : row.entity;
      return this.respond(200, { etag: row.etag, json: body });
    }
    const ifMatch = request.headers["If-Match"];
    if (ifMatch === undefined) return this.respond(400); // would be an upsert or unconditional delete
    if (!table || !row) return this.respond(404);
    if (ifMatch !== "*" && ifMatch !== row.etag) return this.respond(412);
    if (request.method === "DELETE") {
      table.delete(key);
      return this.respond(204);
    }
    if (request.method === "PUT") {
      const entity = JSON.parse(request.body ?? "{}") as Record<string, unknown>;
      if (this.validate(entity)) return this.respond(400);
      const etag = this.etag();
      table.set(key, { entity, etag });
      return this.respond(204, { etag });
    }
    return this.respond(405);
  }

  private validate(entity: Record<string, unknown>): string | undefined {
    for (const name of ["PartitionKey", "RowKey"]) {
      const value = entity[name];
      if (typeof value !== "string" || value === "" || /[/\\#?\u0000-\u001f]/.test(value)) return `bad ${name}`;
    }
    for (const value of Object.values(entity)) {
      if (typeof value === "string" && value.length * 2 > 64 * 1024) return "string too large";
    }
    return undefined;
  }

  /** Every request line and body, for "this secret never left in a URL" checks. */
  urls(): string[] {
    return this.requests.map((r) => r.url);
  }
}

class CapturingLogger implements LinkLogger {
  readonly lines: string[] = [];
  readonly secrets: string[] = [];
  info(message: string, fields?: Record<string, unknown>): void {
    this.lines.push(JSON.stringify([message, fields]));
  }
  warn(message: string, fields?: Record<string, unknown>): void {
    this.lines.push(JSON.stringify([message, fields]));
  }
  error(message: string, fields?: Record<string, unknown>): void {
    this.lines.push(JSON.stringify([message, fields]));
  }
  registerSecret(value: string | undefined | null): void {
    if (value) this.secrets.push(value);
  }
}

const noSleep = async () => undefined;

function linkStore(table: FakeTableStorage, extra: Partial<ConstructorParameters<typeof AzureTableGitHubLinkStore>[0]> = {}) {
  return new AzureTableGitHubLinkStore({
    account: "fakeacct",
    tableName: "githublinks",
    getAccessToken: async () => BEARER,
    fetchImpl: table.fetch,
    sleep: noSleep,
    ...extra,
  });
}

function flowStore(table: FakeTableStorage, extra: Partial<ConstructorParameters<typeof AzureTableLinkFlowStore>[0]> = {}) {
  return new AzureTableLinkFlowStore({
    account: "fakeacct",
    tableName: "githublinkflows",
    getAccessToken: async () => BEARER,
    fetchImpl: table.fetch,
    sleep: noSleep,
    cipher: new AesGcmFieldCipher(Buffer.alloc(32, 7)),
    ...extra,
  });
}

function record(overrides: Partial<GitHubLinkRecord> = {}): GitHubLinkRecord {
  return {
    tenantId: TENANT,
    oid: ALICE.objectId,
    githubUserId: 1001,
    githubLogin: "alice-gh",
    tokenKind: "ghu",
    accessTokenEnc: ACCESS_TOKEN,
    refreshTokenEnc: REFRESH_TOKEN,
    accessExpiresAt: "2026-10-17T16:00:00.000Z",
    refreshExpiresAt: "2027-04-19T08:00:00.000Z",
    credentialVersion: 1,
    linkedAt: "2026-10-17T08:00:00.000Z",
    updatedAt: "2026-10-17T08:00:00.000Z",
    ...overrides,
  };
}

const KEY = principalKeyOf(ALICE);

describe("AzureTableGitHubLinkStore", () => {
  it("round-trips a full record and maps keys as PartitionKey=sha256(tenant), RowKey=oid", async () => {
    const table = new FakeTableStorage();
    const store = linkStore(table);
    const lease = { id: "lease-1", expiresAt: "2026-10-17T08:00:30.000Z" };
    const created = await store.putIfMatch(record({ refreshLease: lease }), undefined);
    assert.equal(created.ok, true);
    const got = await store.get(KEY);
    assert.ok(got);
    assert.deepEqual(got.record, record({ refreshLease: lease }));
    assert.equal(got.etag, (created as { etag: string }).etag);
    const [row] = [...table.rows("githublinks").values()];
    assert.equal(row.entity.PartitionKey, sha256Hex(TENANT));
    assert.equal(row.entity.RowKey, ALICE.objectId);
    assert.equal(row.entity.githubUserId, "1001");
    assert.equal(row.entity.accessTokenEnc, ACCESS_TOKEN);
  });

  it("round-trips a record without optional fields (gho token, no refresh, no lease)", async () => {
    const table = new FakeTableStorage();
    const store = linkStore(table);
    const minimal = record({
      tokenKind: "gho",
      refreshTokenEnc: undefined,
      accessExpiresAt: undefined,
      refreshExpiresAt: undefined,
    });
    delete minimal.refreshTokenEnc;
    delete minimal.accessExpiresAt;
    delete minimal.refreshExpiresAt;
    await store.putIfMatch(minimal, undefined);
    assert.deepEqual((await store.get(KEY))?.record, minimal);
  });

  it("an update replaces the entity, so a released lease really disappears", async () => {
    const table = new FakeTableStorage();
    const store = linkStore(table);
    const first = await store.putIfMatch(record({ refreshLease: { id: "l", expiresAt: "2026-10-17T08:00:30.000Z" } }), undefined);
    assert.ok(first.ok);
    const second = await store.putIfMatch(record({ credentialVersion: 2 }), first.etag);
    assert.ok(second.ok);
    assert.notEqual(second.etag, first.etag);
    const got = await store.get(KEY);
    assert.equal(got?.record.refreshLease, undefined);
    assert.equal(got?.record.credentialVersion, 2);
    assert.equal(got?.etag, second.etag);
  });

  it("returns undefined for a missing row, with and without the table existing", async () => {
    const table = new FakeTableStorage();
    const store = linkStore(table);
    assert.equal(await store.get(KEY), undefined);
    await store.putIfMatch(record({ oid: BOB.objectId }), undefined);
    assert.equal(await store.get(KEY), undefined);
  });

  it("reports conflicts as {ok:false}, never as exceptions", async () => {
    const table = new FakeTableStorage();
    const store = linkStore(table);
    const first = await store.putIfMatch(record(), undefined);
    assert.ok(first.ok);
    assert.deepEqual(await store.putIfMatch(record(), undefined), { ok: false }); // 409 duplicate insert
    assert.deepEqual(await store.putIfMatch(record({ credentialVersion: 2 }), "W/\"stale\""), { ok: false }); // 412
    const gone = linkStore(new FakeTableStorage());
    assert.deepEqual(await gone.putIfMatch(record(), "W/\"x\""), { ok: false }); // 404 no table or no row
    assert.equal((await store.get(KEY))?.record.credentialVersion, 1);
    assert.equal((await store.get(KEY))?.etag, first.etag);
  });

  it("two stores sharing one table: exactly one concurrent writer wins the CAS", async () => {
    const table = new FakeTableStorage();
    const a = linkStore(table);
    const b = linkStore(table);
    const seed = await a.putIfMatch(record(), undefined);
    assert.ok(seed.ok);
    const seenA = await a.get(KEY);
    const seenB = await b.get(KEY);
    assert.equal(seenA?.etag, seenB?.etag);
    const [ra, rb] = await Promise.all([
      a.putIfMatch(record({ credentialVersion: 2, githubLogin: "from-a" }), seenA?.etag),
      b.putIfMatch(record({ credentialVersion: 2, githubLogin: "from-b" }), seenB?.etag),
    ]);
    assert.equal([ra, rb].filter((r) => r.ok).length, 1);
    const final = await a.get(KEY);
    assert.equal(final?.record.githubLogin, ra.ok ? "from-a" : "from-b");
    // Concurrent create-only: one insert wins.
    const [c1, c2] = await Promise.all([
      a.putIfMatch(record({ oid: BOB.objectId }), undefined),
      b.putIfMatch(record({ oid: BOB.objectId }), undefined),
    ]);
    assert.equal([c1, c2].filter((r) => r.ok).length, 1);
  });

  it("delete: wrong etag keeps the row, right etag or no etag removes it, missing row is false", async () => {
    const table = new FakeTableStorage();
    const store = linkStore(table);
    const first = await store.putIfMatch(record(), undefined);
    assert.ok(first.ok);
    assert.equal(await store.delete(KEY, "W/\"stale\""), false);
    assert.ok(await store.get(KEY));
    assert.equal(await store.delete(KEY, first.etag), true);
    assert.equal(await store.delete(KEY, first.etag), false);
    await store.putIfMatch(record(), undefined);
    assert.equal(await store.delete(KEY), true);
    assert.equal(await store.get(KEY), undefined);
    assert.equal(await store.delete(KEY), false);
  });

  it("uses the run-state conventions: headers, one table create, conditional writes only", async () => {
    const table = new FakeTableStorage();
    const store = linkStore(table);
    const first = await store.putIfMatch(record(), undefined);
    assert.ok(first.ok);
    await store.putIfMatch(record({ credentialVersion: 2 }), first.etag);
    await store.putIfMatch(record({ oid: BOB.objectId }), undefined);
    await store.get(KEY);
    await store.delete(KEY, "*");
    assert.equal(table.requests.filter((r) => r.url.endsWith("/Tables")).length, 1);
    for (const r of table.requests) {
      assert.equal(r.headers.Authorization, `Bearer ${BEARER}`);
      assert.equal(r.headers["x-ms-version"], "2019-02-02");
      assert.ok(r.url.startsWith("https://fakeacct.table.core.windows.net/"));
      if (r.method === "GET") assert.equal(r.headers.Accept, "application/json;odata=fullmetadata");
      else assert.equal(r.headers.Accept, "application/json;odata=nomsmetadata");
      if (r.method === "POST" || r.method === "PUT") assert.equal(r.headers.Prefer, "return-no-content");
    }
    for (const r of table.requests.filter((x) => x.method === "PUT")) {
      assert.ok(r.headers["If-Match"] && r.headers["If-Match"] !== "*");
    }
    await assert.rejects(() => store.putIfMatch(record(), "*"), /unconditional/);
    await assert.rejects(() => store.putIfMatch(record(), ""), /unconditional/);
  });

  it("retries the table create after a failure instead of caching the rejection", async () => {
    const table = new FakeTableStorage();
    table.failures.push({ status: 500, times: 1, match: (r) => r.url.endsWith("/Tables") });
    const store = linkStore(table);
    await assert.rejects(() => store.putIfMatch(record(), undefined), /Table create failed with status 500/);
    assert.equal((await store.putIfMatch(record(), undefined)).ok, true);
  });

  it("never puts sealed token fields or the bearer in a URL, and never logs them", async () => {
    const table = new FakeTableStorage();
    const logger = new CapturingLogger();
    const store = linkStore(table, { logger });
    table.failures.push({ status: 429, times: 1, match: (r) => r.method === "POST" && !r.url.endsWith("/Tables") });
    const first = await store.putIfMatch(record(), undefined);
    assert.ok(first.ok);
    await store.get(KEY);
    await store.putIfMatch(record({ credentialVersion: 2 }), first.etag);
    await store.delete(KEY);
    for (const url of table.urls()) {
      assert.ok(!url.includes(ACCESS_TOKEN) && !url.includes(REFRESH_TOKEN) && !url.includes(BEARER), url);
    }
    assert.ok(logger.lines.length > 0, "the throttle retry should have been logged");
    const logged = logger.lines.join("\n");
    assert.ok(!logged.includes(ACCESS_TOKEN) && !logged.includes(REFRESH_TOKEN) && !logged.includes(BEARER));
    assert.ok(logger.secrets.includes(BEARER));
  });

  it("rejects malformed ids before any request is made", async () => {
    const table = new FakeTableStorage();
    const store = linkStore(table);
    const bad = [
      "",
      "no-separator",
      `${TENANT}|`,
      `|${ALICE.objectId}`,
      `${TENANT}|a/b`,
      `${TENANT}|a\\b`,
      `${TENANT}|a#b`,
      `${TENANT}|a?b`,
      `${TENANT}|a'b`,
      `${TENANT}|a b`,
      `${TENANT}|../x`,
      `${TENANT}|${"a".repeat(65)}`,
      `te/nant|${ALICE.objectId}`,
      `${TENANT}|a\u0000b`,
    ];
    for (const key of bad) {
      await assert.rejects(() => store.get(key), /malformed/, JSON.stringify(key));
      await assert.rejects(() => store.delete(key), /malformed/, JSON.stringify(key));
    }
    await assert.rejects(() => store.putIfMatch(record({ oid: "a/b" }), undefined), /malformed/);
    await assert.rejects(() => store.putIfMatch(record({ tenantId: "t|x" }), "W/\"e\""), /malformed/);
    await assert.rejects(() => store.putIfMatch(record({ githubUserId: 1.5 }), undefined), /safe integer/);
    assert.equal(table.requests.length, 0);
  });

  it("validates operator configuration", () => {
    const base = { account: "fakeacct", tableName: "githublinks", getAccessToken: async () => BEARER };
    assert.throws(() => new AzureTableGitHubLinkStore({ ...base, account: "Bad/Account" }), /account/);
    assert.throws(() => new AzureTableGitHubLinkStore({ ...base, tableName: "bad-name" }), /Table name/);
    assert.doesNotThrow(() => new AzureTableGitHubLinkStore({ ...base, account: "x", endpoint: "http://127.0.0.1:10002/devstoreaccount1" }));
  });

  it("fails loudly when a sealed field is near the 64 KiB property limit, before any request", async () => {
    const table = new FakeTableStorage();
    const store = linkStore(table);
    const huge = "S".repeat(MAX_STRING_PROPERTY_CHARS + 1);
    await assert.rejects(() => store.putIfMatch(record({ accessTokenEnc: huge }), undefined), /accessTokenEnc.*limit/);
    await assert.rejects(() => store.putIfMatch(record({ refreshTokenEnc: huge }), "W/\"e\""), /refreshTokenEnc.*limit/);
    assert.equal(table.requests.length, 0);
    assert.ok(MAX_STRING_PROPERTY_CHARS * 2 <= 64 * 1024 / 2, "the cap leaves at least 2x headroom under 64 KiB");
    const fits = "S".repeat(MAX_STRING_PROPERTY_CHARS);
    assert.equal((await store.putIfMatch(record({ accessTokenEnc: fits }), undefined)).ok, true);
  });

  it("throws status-only errors for unexpected failures and never echoes the response body", async () => {
    const table = new FakeTableStorage();
    const store = linkStore(table);
    await store.putIfMatch(record(), undefined);
    table.failures.push({ status: 500, body: `boom ${ACCESS_TOKEN}`, times: 3 });
    for (const action of [() => store.get(KEY), () => store.delete(KEY), () => store.putIfMatch(record(), "W/\"e\"")]) {
      await assert.rejects(action, (error: Error) => /status 500\.$/.test(error.message) && !error.message.includes(ACCESS_TOKEN));
    }
  });

  it("retries 429 and 503 a bounded number of times, then surfaces the status", async () => {
    const table = new FakeTableStorage();
    const store = linkStore(table, { maxRetries: 2 });
    await store.putIfMatch(record(), undefined);
    table.failures.push({ status: 429, times: 2, match: (r) => r.method === "GET" });
    assert.ok(await store.get(KEY));
    table.failures.push({ status: 503, times: 5, match: (r) => r.method === "GET" });
    await assert.rejects(() => store.get(KEY), /status 503/);
    assert.equal(table.failures.find((f) => f.status === 503)?.times, 2);
  });

  it("refuses to proceed when Table Storage returns no ETag", async () => {
    const table = new FakeTableStorage();
    const store = linkStore(table);
    table.omitEtagHeader = true;
    await assert.rejects(() => store.putIfMatch(record(), undefined), /missing an entity ETag/);
    await assert.rejects(() => store.get(KEY), /missing an entity ETag/);
  });

  it("rejects a planted or malformed entity instead of serving it", async () => {
    const table = new FakeTableStorage();
    const store = linkStore(table);
    await store.putIfMatch(record(), undefined);
    const [row] = [...table.rows("githublinks").values()];
    row.entity.tenantId = "99999999-9999-4999-8999-999999999999";
    await assert.rejects(() => store.get(KEY), /malformed/);
    row.entity.tenantId = TENANT;
    row.entity.tokenKind = "evil";
    await assert.rejects(() => store.get(KEY), /malformed/);
    row.entity.tokenKind = "ghu";
    delete row.entity.accessTokenEnc;
    await assert.rejects(() => store.get(KEY), /malformed/);
  });
});

function flowEntry(overrides: Partial<LinkFlowEntry> = {}): LinkFlowEntry {
  return {
    kind: "entra",
    principal: { tenantId: TENANT, objectId: ALICE.objectId },
    allowRebind: false,
    expiresAtMs: 2_000_000,
    codeVerifier: "pkce-verifier-PLAINTEXT-123456",
    oidcNonce: "oidc-nonce-PLAINTEXT",
    browserHash: "b".repeat(64),
    ...overrides,
  };
}

const FLOW_KEY = `entra:${"a".repeat(64)}`;

describe("AzureTableLinkFlowStore", () => {
  it("refuses shared plaintext state, including an explicitly supplied null cipher", () => {
    const table = new FakeTableStorage();
    assert.throws(() => flowStore(table, { cipher: undefined }), /encryption is required/);
    assert.throws(() => flowStore(table, { cipher: new NullFieldCipher() }), /encryption is required/);
  });

  it("binds sealed flow payloads to their row key with AEAD and supports key rotation", async () => {
    const table = new FakeTableStorage();
    const old = Buffer.alloc(32, 3);
    const current = Buffer.alloc(32, 4);
    const before = flowStore(table, { cipher: new PrincipalVault("old", { old }) });
    const after = flowStore(table, { cipher: new PrincipalVault("current", { old, current }) });
    await before.put(FLOW_KEY, flowEntry());
    assert.deepEqual(await after.take(FLOW_KEY, 1_000_000), flowEntry());
    await after.put(FLOW_KEY, flowEntry());
    const otherKey = `entra:${"f".repeat(64)}`;
    await after.put(otherKey, flowEntry());
    const rows = [...table.rows("githublinkflows").values()];
    rows[1].entity.payload = rows[0].entity.payload;
    await assert.rejects(after.take(otherKey, 1_000_000), /authentication failed/);
    assert.equal(await after.take(otherKey, 1_000_000), undefined, "invalid payload is still single-use");
    assert.match(String(rows[0].entity.payload), /^v1\.current\./);
  });

  it("round-trips link generation and fail-closed refresh markers across replicas", async () => {
    const table = new FakeTableStorage();
    const store = linkStore(table);
    const value = record({ linkGeneration: "synthetic-generation", state: "reauth-required" });
    await store.putIfMatch(value, undefined);
    assert.deepEqual((await linkStore(table).get(KEY))?.record, value);
  });

  it("bounds flow lifetime, cleanup batch size and retry policy", async () => {
    const table = new FakeTableStorage();
    const store = flowStore(table);
    await assert.rejects(store.put(FLOW_KEY, flowEntry({ expiresAtMs: Date.now() + 601_000 })), /ten minutes/);
    for (const limit of [0, 1001, Number.NaN]) await assert.rejects(store.sweepExpired(100, limit), /limit/);
    assert.throws(() => flowStore(table, { maxRetries: 9 }), /retry count/);
    assert.equal(table.requests.length, 0);
  });

  it("does not replay ambiguous mutation failures", async () => {
    const table = new FakeTableStorage();
    const store = flowStore(table);
    await store.put(FLOW_KEY, flowEntry());
    table.failures.push({ status: 503, times: 1, match: request => request.method === "DELETE" });
    const before = table.requests.filter(request => request.method === "DELETE").length;
    await assert.rejects(store.take(FLOW_KEY, 1_000_000), /status 503/);
    assert.equal(table.requests.filter(request => request.method === "DELETE").length - before, 1);
  });

  it("put then take returns the entry exactly once", async () => {
    const table = new FakeTableStorage();
    const store = flowStore(table);
    await store.put(FLOW_KEY, flowEntry());
    assert.deepEqual(await store.take(FLOW_KEY, 1_000_000), flowEntry());
    assert.equal(await store.take(FLOW_KEY, 1_000_000), undefined);
    assert.equal(table.rows("githublinkflows").size, 0);
    assert.equal(await store.take(`entra:${"c".repeat(64)}`, 1_000_000), undefined);
  });

  it("a concurrent take of one nonce from two store instances yields exactly one success", async () => {
    const table = new FakeTableStorage();
    const a = flowStore(table);
    const b = flowStore(table);
    await a.put(FLOW_KEY, flowEntry());
    // Hold both reads until both replicas have seen the entity, so both try to delete it.
    let reads = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((resolve) => (release = resolve));
    table.onRequest = async (request) => {
      if (request.method === "GET" && request.url.includes("PartitionKey=")) {
        reads += 1;
        if (reads === 2) release();
        await bothRead;
      }
    };
    const results = await Promise.all([a.take(FLOW_KEY, 1_000_000), b.take(FLOW_KEY, 1_000_000)]);
    assert.equal(reads, 2);
    assert.equal(results.filter((r) => r !== undefined).length, 1);
    const deletes = table.requests.filter((r) => r.method === "DELETE");
    assert.equal(deletes.length, 2);
    for (const d of deletes) assert.ok(d.headers["If-Match"] && d.headers["If-Match"] !== "*");
  });

  it("many racing takers still produce a single winner", async () => {
    const table = new FakeTableStorage();
    const stores = Array.from({ length: 6 }, () => flowStore(table));
    await stores[0].put(FLOW_KEY, flowEntry());
    const results = await Promise.all(stores.map((s) => s.take(FLOW_KEY, 1_000_000)));
    assert.equal(results.filter((r) => r !== undefined).length, 1);
  });

  it("rejects an expired entry and removes it", async () => {
    const table = new FakeTableStorage();
    const store = flowStore(table);
    await store.put(FLOW_KEY, flowEntry({ expiresAtMs: 1_000_000 }));
    assert.equal(await store.take(FLOW_KEY, 1_000_001), undefined);
    assert.equal(table.rows("githublinkflows").size, 0);
    await store.put(FLOW_KEY, flowEntry({ expiresAtMs: 1_000_000 }));
    assert.equal(await store.take(FLOW_KEY, 1_000_000), undefined, "expiry is exclusive, like the in-memory store");
  });

  it("refuses to overwrite an existing entry", async () => {
    const table = new FakeTableStorage();
    const store = flowStore(table);
    await store.put(FLOW_KEY, flowEntry());
    await assert.rejects(() => store.put(FLOW_KEY, flowEntry({ allowRebind: true })), /already exists/);
    assert.equal((await store.take(FLOW_KEY, 1_000_000))?.allowRebind, false);
  });

  it("rejects malformed keys and entries before any request", async () => {
    const table = new FakeTableStorage();
    const store = flowStore(table);
    for (const key of ["", "has space", "x".repeat(513), "tab\there", "nul\u0000"]) {
      await assert.rejects(() => store.put(key, flowEntry()), /malformed/, JSON.stringify(key));
      await assert.rejects(() => store.take(key, 0), /malformed/, JSON.stringify(key));
    }
    await assert.rejects(() => store.put(FLOW_KEY, flowEntry({ expiresAtMs: Number.NaN })), /finite/);
    assert.equal(table.requests.length, 0);
  });

  it("keeps the raw key and the PKCE verifier out of URLs, and seals the payload when given a cipher", async () => {
    const table = new FakeTableStorage();
    const cipher = new AesGcmFieldCipher(Buffer.alloc(32, 7));
    const store = flowStore(table, { cipher });
    await store.put(FLOW_KEY, flowEntry());
    const [row] = [...table.rows("githublinkflows").values()];
    assert.equal(row.entity.RowKey, sha256Hex(FLOW_KEY));
    assert.equal(row.entity.PartitionKey, sha256Hex(FLOW_KEY).slice(0, 2));
    assert.ok(!JSON.stringify(row.entity).includes("PLAINTEXT"));
    assert.ok(!JSON.stringify(row.entity).includes(TENANT));
    assert.deepEqual(await store.take(FLOW_KEY, 1_000_000), flowEntry());
    for (const url of table.urls()) {
      assert.ok(!url.includes(FLOW_KEY) && !url.includes("PLAINTEXT"), url);
    }
  });

  it("sweepExpired removes only expired rows", async () => {
    const table = new FakeTableStorage();
    const store = flowStore(table);
    await store.put(`entra:${"1".repeat(64)}`, flowEntry({ expiresAtMs: 1_000 }));
    await store.put(`entra:${"2".repeat(64)}`, flowEntry({ expiresAtMs: 2_000 }));
    await store.put(`entra:${"3".repeat(64)}`, flowEntry({ expiresAtMs: 9_000_000 }));
    assert.equal(await store.sweepExpired(5_000), 2);
    assert.equal(table.rows("githublinkflows").size, 1);
    assert.equal(await store.sweepExpired(5_000), 0);
    assert.ok(await store.take(`entra:${"3".repeat(64)}`, 5_000));
  });

  it("does not consume the entry when the delete fails for an unexpected reason", async () => {
    const table = new FakeTableStorage();
    const store = flowStore(table);
    await store.put(FLOW_KEY, flowEntry());
    table.failures.push({ status: 500, times: 1, match: (r) => r.method === "DELETE" });
    await assert.rejects(() => store.take(FLOW_KEY, 1_000_000), /status 500/);
    assert.ok(await store.take(FLOW_KEY, 1_000_000));
  });
});

describe("GitHubLinkService on Azure Table stores", () => {
  let h: Harness | undefined;

  afterEach(async () => {
    await h?.stop();
    h = undefined;
  });

  /** One "replica": its own store instances and service, all pointed at the shared fake account. */
  function replica(harness: Harness, table: FakeTableStorage): GitHubLinkService {
    return harness.makeService({
      store: linkStore(table),
      flowStore: flowStore(table, { cipher: harness.cipher }),
    });
  }

  it("links Alice through the full browser flow, then refreshes with an advanced clock", async () => {
    const table = new FakeTableStorage();
    h = await startHarness();
    const service = replica(h, table);
    const { startUrl } = await service.begin(ALICE);
    assert.equal(table.rows("githublinkflows").size, 1);
    const result = await runLinkFlow(h, service, startUrl, asIdentity(ALICE), GH_ALICE);
    assert.equal(result.final.status, 200, String(result.final.body));
    assert.equal(table.rows("githublinkflows").size, 0, "every flow step was consumed");
    assert.equal(table.rows("githublinks").size, 1);
    const linked = [...table.rows("githublinks").values()][0];
    assert.equal(linked.entity.githubLogin, "alice-gh");

    const status = await service.status(ALICE);
    assert.deepEqual([status.linked, status.githubLogin, status.githubUserId], [true, "alice-gh", 1001]);

    const initial = await service.tokenFor(ALICE, { reason: "initial" });
    assert.equal(initial.refreshed, false);
    assert.equal(initial.credentialVersion, 1);

    h.clock.advanceSeconds(7.5 * 3600);
    const refreshed = await service.tokenFor(ALICE, { reason: "refresh" });
    assert.equal(refreshed.refreshed, true);
    assert.equal(refreshed.credentialVersion, 2);
    assert.equal(h.gh.refreshCalls, 1);
    assert.ok(h.gh.accessTokens.has(refreshed.accessToken));
    const after = [...table.rows("githublinks").values()][0];
    assert.notEqual(after.etag, linked.etag);
    assert.equal(after.entity.refreshLeaseId, undefined, "the lease is released by the persisted pair");

    // A second replica reads the rotated pair without refreshing again.
    const other = replica(h, table);
    const again = await other.tokenFor(ALICE, { reason: "refresh" });
    assert.equal(again.refreshed, false);
    assert.equal(again.accessToken, refreshed.accessToken);
    assert.equal(h.gh.refreshCalls, 1);

    // GitHub secrets only ever reach the table sealed.
    const wire = table.requests.map((r) => `${r.url}\n${r.body ?? ""}`).join("\n");
    for (const secret of h.gh.secrets) {
      assert.ok(!wire.includes(secret), "a GitHub credential reached Table Storage in the clear");
    }
    assert.ok(table.urls().every((u) => !u.includes("ghu_") && !u.includes("ghr_")));
  });

  it("serves /start on one replica and both callbacks on another that shares the stores", async () => {
    const table = new FakeTableStorage();
    h = await startHarness();
    const replicaA = replica(h, table);
    const replicaB = replica(h, table);
    const proxy = {
      handleHttp: (req: Parameters<GitHubLinkService["handleHttp"]>[0]) =>
        (req.path === LINK_START_PATH ? replicaA : replicaB).handleHttp(req),
    } as unknown as GitHubLinkService;
    const { startUrl } = await replicaA.begin(ALICE);
    const result = await runLinkFlow(h, replicaA, startUrl, asIdentity(ALICE), GH_ALICE, new Browser(proxy));
    assert.equal(result.start.status, 302);
    assert.equal(result.entraCallback?.status, 302);
    assert.equal(result.final.status, 200, String(result.final.body));

    // The replay of either leg, on any replica, is rejected: single use across replicas.
    const replayBrowser = new Browser(proxy);
    for (const [name, value] of result.browser.jar) replayBrowser.jar.set(name, value);
    const replay = await replayBrowser.get(result.entraCallbackUrl as string);
    assert.notEqual(replay.status, 302);

    for (const service of [replicaA, replicaB]) {
      const token = await service.tokenFor(ALICE, { reason: "initial" });
      assert.equal(token.githubUserId, GH_ALICE.id);
    }
    assert.equal((await replicaB.status(ALICE)).githubLogin, "alice-gh");
  });

  it("when two replicas receive the same Entra callback concurrently, exactly one proceeds", async () => {
    const table = new FakeTableStorage();
    h = await startHarness();
    const replicaA = replica(h, table);
    const replicaB = replica(h, table);
    const { startUrl } = await replicaA.begin(BOB);
    const browserA = new Browser(replicaA);
    const start = await browserA.start(startUrl);
    assert.equal(start.status, 302);
    const callbackUrl = h.entra.signIn(start.headers.location, asIdentity(BOB));
    const browserB = new Browser(replicaB);
    for (const [name, value] of browserA.jar) browserB.jar.set(name, value);
    const responses = await Promise.all([browserA.get(callbackUrl), browserB.get(callbackUrl)]);
    assert.equal(responses.filter((r) => r.status === 302).length, 1);
  });

  it("keeps the existing refusals: a different Entra user cannot consume Alice's start link", async () => {
    const table = new FakeTableStorage();
    h = await startHarness();
    const replicaA = replica(h, table);
    const replicaB = replica(h, table);
    const { startUrl } = await replicaA.begin(ALICE);
    const hijack = await runLinkFlow(h, replicaB, startUrl, asIdentity(BOB), GH_BOB);
    assert.notEqual(hijack.final.status, 200);
    assert.equal((await replicaA.status(ALICE)).linked, false);
    assert.equal([...table.rows("githublinks").values()][0].entity.state, "unlinked");
  });
});
