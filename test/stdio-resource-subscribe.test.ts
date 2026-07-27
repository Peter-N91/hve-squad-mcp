/**
 * Stdio live resource push tests (WI-01, stdio ONLY — Phase 3, Step 3.1).
 *
 * Proves the subscribe → write → notify flow end-to-end over a REAL duplex
 * transport (the SDK's {@link InMemoryTransport} linked pair, which behaves like
 * stdio for notification delivery): an MCP client subscribes to a
 * `squad-memory://` URI, a memory write commits and calls the subscription
 * registry's `onWrite` hook, and the client receives EXACTLY ONE
 * `notifications/resources/updated` for that URI. It also proves the negative:
 * writing an UNsubscribed URI delivers no notification, and it asserts the
 * `resources.subscribe` capability is advertised only when a store is injected.
 *
 * The write is genuine (`store.write(...)` via CAS) followed by the SAME
 * `onWrite` hook a future stdio write tool / the Phase 4 `squad_memory_sync`
 * batch tool will call — this module does not depend on that tool existing yet.
 *
 * The HTTP transport is intentionally NOT exercised here: it advertises no
 * `resources.subscribe` capability and emits no notifications (CON-1), so there
 * is nothing to assert beyond its existing 405-on-GET conformance.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

import { createSquadServer } from "../src/server.js";
import { FileSquadMemoryStore } from "../src/engine/backends/file-squad-memory.js";
import { LOCAL_MEMORY_TENANT } from "../src/engine/squad-memory-resources.js";

function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "squad-subscribe-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Connect an MCP client to a `createSquadServer` instance over a linked
 * in-memory transport pair and collect every `notifications/resources/updated`
 * URI the client receives. Returns the wired pieces plus a cleanup that closes
 * both ends.
 */
async function connectClient(store: FileSquadMemoryStore): Promise<{
  client: Client;
  updates: string[];
  memorySubscriptions: NonNullable<ReturnType<typeof createSquadServer>["memorySubscriptions"]>;
  close: () => Promise<void>;
}> {
  const { server, memorySubscriptions } = createSquadServer({ memoryStore: store });
  assert.ok(memorySubscriptions, "a memory store must expose the subscription registry");

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });

  const updates: string[] = [];
  client.setNotificationHandler(ResourceUpdatedNotificationSchema, (notification) => {
    updates.push(notification.params.uri);
  });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    updates,
    memorySubscriptions,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** Let any queued notifications flush across the linked transport pair. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

test("WI-01: server advertises resources.subscribe only when a memory store is injected", async () => {
  // No store → no subscription registry and no resources capability at all.
  const withoutStore = createSquadServer();
  assert.equal(
    withoutStore.memorySubscriptions,
    undefined,
    "no store → no subscription registry (advisory-only default)",
  );

  const { dir, cleanup } = tempDir();
  const wired = await connectClient(new FileSquadMemoryStore({ baseDir: dir }));
  try {
    assert.ok(wired.memorySubscriptions, "store → subscription registry present");
    assert.deepEqual(
      wired.client.getServerCapabilities()?.resources,
      { subscribe: true },
      "store → resources.subscribe advertised over the handshake (stdio live push)",
    );
  } finally {
    await wired.close();
    cleanup();
  }
});

test("WI-01: subscribe → write delivers exactly one resources/updated for that URI", async () => {
  const { dir, cleanup } = tempDir();
  const store = new FileSquadMemoryStore({ baseDir: dir });
  const wired = await connectClient(store);
  try {
    const uri = "squad-memory://alpha/state";

    // Subscribe over the wire, then perform a genuine CAS write followed by the
    // same onWrite hook a memory write path invokes.
    await wired.client.subscribeResource({ uri });
    const write = await store.write(LOCAL_MEMORY_TENANT, "alpha", "state", "the current working state");
    assert.equal(write.ok, true, "the write must commit");
    await wired.memorySubscriptions.onWrite(uri);
    await flush();

    assert.deepEqual(wired.updates, [uri], "exactly one update for the subscribed URI");
  } finally {
    await wired.close();
    cleanup();
  }
});

test("WI-01: a write to an UNsubscribed URI delivers no notification", async () => {
  const { dir, cleanup } = tempDir();
  const store = new FileSquadMemoryStore({ baseDir: dir });
  const wired = await connectClient(store);
  try {
    const subscribed = "squad-memory://alpha/state";
    const other = "squad-memory://alpha/decisions";

    await wired.client.subscribeResource({ uri: subscribed });
    await store.write(LOCAL_MEMORY_TENANT, "alpha", "decisions", "a decision");
    await wired.memorySubscriptions.onWrite(other);
    await flush();

    assert.deepEqual(wired.updates, [], "an unsubscribed URI produces no notification");
  } finally {
    await wired.close();
    cleanup();
  }
});

test("WI-01: unsubscribe stops further notifications for a URI", async () => {
  const { dir, cleanup } = tempDir();
  const store = new FileSquadMemoryStore({ baseDir: dir });
  const wired = await connectClient(store);
  try {
    const uri = "squad-memory://alpha/state";

    await wired.client.subscribeResource({ uri });
    await store.write(LOCAL_MEMORY_TENANT, "alpha", "state", "first");
    await wired.memorySubscriptions.onWrite(uri);
    await flush();
    assert.deepEqual(wired.updates, [uri], "one update while subscribed");

    await wired.client.unsubscribeResource({ uri });
    await store.write(LOCAL_MEMORY_TENANT, "alpha", "state", "second");
    await wired.memorySubscriptions.onWrite(uri);
    await flush();
    assert.deepEqual(wired.updates, [uri], "no further update after unsubscribe");
  } finally {
    await wired.close();
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// WI-02 (Phase 4) — the squad_memory_sync batch tool notifies per written entry.
// ---------------------------------------------------------------------------

interface SyncResultItem {
  readonly path: string;
  readonly ok: boolean;
  readonly etag?: string;
  readonly conflict?: boolean;
}

/** Parse the `{ project, results }` JSON body a squad_memory_sync call returns. */
function parseSyncResults(result: { content?: { type: string; text?: string }[] }): SyncResultItem[] {
  const text = result.content?.find((block) => block.type === "text")?.text ?? "{}";
  return (JSON.parse(text) as { results?: SyncResultItem[] }).results ?? [];
}

test("WI-02: squad_memory_sync is advertised only when a store is injected", async () => {
  const withoutStore = createSquadServer();
  const names = withoutStore.router.toolIds;
  assert.ok(!names.includes("squad_memory_sync"), "no store → the batch tool is not a catalog tool id");

  const { dir, cleanup } = tempDir();
  const wired = await connectClient(new FileSquadMemoryStore({ baseDir: dir }));
  try {
    const listed = await wired.client.listTools();
    assert.ok(
      listed.tools.some((tool) => tool.name === "squad_memory_sync"),
      "store → squad_memory_sync appears in tools/list",
    );
  } finally {
    await wired.close();
    cleanup();
  }
});

test("WI-02: a sync batch delivers exactly one resources/updated per written entry", async () => {
  const { dir, cleanup } = tempDir();
  const store = new FileSquadMemoryStore({ baseDir: dir });
  const wired = await connectClient(store);
  try {
    const stateUri = "squad-memory://alpha/state";
    const decisionsUri = "squad-memory://alpha/decisions";
    await wired.client.subscribeResource({ uri: stateUri });
    await wired.client.subscribeResource({ uri: decisionsUri });

    const result = await wired.client.callTool({
      name: "squad_memory_sync",
      arguments: {
        project: "alpha",
        items: [
          { path: "state", content: "the working state" },
          { path: "decisions", content: "a decision" },
        ],
      },
    });
    await flush();

    const results = parseSyncResults(result as { content?: { type: string; text?: string }[] });
    assert.ok(results.every((item) => item.ok), "both items committed");
    // Exactly one update per successfully-written entry (order not asserted).
    assert.deepEqual([...wired.updates].sort(), [decisionsUri, stateUri], "one update per written entry");
    // The writes actually persisted under the local tenant sentinel.
    assert.equal((await store.read(LOCAL_MEMORY_TENANT, "alpha", "state"))?.content, "the working state");
    assert.equal((await store.read(LOCAL_MEMORY_TENANT, "alpha", "decisions"))?.content, "a decision");
  } finally {
    await wired.close();
    cleanup();
  }
});

test("WI-02: a conflicting item in a batch notifies ONLY the entries that committed", async () => {
  const { dir, cleanup } = tempDir();
  const store = new FileSquadMemoryStore({ baseDir: dir });
  const wired = await connectClient(store);
  try {
    const stateUri = "squad-memory://alpha/state";
    const decisionsUri = "squad-memory://alpha/decisions";
    await wired.client.subscribeResource({ uri: stateUri });
    await wired.client.subscribeResource({ uri: decisionsUri });

    // Seed `state` so the batch can hand it a STALE etag (guaranteed conflict).
    await store.write(LOCAL_MEMORY_TENANT, "alpha", "state", "v1");

    const result = await wired.client.callTool({
      name: "squad_memory_sync",
      arguments: {
        project: "alpha",
        items: [
          { path: "state", content: "v2", expectedEtag: "stale-etag" },
          { path: "decisions", content: "a decision" },
        ],
      },
    });
    await flush();

    const byPath = new Map(
      parseSyncResults(result as { content?: { type: string; text?: string }[] }).map((item) => [item.path, item]),
    );
    assert.equal(byPath.get("state")?.conflict, true, "the stale item lost its CAS race");
    assert.equal(byPath.get("decisions")?.ok, true, "the fresh item committed");
    // Only the committed entry notifies; the conflicting one does NOT.
    assert.deepEqual(wired.updates, [decisionsUri], "one update, for the committed entry only");
    assert.equal((await store.read(LOCAL_MEMORY_TENANT, "alpha", "state"))?.content, "v1", "no silent clobber");
  } finally {
    await wired.close();
    cleanup();
  }
});

