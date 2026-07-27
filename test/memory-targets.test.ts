/**
 * Portable memory destinations — the Microsoft Graph (SharePoint / OneDrive)
 * store and the operator-allow-listed named-target router.
 *
 * The security-relevant claims pinned here:
 *   * a caller may only SELECT among operator-declared destinations; an unknown
 *     name is rejected fail-closed and never falls back to the default;
 *   * `tenantId` remains the isolation prefix on every Graph path;
 *   * traversal payloads never reach a Graph URL (SEC-4);
 *   * `If-Match` gives real compare-and-swap (a 412 is a conflict, not a clobber);
 *   * a SharePoint target is plaintext by default (it exists to be readable) and
 *     ciphertext only when the operator opts in.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { GraphSquadMemoryStore } from "../src/engine/backends/graph-squad-memory.js";
import {
  TargetedSquadMemoryStore,
  UnknownMemoryTargetError,
} from "../src/engine/targeted-squad-memory.js";
import type {
  SquadMemoryEntry,
  SquadMemoryStore,
  SquadMemoryWriteResult,
} from "../src/engine/squad-memory-state.js";

const TENANT = "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** A scripted fetch that records every request the store issues. */
function fakeFetch(
  responder: (call: Call) => { status: number; body?: unknown; text?: string },
): { impl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = (async (input: unknown, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers as Record<string, string>) ?? {},
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(call);
    const result = responder(call);
    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      json: async () => result.body ?? {},
      text: async () => result.text ?? "",
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function graphStore(
  responder: (call: Call) => { status: number; body?: unknown; text?: string },
  options: Partial<ConstructorParameters<typeof GraphSquadMemoryStore>[0]> = {},
): { store: GraphSquadMemoryStore; calls: Call[] } {
  const { impl, calls } = fakeFetch(responder);
  const store = new GraphSquadMemoryStore({
    driveId: "drive-1",
    rootPath: "squad-memory",
    getAccessToken: async () => "token",
    fetchImpl: impl,
    ...options,
  });
  return { store, calls };
}

test("a Graph write addresses <root>/<tenantId>/<project>/<path>.md", async () => {
  const { store, calls } = graphStore(() => ({
    status: 200,
    body: { eTag: "etag-1", lastModifiedDateTime: "2026-07-27T10:00:00Z" },
  }));

  const result = await store.write(TENANT, "acme", "history/planner", "hello");
  assert.equal(result.ok, true);
  const put = calls.find((call) => call.method === "PUT");
  assert.ok(put);
  assert.match(put.url, /\/drives\/drive-1\/root:\//);
  assert.match(put.url, /squad-memory\//);
  assert.match(put.url, new RegExp(TENANT));
  assert.match(put.url, /acme\/history\/planner\.md:\/content$/);
  assert.equal(put.body, "hello", "plaintext by default — a SharePoint file stays readable");
});

test("expectedEtag becomes If-Match and a 412 is reported as a conflict", async () => {
  const { store, calls } = graphStore((call) => {
    if (call.method === "PUT") {
      return { status: 412 };
    }
    return { status: 404 };
  });

  const result = await store.write(TENANT, "acme", "state", "new", "etag-old");
  assert.equal(result.ok, false);
  assert.equal((result as { conflict?: boolean }).conflict, true);
  const put = calls.find((call) => call.method === "PUT");
  assert.equal(put?.headers["If-Match"], "etag-old");
});

test("SEC-4: a traversal path never issues a Graph request", async () => {
  const { store, calls } = graphStore(() => ({ status: 200, body: {} }));
  const result = await store.write(TENANT, "acme", "../../secrets", "x");
  assert.equal(result.ok, false);
  assert.equal(await store.read(TENANT, "acme", "../../secrets"), undefined);
  assert.equal(calls.length, 0, "no URL was ever built from an unsafe path");
});

test("a missing folder lists as empty rather than throwing", async () => {
  const { store } = graphStore(() => ({ status: 404 }));
  assert.deepEqual(await store.list(TENANT, "acme"), []);
  assert.deepEqual(await store.listProjects(TENANT), []);
});

test("list walks nested folders and reports logical paths", async () => {
  const { store } = graphStore((call) => {
    if (call.url.includes("acme/history")) {
      return { status: 200, body: { value: [{ name: "planner.md", eTag: "e2" }] } };
    }
    if (call.url.includes("/acme:")) {
      return {
        status: 200,
        body: { value: [{ name: "state.md", eTag: "e1" }, { name: "history", folder: {} }] },
      };
    }
    return { status: 404 };
  });

  const entries = await store.list(TENANT, "acme");
  const paths = entries.map((entry) => entry.path).sort();
  assert.deepEqual(paths, ["history/planner", "state"]);
});

test("an unsafe rootPath fails fast at construction", () => {
  assert.throws(
    () =>
      new GraphSquadMemoryStore({
        driveId: "d",
        rootPath: "../escape",
        getAccessToken: async () => "t",
      }),
    /not a safe path segment/,
  );
});

// ---------------------------------------------------------------------------
// Named-target routing
// ---------------------------------------------------------------------------

class SpyStore implements SquadMemoryStore {
  writes: string[] = [];
  constructor(readonly label: string) {}
  list(): Promise<SquadMemoryEntry[]> {
    return Promise.resolve([]);
  }
  read(): Promise<SquadMemoryEntry | undefined> {
    return Promise.resolve(undefined);
  }
  write(_t: string, _p: string, path: string): Promise<SquadMemoryWriteResult> {
    this.writes.push(path);
    return Promise.resolve({
      ok: true,
      etag: this.label,
      entry: { tenantId: "t", project: "p", path, content: "", etag: this.label, updatedAt: 0 },
    });
  }
  listProjects(): Promise<string[]> {
    return Promise.resolve([]);
  }
}

test("a call with no target uses the operator's default destination", async () => {
  const azure = new SpyStore("azure");
  const sharepoint = new SpyStore("sharepoint");
  const router = new TargetedSquadMemoryStore({
    targets: new Map([
      ["azure", azure],
      ["sharepoint", sharepoint],
    ]),
    defaultTarget: "azure",
  });
  const result = await router.write(TENANT, "acme", "state", "x");
  assert.equal((result as { etag?: string }).etag, "azure");
  assert.deepEqual(router.targetNames(), ["azure", "sharepoint"]);
});

test("a caller may select a declared destination by name", async () => {
  const azure = new SpyStore("azure");
  const sharepoint = new SpyStore("sharepoint");
  const router = new TargetedSquadMemoryStore({
    targets: new Map([
      ["azure", azure],
      ["sharepoint", sharepoint],
    ]),
    defaultTarget: "azure",
  });
  const result = await router.writeOn("sharepoint", TENANT, "acme", "state", "x");
  assert.equal((result as { etag?: string }).etag, "sharepoint");
  assert.deepEqual(sharepoint.writes, ["state"]);
  assert.deepEqual(azure.writes, [], "the default destination was untouched");
});

test("an undeclared target is rejected fail-closed (never a silent default)", () => {
  const router = new TargetedSquadMemoryStore({
    targets: new Map([["azure", new SpyStore("azure")]]),
    defaultTarget: "azure",
  });
  assert.throws(() => router.resolve("attacker-drive"), UnknownMemoryTargetError);
  // The error must not echo the caller's value or reveal any destination detail.
  try {
    router.resolve("attacker-drive");
  } catch (error) {
    assert.doesNotMatch(String((error as Error).message), /attacker-drive/);
  }
});

test("a default target that is not declared fails fast at construction", () => {
  assert.throws(
    () =>
      new TargetedSquadMemoryStore({
        targets: new Map([["azure", new SpyStore("azure")]]),
        defaultTarget: "missing",
      }),
    /not a declared target/,
  );
});
