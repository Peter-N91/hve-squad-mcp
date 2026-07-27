/**
 * Conformance — memory broker default-deny scope + disabled-flag posture
 * (Phase 6, Step 6.2).
 *
 * The shared-state broker is fail-closed on TWO distinct least-privilege scopes:
 * `Squad.Memory` guards the read surface (`resources/*` + `squad_memory_read`) and
 * `Squad.MemoryWrite` guards `squad_memory_write`. This corpus proves the scope
 * check runs BEFORE any store access (a denied caller never touches the store) and
 * that with the feature OFF (no store injected) the resource surface does not
 * exist at all and `initialize` does not advertise `resources`. Mirrors the
 * default-deny assertion style of test/security-hardening.test.ts and
 * test/conformance/auth-rejection.test.ts; runs with a recording store that fails
 * if reached — NO live Azure.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildHarness, callTool, initializeSession } from "./support/harness.js";
import { FakeJwtVerifier, bearer } from "./support/fake-auth.js";
import type {
  SquadMemoryEntry,
  SquadMemoryStore,
  SquadMemoryWriteResult,
} from "../../src/engine/squad-memory-state.js";
import type { HttpMcpHandler, HttpResponseLike } from "../../src/transports/http-core.js";

const ORIGIN = "https://copilotstudio.microsoft.com";
const JSON_HEADERS: Record<string, string> = { "content-type": "application/json" };

const TENANT = "33333333-cccc-4ccc-8ccc-cccccccccccc";

/**
 * A store that counts every access and FAILS the test if reached. It proves the
 * scope gate short-circuits before any store operation (the memory analogue of
 * the `backend.callCount === 0` assertion the other corpora make).
 */
class RecordingMemoryStore implements SquadMemoryStore {
  calls = 0;
  list(): Promise<SquadMemoryEntry[]> {
    this.calls += 1;
    return Promise.resolve([]);
  }
  read(): Promise<SquadMemoryEntry | undefined> {
    this.calls += 1;
    return Promise.resolve(undefined);
  }
  write(): Promise<SquadMemoryWriteResult> {
    this.calls += 1;
    return Promise.resolve({ ok: false, conflict: true, current: undefined });
  }
  listProjects(): Promise<string[]> {
    this.calls += 1;
    return Promise.resolve([]);
  }
}

function reasonOf(res: HttpResponseLike): string | undefined {
  return (res.body as { error?: string } | undefined)?.error;
}
function rpcErrorOf(res: HttpResponseLike): { code: number; message: string } | undefined {
  return (res.body as { error?: { code: number; message: string } } | undefined)?.error;
}

function rpc(
  handler: HttpMcpHandler,
  token: string,
  sessionId: string,
  method: string,
  params: Record<string, unknown>,
): Promise<HttpResponseLike> {
  return handler.handle({
    method: "POST",
    path: "/mcp",
    headers: {
      origin: ORIGIN,
      authorization: bearer(token),
      "mcp-session-id": sessionId,
      ...JSON_HEADERS,
    },
    body: { jsonrpc: "2.0", id: 2, method, params },
  });
}

// ---------------------------------------------------------------------------
// SEC-2 — default-deny on the memory scopes, checked BEFORE any store access.
// ---------------------------------------------------------------------------

test("SEC-2: a token missing Squad.Memory is denied on resources/* and squad_memory_read (before store)", async () => {
  const store = new RecordingMemoryStore();
  const verifier = new FakeJwtVerifier();
  // Carries the WRITE scope only — so a denial proves the read surface needs the
  // distinct Squad.Memory read scope, not merely "some memory scope".
  verifier.register({ token: "write-only", tenantId: TENANT, subject: "user-c", scopes: ["Squad.MemoryWrite"] });
  const { handler } = buildHarness({ verifier, memoryStore: store });
  const sessionId = await initializeSession(handler, "write-only");

  const list = await rpc(handler, "write-only", sessionId, "resources/list", {});
  assert.equal(list.status, 403, "resources/list requires Squad.Memory");
  assert.equal(reasonOf(list), "missing_scope");

  const read = await rpc(handler, "write-only", sessionId, "resources/read", { uri: "squad-memory://p/state" });
  assert.equal(read.status, 403, "resources/read requires Squad.Memory");
  assert.equal(reasonOf(read), "missing_scope");

  const templates = await rpc(handler, "write-only", sessionId, "resources/templates/list", {});
  assert.equal(templates.status, 403, "resources/templates/list requires Squad.Memory");
  assert.equal(reasonOf(templates), "missing_scope");

  const toolRead = await callTool(handler, {
    token: "write-only",
    sessionId,
    name: "squad_memory_read",
    args: { project: "p", path: "state" },
  });
  assert.equal(toolRead.status, 403, "squad_memory_read requires Squad.Memory");
  assert.equal(reasonOf(toolRead), "missing_scope");

  assert.equal(store.calls, 0, "the scope gate denied every read before any store access");
});

test("SEC-2: a token missing Squad.MemoryWrite cannot squad_memory_write (before store)", async () => {
  const store = new RecordingMemoryStore();
  const verifier = new FakeJwtVerifier();
  // Carries the READ scope only — so it may read but not write.
  verifier.register({ token: "read-only", tenantId: TENANT, subject: "user-c", scopes: ["Squad.Memory"] });
  const { handler } = buildHarness({ verifier, memoryStore: store });
  const sessionId = await initializeSession(handler, "read-only");

  const write = await callTool(handler, {
    token: "read-only",
    sessionId,
    name: "squad_memory_write",
    args: { project: "p", path: "state", content: "nope" },
  });
  assert.equal(write.status, 403, "squad_memory_write requires the distinct Squad.MemoryWrite scope");
  assert.equal(reasonOf(write), "missing_scope");
  assert.equal(store.calls, 0, "the scope gate denied the write before any store access");
});

test("SEC-2: a token with NO memory scope is denied read and write (before store)", async () => {
  const store = new RecordingMemoryStore();
  const verifier = new FakeJwtVerifier();
  verifier.register({ token: "no-mem", tenantId: TENANT, subject: "user-c", scopes: ["Squad.Research"] });
  const { handler } = buildHarness({ verifier, memoryStore: store });
  const sessionId = await initializeSession(handler, "no-mem");

  const list = await rpc(handler, "no-mem", sessionId, "resources/list", {});
  assert.equal(list.status, 403);
  assert.equal(reasonOf(list), "missing_scope");

  const write = await callTool(handler, {
    token: "no-mem",
    sessionId,
    name: "squad_memory_write",
    args: { project: "p", path: "state", content: "nope" },
  });
  assert.equal(write.status, 403);
  assert.equal(reasonOf(write), "missing_scope");
  assert.equal(store.calls, 0, "no store access for an unscoped caller");
});

// ---------------------------------------------------------------------------
// DR-01 / DR-10 — with the feature OFF (no store injected) the resource surface
// does not exist and initialize does not advertise `resources`.
// ---------------------------------------------------------------------------

test("feature OFF: initialize omits the resources capability (advisory-only default)", async () => {
  const verifier = new FakeJwtVerifier();
  verifier.register({ token: "mem", tenantId: TENANT, subject: "user-c", scopes: ["Squad.Memory", "Squad.MemoryWrite"] });
  const { handler } = buildHarness({ verifier }); // no memoryStore

  const res = await handler.handle({
    method: "POST",
    path: "/mcp",
    headers: { origin: ORIGIN, authorization: bearer("mem"), ...JSON_HEADERS },
    body: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
  });
  assert.equal(res.status, 200);
  const capabilities = (res.body as { result?: { capabilities?: Record<string, unknown> } }).result?.capabilities;
  assert.ok(capabilities, "initialize advertises capabilities");
  assert.ok("tools" in (capabilities ?? {}), "tools capability is always advertised");
  assert.ok(!("resources" in (capabilities ?? {})), "resources capability is NOT advertised when the broker is off");
});

test("feature OFF: resources/* return method-not-found even with full memory scopes", async () => {
  const verifier = new FakeJwtVerifier();
  verifier.register({ token: "mem", tenantId: TENANT, subject: "user-c", scopes: ["Squad.Memory", "Squad.MemoryWrite"] });
  const { handler } = buildHarness({ verifier }); // no memoryStore
  const sessionId = await initializeSession(handler, "mem");

  for (const method of ["resources/list", "resources/read", "resources/templates/list"]) {
    const res = await rpc(handler, "mem", sessionId, method, { uri: "squad-memory://p/state" });
    assert.equal(res.status, 200, `${method} returns a JSON-RPC error envelope, not an HTTP error`);
    assert.equal(rpcErrorOf(res)?.code, -32601, `${method} is method-not-found when the broker is off`);
  }
});

test("feature OFF: squad_memory_read / squad_memory_write are unavailable even with scopes", async () => {
  const verifier = new FakeJwtVerifier();
  verifier.register({ token: "mem", tenantId: TENANT, subject: "user-c", scopes: ["Squad.Memory", "Squad.MemoryWrite"] });
  const { handler } = buildHarness({ verifier }); // no memoryStore
  const sessionId = await initializeSession(handler, "mem");

  const read = await callTool(handler, {
    token: "mem",
    sessionId,
    name: "squad_memory_read",
    args: { project: "p", path: "state" },
  });
  assert.equal(read.status, 200);
  assert.equal(rpcErrorOf(read)?.code, -32601, "squad_memory_read is unavailable when the broker is off");

  const write = await callTool(handler, {
    token: "mem",
    sessionId,
    name: "squad_memory_write",
    args: { project: "p", path: "state", content: "x" },
  });
  assert.equal(write.status, 200);
  assert.equal(rpcErrorOf(write)?.code, -32601, "squad_memory_write is unavailable when the broker is off");
});
