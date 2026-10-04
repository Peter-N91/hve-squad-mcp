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

import {
  AZURE_TABLE_STRING_CHUNK_BYTES,
  AzureTableRunStateStore,
} from "../src/engine/backends/azure-table-run-state.js";
import { AesGcmFieldCipher, type FieldCipher } from "../src/engine/field-cipher.js";
import { isRunClaimable, type HumanInputState, type RunStateStore } from "../src/engine/run-state.js";
import type { MemoryBlobWriter } from "../src/engine/backends/overflow-squad-memory.js";
import { encodeAdvisoryCheckpoint, decodeAdvisoryCheckpoint } from "../src/engine/advisory-checkpoint.js";

/**
 * A minimal in-memory Table Storage backend behind an injectable `fetch`. Supports
 * exactly the operations the store issues: insert (POST), a RowKey / status /
 * expiry `$filter` query (GET), an ETag-guarded overwrite (PUT), and delete.
 */
class FakeTable {
  private readonly rows = new Map<string, { entity: Record<string, unknown>; etag: string }>();
  private seq = 0;
  /** WI-07 — count of `POST .../Tables` create calls, for auto-create assertions. */
  tablePosts = 0;
  getUrls: string[] = [];
  putEtags: (string | undefined)[] = [];
  private tableCreated = false;

  private accepts(entity: Record<string, unknown>): boolean {
    const strings = Object.values(entity).filter((value): value is string => typeof value === "string");
    return strings.reduce((size, value) => size + Buffer.byteLength(value, "utf16le"), 0) <= 1024 * 1024 &&
      Object.keys(entity).length <= 252 && Object.values(entity).every(
      (value) =>
        typeof value !== "string" ||
        Buffer.byteLength(value, "utf16le") <= 64 * 1024,
    );
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;

    if (method === "POST") {
      // WI-07 — table create (`POST .../Tables`): 204 first, 409 (exists) after.
      if (/\/Tables$/.test(url)) {
        this.tablePosts += 1;
        const created = this.tableCreated;
        this.tableCreated = true;
        return new Response(null, { status: created ? 409 : 204 });
      }
      const entity = JSON.parse(init?.body as string) as Record<string, unknown>;
      if (!this.accepts(entity)) {
        return new Response(null, { status: 400 });
      }
      this.rows.set(entity.RowKey as string, { entity, etag: this.nextEtag() });
      return new Response(null, { status: 204 });
    }
    if (method === "GET") {
      this.getUrls.push(url);
      const filter = new URL(url).searchParams.get("$filter") ?? "";
      let matches = [...this.rows.values()];
      const byRow = /RowKey eq '([^']+)'/.exec(filter);
      if (byRow) {
        matches = matches.filter((r) => r.entity.RowKey === byRow[1]);
      }
      const byStatus = /status eq '([^']+)'/.exec(filter);
      if (byStatus) {
        matches = matches.filter((r) => r.entity.status === byStatus[1]);
      }
      const byExpiry = /expiresAt le (\d+)/.exec(filter);
      if (byExpiry) {
        const n = Number(byExpiry[1]);
        matches = matches.filter((r) => typeof r.entity.expiresAt === "number" && (r.entity.expiresAt as number) <= n);
      }
      const value = matches.map((r) => ({
        ...r.entity,
        ...(headers.Accept?.includes("odata=fullmetadata") ? { "odata.etag": r.etag } : {}),
      }));
      return this.json({ value });
    }
    if (method === "PUT") {
      const rowKey = /RowKey='([^']+)'/.exec(url)?.[1] as string;
      const ifMatch = headers["If-Match"];
      this.putEtags.push(ifMatch);
      const existing = this.rows.get(rowKey);
      if (existing && ifMatch && ifMatch !== "*" && ifMatch !== existing.etag) {
        return new Response(null, { status: 412 });
      }
      const entity = JSON.parse(init?.body as string) as Record<string, unknown>;
      if (!this.accepts(entity)) {
        return new Response(null, { status: 400 });
      }
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

function storeOn(table: FakeTable, cipher?: FieldCipher, blob?: MemoryBlobWriter): AzureTableRunStateStore {
  return new AzureTableRunStateStore({
    account: "fakeacct",
    tableName: "runs",
    getAccessToken: async () => "fake-token",
    fetchImpl: table.fetch,
    cipher,
    blob,
  });
}

class FakeRunBlobs implements MemoryBlobWriter {
  readonly values = new Map<string, Uint8Array>();
  async put(path: string, value: Uint8Array): Promise<void> {
    this.values.set(path, Uint8Array.from(value));
  }
  async get(path: string): Promise<Uint8Array | undefined> {
    return this.values.get(path);
  }
}

test("large private checkpoint and stage payloads survive encrypted table/blob handoff across replicas", async () => {
  const table = new FakeTable();
  const blob = new FakeRunBlobs();
  const cipher = new AesGcmFieldCipher(randomBytes(32));
  const a = storeOn(table, cipher, blob);
  const runId = await heldInput(a);
  const checkpointData = { transcript: randomBytes(180_000).toString("base64") };
  const checkpoint = encodeAdvisoryCheckpoint(checkpointData);
  const context = "source-context-".repeat(15_000);
  const stages = [{ role: "Squad Researcher", artifact: "research-evidence-".repeat(15_000) }];
  await a.update(runId, { advisoryCheckpoint: checkpoint, context, stages });
  const raw = table.raw(runId)!;
  assert.equal(typeof raw.advisoryCheckpoint__blob, "string");
  assert.equal(raw.advisoryCheckpoint, undefined);
  assert.ok(JSON.stringify(raw).length < 16_000);
  for (const bytes of blob.values.values()) {
    assert.match(Buffer.from(bytes).toString("utf8"), /^gcm1:/);
    assert.ok(!Buffer.from(bytes).toString("utf8").includes("source-context"));
  }
  const b = storeOn(table, cipher, blob);
  const pending = await b.get(runId);
  assert.equal(pending?.context, context);
  assert.deepEqual(pending?.stages, stages);
  assert.deepEqual(decodeAdvisoryCheckpoint(pending!.advisoryCheckpoint!), checkpointData);
  assert.deepEqual(await b.listClaimable(), [], "unanswered human gates remain unclaimable");
  assert.ok(await b.answerInput(runId, QUESTION.questionId, ANSWER));
  assert.ok(await b.claim(runId, ["running"], "running"));
  assert.equal((await a.get(runId))?.advisoryCheckpoint, checkpoint);
  await a.update(runId, { status: "complete", advisoryCheckpoint: undefined });
  assert.equal(table.raw(runId)?.advisoryCheckpoint__blob, undefined);
});

test("run-state overflow rejects missing, corrupt and cross-run payloads", async () => {
  const table = new FakeTable();
  const blob = new FakeRunBlobs();
  const store = storeOn(table, undefined, blob);
  const first = await store.create({ tenantId: "tenant-a", toolId: "squad_run" });
  await store.update(first.runId, { advisoryCheckpoint: "private-checkpoint".repeat(8_000) });
  const second = await store.create({ tenantId: "tenant-b", toolId: "squad_run" });
  table.raw(second.runId)!.advisoryCheckpoint__blob = table.raw(first.runId)!.advisoryCheckpoint__blob;
  await assert.rejects(store.get(second.runId), /overflow.*missing/i);
  const [path, bytes] = [...blob.values][0]!;
  blob.values.set(path, Buffer.from("corrupt"));
  await assert.rejects(store.get(first.runId), /overflow.*integrity/i);
  blob.values.delete(path);
  await assert.rejects(store.get(first.runId), /overflow.*missing/i);
  blob.values.set(path, bytes);
  await assert.rejects(storeOn(table).get(first.runId), /overflow.*configured/i);
  table.raw(first.runId)!.advisoryCheckpoint__blob = "../outside";
  await assert.rejects(store.get(first.runId), /Malformed run-state overflow/);
});

test("content-addressed run payloads preserve the CAS winner and failed uploads leave the row untouched", async () => {
  const table = new FakeTable();
  const blob = new FakeRunBlobs();
  const a = storeOn(table, undefined, blob);
  const b = storeOn(table, undefined, blob);
  const run = await a.create({ tenantId: "tenant-a", toolId: "squad_run" });
  const answers = await Promise.all([
    a.update(run.runId, { artifact: "first".repeat(20_000) }),
    b.update(run.runId, { artifact: "second".repeat(20_000) }),
  ]);
  const winners = answers.filter((answer) => answer !== undefined);
  assert.equal(winners.length, 1);
  assert.equal((await b.get(run.runId))?.artifact, winners[0]?.artifact);
  const before = JSON.stringify(table.raw(run.runId));
  const failing = storeOn(table, undefined, {
    get: (path) => blob.get(path),
    put: async () => { throw new Error("Injected blob outage."); },
  });
  await assert.rejects(failing.update(run.runId, { context: "large-source".repeat(10_000) }), /Injected blob outage/);
  assert.equal(JSON.stringify(table.raw(run.runId)), before);
});

const SAMPLE_STAGES = [
  { role: "Squad Researcher", artifact: "## Squad Researcher\n\nresearch findings" },
  { role: "Squad Lead", agentName: "lead", artifact: "## Squad Lead\n\nthe plan" },
  { role: "Council Verdict", artifact: "## Council Verdict\n\n* Verdict: Go-With-Conditions" },
];
const SAMPLE_VERDICT = {
  class: "Go-With-Conditions" as const,
  conditions: ["(security) encrypt the export"],
  rendered: "## Council Verdict\n\n* Verdict: Go-With-Conditions",
};
const SAMPLE_HISTORY = [
  { stage: "Squad Researcher", at: "2026-07-06T00:00:00.000Z" },
  { stage: "Squad Lead", at: "2026-07-06T00:00:01.000Z" },
  { stage: "Council Verdict", at: "2026-07-06T00:00:02.000Z" },
];

const QUESTION: HumanInputState = {
  questionId: "sensitive-question-id",
  question: "Confirm the confidential advisory scope?",
  purpose: "confirmation",
  choices: ["private-yes", "private-no"],
  notice: "confidential confirmation notice",
};
const ANSWER = { answer: "private-yes", respondedBy: "sensitive-user", respondedAt: 100 };

async function heldInput(store: RunStateStore): Promise<string> {
  const run = await store.create({ tenantId: "t", toolId: "squad_run" });
  await store.update(run.runId, {
    status: "held",
    holdReason: "awaiting-human-input",
    humanInput: QUESTION,
    advisoryCheckpoint: "sensitive-checkpoint",
    leaseExpiresAt: Date.now() + 60_000,
    stages: SAMPLE_STAGES,
    councilVerdict: SAMPLE_VERDICT,
    history: SAMPLE_HISTORY,
  });
  return run.runId;
}

test("Azure Table encrypted human handoff round-trips across replicas and preserves stages", async () => {
  const table = new FakeTable();
  const key = randomBytes(32);
  const a = storeOn(table, new AesGcmFieldCipher(key));
  const b = storeOn(table, new AesGcmFieldCipher(key));
  const runId = await heldInput(a);
  const rawPending = JSON.stringify(table.raw(runId));
  for (const secret of [QUESTION.questionId, QUESTION.question, ...QUESTION.choices!, QUESTION.notice!, "sensitive-checkpoint"]) {
    assert.ok(!rawPending.includes(secret));
  }
  assert.deepEqual((await b.get(runId))?.humanInput, QUESTION);
  const before = await b.get(runId);
  const initialGets = table.getUrls.length;
  const result = await b.answerInput(runId, QUESTION.questionId, ANSWER);
  assert.equal(table.getUrls.length - initialGets, 1, "successful answer uses exactly the checked entity read");
  assert.equal(result?.status, "running");
  assert.equal(result?.runId, runId);
  assert.equal(result?.createdAt, before?.createdAt);
  assert.equal(result?.leaseExpiresAt, undefined);
  assert.equal(result?.holdReason, undefined);
  assert.equal(result?.approvedBy, undefined);
  assert.equal(table.raw(runId)?.holdReason, undefined);
  assert.equal(table.raw(runId)?.leaseExpiresAt, undefined);
  assert.deepEqual(result?.humanInput, { ...QUESTION, response: ANSWER });
  assert.deepEqual(result?.stages, SAMPLE_STAGES);
  assert.deepEqual(result?.councilVerdict, SAMPLE_VERDICT);
  assert.deepEqual(result?.history, SAMPLE_HISTORY);
  assert.equal(result?.advisoryCheckpoint, "sensitive-checkpoint");
  const rawAnswered = JSON.stringify(table.raw(runId));
  assert.ok(!rawAnswered.includes(ANSWER.answer));
  assert.ok(!rawAnswered.includes(ANSWER.respondedBy));
  const restarted = storeOn(table, new AesGcmFieldCipher(key));
  assert.deepEqual((await restarted.get(runId))?.humanInput?.response, ANSWER);
  assert.deepEqual((await restarted.listClaimable()).map((run) => run.runId), [runId]);
  assert.ok(await restarted.claim(runId, ["running"], "running"));
  assert.deepEqual((await a.get(runId))?.stages, SAMPLE_STAGES);
});

test("Azure Table chunks both encrypted human state and advisory checkpoints and removes stale chunks", async () => {
  const table = new FakeTable();
  const key = randomBytes(32);
  const store = storeOn(table, new AesGcmFieldCipher(key));
  const runId = await heldInput(store);
  const largeQuestion = { ...QUESTION, question: "private-question-".repeat(3500) };
  const checkpoint = "private-checkpoint-".repeat(3500);
  await store.update(runId, { humanInput: largeQuestion, advisoryCheckpoint: checkpoint });
  let raw = table.raw(runId)!;
  assert.ok(Number(raw.humanInput__chunkCount) > 1);
  assert.ok(Number(raw.advisoryCheckpoint__chunkCount) > 1);
  assert.equal(raw.humanInput, undefined);
  assert.equal(raw.advisoryCheckpoint, undefined);
  assert.ok(!JSON.stringify(raw).includes("private-question-"));
  assert.ok(!JSON.stringify(raw).includes("private-checkpoint-"));
  assert.ok(Object.values(raw).filter((value) => typeof value === "string")
    .every((value) => Buffer.byteLength(value as string, "utf16le") <= AZURE_TABLE_STRING_CHUNK_BYTES));
  const b = storeOn(table, new AesGcmFieldCipher(key));
  assert.deepEqual((await b.get(runId))?.humanInput, largeQuestion);
  assert.equal((await b.get(runId))?.advisoryCheckpoint, checkpoint);
  const longAnswer = { ...ANSWER, answer: "private-answer-".repeat(3500) };
  assert.ok(await b.answerInput(runId, QUESTION.questionId, longAnswer));
  assert.deepEqual((await store.get(runId))?.humanInput?.response, longAnswer);
  assert.ok(!JSON.stringify(table.raw(runId)).includes("private-answer-"));
  await b.update(runId, { humanInput: undefined, advisoryCheckpoint: undefined });
  raw = table.raw(runId)!;
  assert.ok(!Object.keys(raw).some((name) => /^(?:humanInput|advisoryCheckpoint)/.test(name)));
  assert.equal((await store.get(runId))?.humanInput, undefined);
  assert.equal((await store.get(runId))?.advisoryCheckpoint, undefined);
});

test("Azure Table pending human input cannot be claimed through prior operator approval", async () => {
  const table = new FakeTable();
  const store = storeOn(table);
  const runId = await heldInput(store);
  for (const status of ["held", "running"] as const) {
    const run = await store.update(runId, {
      status, approvedBy: "prior-operator", approvedAt: 1, leaseExpiresAt: 0,
    });
    assert.ok(run);
    assert.equal(isRunClaimable(run, Date.now()), false);
    assert.deepEqual(await storeOn(table).listClaimable(), []);
    const puts = table.putEtags.length;
    assert.equal(await storeOn(table).claim(runId, ["held", "running"], "running"), undefined);
    assert.equal(table.putEtags.length, puts);
    assert.equal((await store.get(runId))?.status, status);
  }
});

test("Azure Table preserves a deferred handoff and finite TTL for a later collaborator on another replica", async (t) => {
  const startedAt = Date.now();
  const expiresAt = startedAt + 60_000;
  let now = startedAt;
  t.mock.method(Date, "now", () => now);
  const table = new FakeTable();
  const key = randomBytes(32);
  const original = storeOn(table, new AesGcmFieldCipher(key));
  const runId = await heldInput(original);
  await original.update(runId, {
    params: JSON.stringify({ initiatedBy: "original-initiator" }),
    approvedBy: "original-initiator", approvedAt: now, expiresAt,
  });

  now += 30_000;
  const laterReplica = storeOn(table, new AesGcmFieldCipher(key));
  const puts = table.putEtags.length;
  assert.equal((await laterReplica.get(runId))?.status, "held");
  assert.deepEqual(await laterReplica.listClaimable(), []);
  assert.equal(await laterReplica.claim(runId, ["held", "running"], "running"), undefined);
  assert.equal(table.putEtags.length, puts, "waiting does not release, renew, or otherwise mutate the run");

  const collaborator = { answer: "private-yes", respondedBy: "different-collaborator", respondedAt: now };
  const answered = await laterReplica.answerInput(runId, QUESTION.questionId, collaborator);
  assert.equal(answered?.status, "running");
  assert.deepEqual(answered?.humanInput?.response, collaborator);
  assert.equal(answered?.expiresAt, expiresAt);
  assert.equal(answered?.params, JSON.stringify({ initiatedBy: "original-initiator" }));
  assert.equal(answered?.approvedBy, "original-initiator");
  assert.ok(!JSON.stringify(table.raw(runId)).includes(collaborator.respondedBy));
  assert.equal(await original.answerInput(runId, QUESTION.questionId, {
    ...collaborator, respondedBy: "original-initiator",
  }), undefined);
  assert.deepEqual(
    (await original.answerInput(runId, QUESTION.questionId, { ...collaborator, respondedAt: now + 1 }))?.humanInput?.response,
    collaborator,
  );
  now = expiresAt;
  assert.equal(await laterReplica.answerInput(runId, QUESTION.questionId, collaborator), undefined);
  assert.equal(await laterReplica.get(runId), undefined);
});

test("Azure Table competing different answers and principals have one CAS winner", async () => {
  for (const competitor of [{ ...ANSWER, answer: "private-no" }, { ...ANSWER, respondedBy: "different-user" }]) {
    const table = new FakeTable();
    const a = storeOn(table);
    const runId = await heldInput(a);
    const results = await Promise.all([
      a.answerInput(runId, QUESTION.questionId, ANSWER),
      storeOn(table).answerInput(runId, QUESTION.questionId, competitor),
    ]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.deepEqual((await a.get(runId))?.humanInput?.response, results.find(Boolean)?.humanInput?.response);
    assert.ok(table.putEtags.every((etag) => etag && etag !== "*"));
    assert.equal(table.putEtags.at(-1), table.putEtags.at(-2), "both answers compare against the same held version");
  }
});

test("Azure Table exact concurrent answer retries return the original response even after completion", async () => {
  const table = new FakeTable();
  const store = storeOn(table);
  const runId = await heldInput(store);
  const results = await Promise.all([
    store.answerInput(runId, QUESTION.questionId, ANSWER),
    storeOn(table).answerInput(runId, QUESTION.questionId, { ...ANSWER, respondedAt: 200 }),
  ]);
  assert.ok(results.every(Boolean));
  assert.deepEqual(results[0], results[1]);
  const accepted = results[0]!.humanInput!.response!;
  const complete = await store.update(runId, { status: "complete", advisoryCheckpoint: undefined, artifact: "done" });
  const puts = table.putEtags.length;
  const replayed = await storeOn(table).answerInput(runId, QUESTION.questionId, { ...ANSWER, respondedAt: 300 });
  assert.deepEqual(replayed, complete);
  assert.deepEqual(replayed?.humanInput?.response, accepted);
  assert.equal(await store.answerInput(runId, QUESTION.questionId, { ...ANSWER, answer: "other" }), undefined);
  assert.equal(await store.answerInput(runId, QUESTION.questionId, { ...ANSWER, respondedBy: "other" }), undefined);
  assert.equal(await store.answerInput(runId, "other-question", ANSWER), undefined);
  assert.equal(table.putEtags.length, puts, "idempotent and conflicting replays perform no writes");
});

test("Azure Table answer uses the ETag of the checked question, not a re-fetched update", async () => {
  const table = new FakeTable();
  const operator = storeOn(table);
  const runId = await heldInput(operator);
  let replaced = false;
  const store = new AzureTableRunStateStore({
    account: "fakeacct", tableName: "runs", getAccessToken: async () => "fake-token",
    fetchImpl: async (input, init) => {
      const response = await table.fetch(input, init);
      if (init?.method === "GET" && !replaced) {
        replaced = true;
        await operator.update(runId, {
          humanInput: { ...QUESTION, questionId: "new-question" },
          advisoryCheckpoint: "new-checkpoint",
          stages: [...SAMPLE_STAGES, { role: "new-stage", artifact: "must survive" }],
        });
      }
      return response;
    },
  });
  assert.equal(await store.answerInput(runId, QUESTION.questionId, ANSWER), undefined);
  const current = await operator.get(runId);
  assert.equal(current?.status, "held");
  assert.equal(current?.humanInput?.questionId, "new-question");
  assert.equal(current?.humanInput?.response, undefined);
  assert.equal(current?.advisoryCheckpoint, "new-checkpoint");
  assert.equal(current?.stages?.at(-1)?.artifact, "must survive");
});

test("Azure Table human answers reject wrong question, wrong status, absent checkpoint and expiry", async () => {
  const table = new FakeTable();
  const store = storeOn(table);
  const runId = await heldInput(store);
  assert.equal(await store.answerInput(runId, "wrong-question", ANSWER), undefined);
  assert.equal(await store.answerInput("invalid-id", QUESTION.questionId, ANSWER), undefined);
  for (const status of ["running", "complete", "failed"] as const) {
    await store.update(runId, { status });
    assert.equal(await store.answerInput(runId, QUESTION.questionId, ANSWER), undefined);
  }
  for (const advisoryCheckpoint of [undefined, "", " \n "]) {
    await store.update(runId, { status: "held", advisoryCheckpoint });
    assert.equal(await store.answerInput(runId, QUESTION.questionId, ANSWER), undefined);
  }
  await store.update(runId, { advisoryCheckpoint: "checkpoint", expiresAt: Date.now() - 1 });
  const puts = table.putEtags.length;
  assert.equal(await store.answerInput(runId, QUESTION.questionId, ANSWER), undefined);
  assert.equal(await store.claim(runId, ["held"], "running"), undefined);
  assert.equal(table.putEtags.length, puts);
  assert.deepEqual(await store.listClaimable(), []);
  const answeredRun = await heldInput(store);
  await store.answerInput(answeredRun, QUESTION.questionId, ANSWER);
  await store.update(answeredRun, { expiresAt: Date.now() - 1 });
  assert.equal(await store.answerInput(answeredRun, QUESTION.questionId, ANSWER), undefined);
});

test("Azure Table human answer fails closed without the checked entity ETag", async () => {
  const table = new FakeTable();
  const runId = await heldInput(storeOn(table));
  const store = new AzureTableRunStateStore({
    account: "fakeacct", tableName: "runs", getAccessToken: async () => "fake-token",
    fetchImpl: async (input, init) => {
      const response = await table.fetch(input, init);
      if (init?.method !== "GET") return response;
      const body = await response.json() as { value: Record<string, unknown>[] };
      for (const entity of body.value) delete entity["odata.etag"];
      return new Response(JSON.stringify(body), { status: 200 });
    },
  });
  const puts = table.putEtags.length;
  await assert.rejects(() => store.answerInput(runId, QUESTION.questionId, ANSWER), /missing an entity ETag/);
  assert.equal(table.putEtags.length, puts);
  assert.equal((await storeOn(table).get(runId))?.humanInput?.response, undefined);
});

test("Azure Table run updates and competing claims use actual ETags rather than wildcard replacement", async () => {
  const table = new FakeTable();
  const store = storeOn(table);
  const run = await store.create({ tenantId: "t", toolId: "squad_run" });
  await store.update(run.runId, { status: "held" });
  const claims = await Promise.all([
    store.claim(run.runId, ["held"], "running"),
    storeOn(table).claim(run.runId, ["held"], "running"),
  ]);
  assert.equal(claims.filter(Boolean).length, 1);
  assert.ok(table.putEtags.every((etag) => etag && etag !== "*"));
});

test("Azure Table run updates fail closed if a response loses its entity ETag", async () => {
  const table = new FakeTable();
  const run = await storeOn(table).create({ tenantId: "t", toolId: "squad_run" });
  const store = new AzureTableRunStateStore({
    account: "fakeacct", tableName: "runs", getAccessToken: async () => "fake-token",
    fetchImpl: async (input, init) => {
      const response = await table.fetch(input, init);
      if (init?.method !== "GET" || !response.ok) return response;
      const body = await response.json() as { value: Record<string, unknown>[] };
      for (const entity of body.value) delete entity["odata.etag"];
      return new Response(JSON.stringify(body), { status: 200 });
    },
  });
  await assert.rejects(() => store.update(run.runId, { status: "held" }), /missing an entity ETag/);
  await assert.rejects(() => store.claim(run.runId, ["running"], "running"), /missing an entity ETag/);
  assert.equal(table.putEtags.length, 0, "no wildcard write is attempted");
  assert.equal((await storeOn(table).get(run.runId))?.status, "running");
});

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

test("failed artifact gates retain their stable reason and diagnostic across Table replicas", async () => {
  const table = new FakeTable();
  const store = storeOn(table);
  const run = await store.create({ tenantId: "t", toolId: "squad_run" });
  await store.update(run.runId, {
    status: "failed",
    failureReason: "stage_artifact_gate",
    artifact: "Research stopped before planning: no verified primary artifact.",
  });
  const read = await storeOn(table).get(run.runId);
  assert.equal(read?.status, "failed");
  assert.equal(read?.failureReason, "stage_artifact_gate");
  assert.equal(read?.artifact, "Research stopped before planning: no verified primary artifact.");
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

test("terminal Responsible-AI receipt survives Table replicas without creating a human gate", async () => {
  const table = new FakeTable();
  const store = storeOn(table);
  const run = await store.create({ tenantId: "t", toolId: "squad_run" });
  const responsibleAi = {
    schemaVersion: 1 as const, cause: "provider_content_policy" as const,
    terminal: true as const, sameRunResumable: false as const,
    acknowledgmentCanOverride: false as const, runId: run.runId, stage: "BRD author",
    direction: "unknown" as const, categories: [], providerStatus: 400,
    providerCode: "ContentFiltered",
    nextActions: ["review_and_correct_source", "stop", "escalate_false_positive"] as const,
  };
  await store.update(run.runId, { status: "failed", failureReason: "model_backend_content_policy", responsibleAi });
  const read = await storeOn(table).get(run.runId);
  assert.deepEqual(read?.responsibleAi, responsibleAi);
  assert.equal(read?.humanInput, undefined);
  assert.equal(read?.status, "failed");
  assert.deepEqual(await storeOn(table).listClaimable(), []);
});

test("ordinary model diagnostics survive Table replicas without retaining arbitrary fields", async () => {
  const { ModelBackendError, modelFailureDiagnostics } = await import("../src/engine/model-backend.js");
  const table = new FakeTable();
  const store = storeOn(table);
  const run = await store.create({ tenantId: "t", toolId: "squad_run" });
  const modelFailure = modelFailureDiagnostics(new ModelBackendError("upstream", {
    status: 500, providerCode: "InternalServerError", providerRequestId: "request_12345678",
  }), "Squad Researcher", run.runId)!;
  await store.update(run.runId, {
    status: "failed", failureReason: "model_backend_upstream",
    modelFailure: { ...modelFailure, message: "SECRET raw provider body" } as typeof modelFailure,
    artifact: "Preserved partial output",
  });
  const read = await storeOn(table).get(run.runId);
  assert.deepEqual(read?.modelFailure, modelFailure);
  assert.equal(read?.artifact, "Preserved partial output");
  assert.equal(read?.responsibleAi, undefined);
  assert.equal(read?.humanInput, undefined);
  assert.doesNotMatch(JSON.stringify(read), /SECRET/);
  assert.deepEqual(await storeOn(table).listClaimable(), []);
});

test("local preflight receipt survives Table replicas with no provider-attempt or input leakage", async () => {
  const { ModelBackendError, modelFailureDiagnostics } = await import("../src/engine/model-backend.js");
  const table = new FakeTable();
  const store = storeOn(table);
  const run = await store.create({ tenantId: "t", toolId: "squad_run" });
  const modelFailure = modelFailureDiagnostics(new ModelBackendError("invalid_request", {
    providerCode: "local_context_preflight_rejected", providerAttempted: false,
    preflight: { schemaVersion: 1, issues: [{ rule: "credential_bearer", field: "messages[2].content" }] },
  }), "Squad Researcher", run.runId)!;
  await store.update(run.runId, {
    status: "failed", failureReason: "model_backend_invalid_request",
    modelFailure: { ...modelFailure, message: "SECRET input" } as typeof modelFailure,
  });
  const read = await storeOn(table).get(run.runId);
  assert.deepEqual(read?.modelFailure, modelFailure);
  assert.equal(read?.modelFailure?.providerAttempted, false);
  assert.doesNotMatch(JSON.stringify(read), /SECRET/);
  assert.deepEqual(await storeOn(table).listClaimable(), []);
});

test("oversized model artifacts are chunked below the Azure Table string limit", async () => {
  const table = new FakeTable();
  const store = storeOn(table);
  const run = await store.create({ tenantId: "t", toolId: "squad_architect" });
  const artifact = `ARTIFACT-BEGIN\n${"x".repeat(90_000)}\nARTIFACT-END`;

  const updated = await store.update(run.runId, {
    status: "complete",
    artifact,
  });
  const raw = table.raw(run.runId) as Record<string, unknown>;
  const chunks = Object.entries(raw).filter(([name]) =>
    /^artifact__chunk\d{3}$/.test(name),
  );

  assert.ok(updated, "the update is accepted by a Table-compatible backend");
  assert.equal(raw.artifact, undefined);
  assert.ok(Number(raw.artifact__chunkCount) > 1);
  assert.ok(
    chunks.every(
      ([, value]) =>
        typeof value === "string" &&
        Buffer.byteLength(value, "utf16le") <= AZURE_TABLE_STRING_CHUNK_BYTES,
    ),
  );
  assert.equal((await store.get(run.runId))?.artifact, artifact);
});

test("oversized encrypted context and stages remain encrypted and round-trip across chunks", async () => {
  const table = new FakeTable();
  const store = storeOn(table, new AesGcmFieldCipher(randomBytes(32)));
  const run = await store.create({ tenantId: "t", toolId: "squad_run" });
  const secretContext = `SECRET-CONTEXT-BEGIN\n${"y".repeat(90_000)}\nSECRET-CONTEXT-END`;
  const stages = [
    {
      role: "System Architecture Reviewer",
      artifact: `STAGE-BEGIN\n${"z".repeat(90_000)}\nSTAGE-END`,
    },
  ];

  const updated = await store.update(run.runId, {
    context: secretContext,
    stages,
  });
  const raw = table.raw(run.runId) as Record<string, unknown>;
  const serialized = JSON.stringify(raw);

  assert.ok(updated);
  assert.ok(Number(raw.context__chunkCount) > 1);
  assert.ok(Number(raw.stages__chunkCount) > 1);
  assert.doesNotMatch(serialized, /SECRET-CONTEXT|STAGE-BEGIN/);
  const read = await store.get(run.runId);
  assert.equal(read?.context, secretContext);
  assert.deepEqual(read?.stages, stages);
});

test("Azure Table store encrypts advisory stages + verdict at rest", async () => {
  const table = new FakeTable();
  const store = storeOn(table, new AesGcmFieldCipher(randomBytes(32)));
  const run = await store.create({ tenantId: "t", toolId: "squad_run" });
  await store.update(run.runId, {
    stages: [{ role: "Squad Researcher", artifact: "SECRET-TABLE-ARTIFACT" }],
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
  const completionUsage = [{
    schemaVersion: 1 as const,
    eventId: "event-1",
    runId: run.runId,
    stage: "researcher",
    actor: "Squad Researcher",
    recordedAt: "2026-09-20T06:00:00.000Z",
    attempt: 1,
    outcome: "completed" as const,
    finishReason: "stop",
    backendId: "azure-openai",
    model: "gpt-5.6-sol",
    deployment: "prod",
    providerResponseId: "resp_1",
    usage: {
      completionCount: 1,
      attemptCount: 1,
      inputTokens: 100,
      outputTokens: 20,
      reasoningTokens: 5,
      cacheReadTokens: 40,
      pricedCompletionCount: 1,
      incompletelyPricedCompletionCount: 0,
      unpricedCompletionCount: 0,
      costStatus: "complete" as const,
      costCurrency: "USD" as const,
      costBasis: "configured_estimate" as const,
      estimatedCostUsd: 0.01,
    },
  }];
  await a.update(run.runId, {
    stages: SAMPLE_STAGES,
    councilVerdict: SAMPLE_VERDICT,
    history: SAMPLE_HISTORY,
    completionUsage,
  });
  // A fresh store instance (a different replica) over the SAME table + key.
  const b = storeOn(table, new AesGcmFieldCipher(key));
  const read = await b.get(run.runId);
  assert.deepEqual(read?.stages, SAMPLE_STAGES);
  assert.equal(read?.councilVerdict?.class, "Go-With-Conditions");
  assert.deepEqual(read?.history, SAMPLE_HISTORY);
  assert.deepEqual(read?.completionUsage, completionUsage);
});

test("listClaimable uses portable single-status filters and merges held/running candidates", async () => {
  const table = new FakeTable();
  const store = storeOn(table);
  const held = await store.create({ tenantId: "t", toolId: "squad_run" });
  await store.update(held.runId, {
    status: "held",
    approvedBy: "operator",
    approvedAt: Date.now(),
  });

  const running = await store.create({ tenantId: "t", toolId: "squad_run" });
  await store.update(running.runId, {
    status: "running",
    leaseExpiresAt: 0,
  });

  const claimable = await store.listClaimable();
  assert.deepEqual(
    claimable.map((run) => run.runId).sort(),
    [held.runId, running.runId].sort(),
  );
});

test("sweepExpired uses an Edm.Int64 literal for epoch milliseconds", async () => {
  const table = new FakeTable();
  const store = storeOn(table);
  await store.sweepExpired(1_800_000_000_000);
  assert.ok(
    table.getUrls.some((url) =>
      decodeURIComponent(url).includes("expiresAt le 1800000000000L"),
    ),
  );
});

test("Azure Table run-state store creates the table on first create, once (WI-07)", async () => {
  const table = new FakeTable();
  const store = storeOn(table);
  assert.equal(table.tablePosts, 0, "no table-create is issued before any write");

  const run = await store.create({ tenantId: "t", toolId: "squad_run" });
  assert.equal(table.tablePosts, 1, "the first create issues exactly one POST /Tables");
  assert.ok(await store.get(run.runId), "the run persisted after the table was created");

  await store.create({ tenantId: "t", toolId: "squad_run" });
  assert.equal(table.tablePosts, 1, "the table-create is memoized — no second POST /Tables");
});

test("Azure Table run-state store swallows a 409 (table already exists) on first create (WI-07)", async () => {
  const table = new FakeTable();
  // A first store creates the table (204).
  await storeOn(table).create({ tenantId: "t", toolId: "squad_run" });
  assert.equal(table.tablePosts, 1, "the first store created the table");

  // A fresh store issues its own create and sees a 409 — the run still persists.
  const store2 = storeOn(table);
  const run = await store2.create({ tenantId: "t", toolId: "squad_run" });
  assert.equal(table.tablePosts, 2, "the second store issued its own (409) create");
  assert.ok(await store2.get(run.runId), "a create that races into a 409 already-exists still persists");
});
