/**
 * Conformance — memory broker cross-tenant isolation (Phase 6, Step 6.2).
 *
 * The shared-state broker keys every store operation on the authenticated
 * `auth.tenantId` from the validated Entra token and NEVER on the caller-supplied
 * `project`. This corpus proves the project-key-spoofing defense end-to-end over
 * the real `/mcp` handler: two tenants that name the SAME `project` land in
 * SEPARATE `tenantId:project` partitions, so tenant A can neither read nor clobber
 * tenant B's memory through `resources/read`, `squad_memory_read`, or
 * `squad_memory_write`. Mirrors test/conformance/cross-tenant.test.ts for the
 * auth/handler harness; runs with an in-process file-backed store (temp dir) — NO
 * live Azure.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildHarness, callTool, initializeSession } from "./support/harness.js";
import { FakeJwtVerifier, bearer } from "./support/fake-auth.js";
import { FileSquadMemoryStore } from "../../src/engine/backends/file-squad-memory.js";
import type { SquadMemoryStore } from "../../src/engine/squad-memory-state.js";
import type { HttpMcpHandler, HttpResponseLike } from "../../src/transports/http-core.js";

const ORIGIN = "https://copilotstudio.microsoft.com";
const JSON_HEADERS: Record<string, string> = { "content-type": "application/json" };

const TENANT_A = "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** The memory scopes both callers carry (they differ only by tenant). */
const MEMORY_SCOPES = ["Squad.Memory", "Squad.MemoryWrite"];

function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "squad-memory-xtenant-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Build a memory-enabled harness backed by the given store; return the two callers' handles. */
function buildMemoryHarness(store: SquadMemoryStore): {
  handler: HttpMcpHandler;
  verifier: FakeJwtVerifier;
} {
  const verifier = new FakeJwtVerifier();
  verifier.register({ token: "tenant-a", tenantId: TENANT_A, subject: "user-a", scopes: MEMORY_SCOPES });
  verifier.register({ token: "tenant-b", tenantId: TENANT_B, subject: "user-b", scopes: MEMORY_SCOPES });
  const { handler } = buildHarness({ verifier, memoryStore: store });
  return { handler, verifier };
}

/** Issue a raw JSON-RPC request over the handler with an existing session. */
function rpc(
  handler: HttpMcpHandler,
  token: string,
  sessionId: string,
  method: string,
  params: Record<string, unknown>,
  id = 2,
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
    body: { jsonrpc: "2.0", id, method, params },
  });
}

function rpcResult(res: HttpResponseLike): Record<string, unknown> | undefined {
  return (res.body as { result?: Record<string, unknown> } | undefined)?.result;
}
function rpcErrorOf(res: HttpResponseLike): { code: number; message: string } | undefined {
  return (res.body as { error?: { code: number; message: string } } | undefined)?.error;
}

test("SEC-3: tenant A cannot read tenant B's same-named project via squad_memory_read", async () => {
  const { dir, cleanup } = tempDir();
  const store = new FileSquadMemoryStore({ baseDir: dir });
  try {
    const { handler } = buildMemoryHarness(store);
    const aSession = await initializeSession(handler, "tenant-a");
    const bSession = await initializeSession(handler, "tenant-b");

    // Tenant A writes its own memory under project "shared" (same label B will use).
    const aWrite = await callTool(handler, {
      token: "tenant-a",
      sessionId: aSession,
      name: "squad_memory_write",
      args: { project: "shared", path: "state", content: "A-ONLY-SECRET" },
    });
    assert.equal(aWrite.status, 200);
    assert.ok(rpcResult(aWrite)?.etag, "tenant A's write returns an etag");

    // Tenant B reads the SAME project label + path — a partition MISS, not A's data.
    const bRead = await callTool(handler, {
      token: "tenant-b",
      sessionId: bSession,
      name: "squad_memory_read",
      args: { project: "shared", path: "state" },
    });
    assert.equal(bRead.status, 200);
    assert.equal(rpcErrorOf(bRead)?.code, -32602, "tenant B sees a miss (its own empty partition)");
    assert.ok(
      !JSON.stringify(bRead.body).includes("A-ONLY-SECRET"),
      "tenant A's content never appears in tenant B's response",
    );

    // Ground truth in the store: the key is derived from tenantId, not project.
    assert.equal((await store.read(TENANT_A, "shared", "state"))?.content, "A-ONLY-SECRET");
    assert.equal(await store.read(TENANT_B, "shared", "state"), undefined, "B's partition stays empty");
  } finally {
    cleanup();
  }
});

test("SEC-3: tenant B's write to the same project name cannot clobber tenant A's entry", async () => {
  const { dir, cleanup } = tempDir();
  const store = new FileSquadMemoryStore({ baseDir: dir });
  try {
    const { handler } = buildMemoryHarness(store);
    const aSession = await initializeSession(handler, "tenant-a");
    const bSession = await initializeSession(handler, "tenant-b");

    await callTool(handler, {
      token: "tenant-a",
      sessionId: aSession,
      name: "squad_memory_write",
      args: { project: "shared", path: "state", content: "A-ORIGINAL" },
    });
    // Tenant B writes the SAME project/path — must land in B's OWN partition.
    const bWrite = await callTool(handler, {
      token: "tenant-b",
      sessionId: bSession,
      name: "squad_memory_write",
      args: { project: "shared", path: "state", content: "B-OVERWRITE" },
    });
    assert.equal(bWrite.status, 200);
    assert.ok(rpcResult(bWrite)?.etag, "tenant B's write succeeds in its own partition");

    // Tenant A's entry is untouched; B has its own distinct entry.
    assert.equal((await store.read(TENANT_A, "shared", "state"))?.content, "A-ORIGINAL", "A not clobbered");
    assert.equal((await store.read(TENANT_B, "shared", "state"))?.content, "B-OVERWRITE", "B keyed to its tenant");
  } finally {
    cleanup();
  }
});

test("SEC-3: tenant B cannot read tenant A's entry via resources/read (URI carries no tenant)", async () => {
  const { dir, cleanup } = tempDir();
  const store = new FileSquadMemoryStore({ baseDir: dir });
  try {
    const { handler } = buildMemoryHarness(store);
    const aSession = await initializeSession(handler, "tenant-a");
    const bSession = await initializeSession(handler, "tenant-b");

    await callTool(handler, {
      token: "tenant-a",
      sessionId: aSession,
      name: "squad_memory_write",
      args: { project: "shared", path: "state", content: "A-RESOURCE-SECRET" },
    });

    // The URI names only project/path — the tenant is implicit (auth.tenantId).
    const uri = "squad-memory://shared/state";

    // Tenant A resolves its own resource.
    const aResource = await rpc(handler, "tenant-a", aSession, "resources/read", { uri });
    assert.equal(aResource.status, 200);
    const aContents = (rpcResult(aResource) as { contents?: { text?: string }[] } | undefined)?.contents ?? [];
    assert.equal(aContents[0]?.text, "A-RESOURCE-SECRET", "tenant A reads its own memory");

    // Tenant B resolves the SAME uri — a generic no-leakage error, never A's content.
    const bResource = await rpc(handler, "tenant-b", bSession, "resources/read", { uri });
    assert.equal(bResource.status, 200);
    assert.ok(rpcErrorOf(bResource), "tenant B is denied the resource");
    assert.ok(
      !JSON.stringify(bResource.body).includes("A-RESOURCE-SECRET"),
      "tenant A's content never appears in tenant B's resources/read response",
    );

    // resources/list for tenant B enumerates only B's (empty) memory.
    const bList = await rpc(handler, "tenant-b", bSession, "resources/list", {});
    const bResources = (rpcResult(bList) as { resources?: unknown[] } | undefined)?.resources ?? [];
    assert.deepEqual(bResources, [], "tenant B lists none of tenant A's resources");
  } finally {
    cleanup();
  }
});
