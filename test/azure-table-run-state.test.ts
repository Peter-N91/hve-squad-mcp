/**
 * Azure Table run-state store — advisory composites (Phase 4).
 *
 * The Azure Table store is live-only in production (it talks to the Table REST
 * API), but its `fetchImpl` is injectable, so this suite drives it against a
 * minimal in-memory fake table. Two store instances sharing ONE fake table model
 * two replicas over shared storage. The suite proves the Phase 4 fields
 * (`stages` / `councilVerdict` / `history`) serialize through `toEntity` /
 * `fromEntity`, are encrypted at rest, and are visible cross-replica — mirroring
 * the file-store dual-store + multi-replica patterns.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

import { AzureTableRunStateStore } from "../src/engine/backends/azure-table-run-state.js";
import { AesGcmFieldCipher, type FieldCipher } from "../src/engine/field-cipher.js";

/**
 * A minimal in-memory Table Storage backend behind an injectable `fetch`. Supports
 * exactly the operations the store issues: insert (POST), a RowKey / status /
 * expiry `$filter` query (GET), an ETag-guarded overwrite (PUT), and delete.
 */
class FakeTable {
  private readonly rows = new Map<string, { entity: Record<string, unknown>; etag: string }>();
  private seq = 0;

  readonly fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;

    if (method === "POST") {
      const entity = JSON.parse(init?.body as string) as Record<string, unknown>;
      this.rows.set(entity.RowKey as string, { entity, etag: this.nextEtag() });
      return new Response(null, { status: 204 });
    }
    if (method === "GET") {
      const filter = new URL(url).searchParams.get("$filter") ?? "";
      let matches = [...this.rows.values()];
      const byRow = /RowKey eq '([^']+)'/.exec(filter);
      if (byRow) {
        matches = matches.filter((r) => r.entity.RowKey === byRow[1]);
      }
      if (/status eq 'held'/.test(filter)) {
        matches = matches.filter((r) => r.entity.status === "held" || r.entity.status === "running");
      }
      const byExpiry = /expiresAt le (\d+)/.exec(filter);
      if (byExpiry) {
        const n = Number(byExpiry[1]);
        matches = matches.filter((r) => typeof r.entity.expiresAt === "number" && (r.entity.expiresAt as number) <= n);
      }
      const value = matches.map((r) => ({ ...r.entity, "odata.etag": r.etag }));
      return this.json({ value });
    }
    if (method === "PUT") {
      const rowKey = /RowKey='([^']+)'/.exec(url)?.[1] as string;
      const ifMatch = headers["If-Match"];
      const existing = this.rows.get(rowKey);
      if (existing && ifMatch && ifMatch !== "*" && ifMatch !== existing.etag) {
        return new Response(null, { status: 412 });
      }
      const entity = JSON.parse(init?.body as string) as Record<string, unknown>;
      this.rows.set(rowKey, { entity, etag: this.nextEtag() });
      return new Response(null, { status: 204 });
    }
    if (method === "DELETE") {
      const rowKey = /RowKey='([^']+)'/.exec(url)?.[1] as string;
      this.rows.delete(rowKey);
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 405 });
  };

  /** The raw stored (still-sealed) entity, for at-rest inspection. */
  raw(rowKey: string): Record<string, unknown> | undefined {
    return this.rows.get(rowKey)?.entity;
  }

  private nextEtag(): string {
    this.seq += 1;
    return `W/"etag-${this.seq}"`;
  }
  private json(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }
}

function storeOn(table: FakeTable, cipher?: FieldCipher): AzureTableRunStateStore {
  return new AzureTableRunStateStore({
    account: "fakeacct",
    tableName: "runs",
    getAccessToken: async () => "fake-token",
    fetchImpl: table.fetch,
    cipher,
  });
}

const SAMPLE_STAGES = [
  { role: "Task Researcher", artifact: "## Task Researcher\n\nresearch findings" },
  { role: "Task Planner", agentName: "lead", artifact: "## Task Planner\n\nthe plan" },
  { role: "Council Verdict", artifact: "## Council Verdict\n\n* Verdict: Go-With-Conditions" },
];
const SAMPLE_VERDICT = {
  class: "Go-With-Conditions" as const,
  conditions: ["(security) encrypt the export"],
  rendered: "## Council Verdict\n\n* Verdict: Go-With-Conditions",
};
const SAMPLE_HISTORY = [
  { stage: "Task Researcher", at: "2026-07-06T00:00:00.000Z" },
  { stage: "Task Planner", at: "2026-07-06T00:00:01.000Z" },
  { stage: "Council Verdict", at: "2026-07-06T00:00:02.000Z" },
];

test("Azure Table store round-trips advisory stages + verdict + history", async () => {
  const store = storeOn(new FakeTable());
  const run = await store.create({ tenantId: "t", toolId: "squad_run" });
  await store.update(run.runId, {
    stages: SAMPLE_STAGES,
    councilVerdict: SAMPLE_VERDICT,
    history: SAMPLE_HISTORY,
  });
  const read = await store.get(run.runId);
  assert.deepEqual(read?.stages, SAMPLE_STAGES);
  assert.deepEqual(read?.councilVerdict, SAMPLE_VERDICT);
  assert.deepEqual(read?.history, SAMPLE_HISTORY);
});

test("a Table run without advisory fields still loads (backward-compatible optionals)", async () => {
  const store = storeOn(new FakeTable());
  const run = await store.create({ tenantId: "t", toolId: "squad_run" });
  await store.update(run.runId, { status: "complete", artifact: "legacy artifact" });
  const read = await store.get(run.runId);
  assert.equal(read?.artifact, "legacy artifact");
  assert.equal(read?.stages, undefined);
  assert.equal(read?.councilVerdict, undefined);
  assert.equal(read?.history, undefined);
});

test("Azure Table store encrypts advisory stages + verdict at rest", async () => {
  const table = new FakeTable();
  const store = storeOn(table, new AesGcmFieldCipher(randomBytes(32)));
  const run = await store.create({ tenantId: "t", toolId: "squad_run" });
  await store.update(run.runId, {
    stages: [{ role: "Task Researcher", artifact: "SECRET-TABLE-ARTIFACT" }],
    councilVerdict: { class: "Stop", conditions: ["SECRET-TABLE-CONDITION"], rendered: "SECRET-TABLE-RENDERED" },
  });
  const raw = table.raw(run.runId) as Record<string, unknown>;
  const serialized = JSON.stringify(raw);
  assert.ok(!serialized.includes("SECRET-TABLE-ARTIFACT"), "stage artifact is encrypted at rest");
  assert.ok(!serialized.includes("SECRET-TABLE-RENDERED"), "verdict rendered block is encrypted at rest");
  assert.ok(!serialized.includes("SECRET-TABLE-CONDITION"), "verdict conditions are encrypted at rest");
  assert.equal(typeof raw.stages, "string", "the composite is flattened to a string property");
  assert.ok((raw.stages as string).startsWith("gcm1:"), "the flattened composite is an AES-GCM envelope");
  // A read decrypts the composites back.
  const read = await store.get(run.runId);
  assert.equal(read?.stages?.[0].artifact, "SECRET-TABLE-ARTIFACT");
  assert.equal(read?.councilVerdict?.class, "Stop");
  assert.equal(read?.councilVerdict?.rendered, "SECRET-TABLE-RENDERED");
});

test("Azure Table store multi-replica: a verdict written by one instance is visible to a second", async () => {
  // One shared fake table = shared storage; both replicas share the data key.
  const table = new FakeTable();
  const key = randomBytes(32);
  const a = storeOn(table, new AesGcmFieldCipher(key));
  const run = await a.create({ tenantId: "t", toolId: "squad_run" });
  await a.update(run.runId, { stages: SAMPLE_STAGES, councilVerdict: SAMPLE_VERDICT, history: SAMPLE_HISTORY });
  // A fresh store instance (a different replica) over the SAME table + key.
  const b = storeOn(table, new AesGcmFieldCipher(key));
  const read = await b.get(run.runId);
  assert.deepEqual(read?.stages, SAMPLE_STAGES);
  assert.equal(read?.councilVerdict?.class, "Go-With-Conditions");
  assert.deepEqual(read?.history, SAMPLE_HISTORY);
});
