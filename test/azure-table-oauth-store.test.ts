import assert from "node:assert/strict";
import { test } from "node:test";

import { AzureTableOAuthGrantStore } from "../src/auth/azure-table-oauth-store.js";
import { oauthSecretHash } from "../src/auth/oauth-store.js";

test("Azure Table OAuth grants store only a hash and consume under ETag CAS", async () => {
  const secret = "single-use-secret-value";
  const calls: { url: string; init?: RequestInit }[] = [];
  let entity:
    | {
        PartitionKey: string;
        RowKey: string;
        payload: string;
        expiresAt: string;
        "expiresAt@odata.type": string;
        createdAt: string;
        "createdAt@odata.type": string;
      }
    | undefined;
  let consumed = false;

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/Tables")) {
      return new Response(undefined, { status: 201 });
    }
    if (init?.method === "POST") {
      entity = JSON.parse(String(init.body)) as typeof entity;
      return new Response(undefined, { status: 204 });
    }
    if (init?.method === "GET") {
      if (!entity || consumed) {
        return new Response(undefined, { status: 404 });
      }
      return new Response(JSON.stringify(entity), {
        status: 200,
        headers: { etag: 'W/"grant-etag"' },
      });
    }
    if (init?.method === "DELETE") {
      assert.equal((init.headers as Record<string, string>)["If-Match"], 'W/"grant-etag"');
      consumed = true;
      return new Response(undefined, { status: 204 });
    }
    throw new Error(`unexpected request ${init?.method} ${url}`);
  };

  const store = new AzureTableOAuthGrantStore({
    account: "account",
    tableName: "squadoauth",
    getAccessToken: () => Promise.resolve("storage-token-value"),
    fetchImpl,
    endpoint: "https://table.example",
    now: () => 1_800_000_000_000,
  });

  await store.put("login", secret, {
    payload: "sealed",
    expiresAt: 1_800_000_600_000,
  });
  assert.equal(entity?.RowKey, oauthSecretHash(secret));
  assert.equal(entity?.createdAt, "1800000000000");
  assert.equal(entity?.["createdAt@odata.type"], "Edm.Int64");
  assert.equal(entity?.expiresAt, "1800000600000");
  assert.equal(entity?.["expiresAt@odata.type"], "Edm.Int64");
  assert.doesNotMatch(JSON.stringify(entity), new RegExp(secret));

  assert.deepEqual(await store.consume("login", secret), {
    payload: "sealed",
    expiresAt: 1_800_000_600_000,
  });
  assert.equal(await store.consume("login", secret), undefined);
  assert.ok(calls.some((call) => call.init?.method === "DELETE"));
});

test("refresh consumption atomically replaces the row with a replay tombstone", async () => {
  const secret = "refresh-token-value";
  let entity: {
    PartitionKey: string;
    RowKey: string;
    payload: string;
    expiresAt: string;
    "expiresAt@odata.type": string;
    createdAt: string;
    "createdAt@odata.type": string;
    consumed?: boolean;
  } = {
    PartitionKey: "refresh",
    RowKey: oauthSecretHash(secret),
    payload: "active-payload",
    expiresAt: "1800000600000",
    "expiresAt@odata.type": "Edm.Int64",
    createdAt: "1800000000000",
    "createdAt@odata.type": "Edm.Int64",
  };
  let etag = 'W/"active"';
  const fetchImpl: typeof fetch = async (_input, init) => {
    if (init?.method === "GET") {
      return new Response(JSON.stringify(entity), {
        status: 200,
        headers: { etag },
      });
    }
    if (init?.method === "PUT") {
      assert.equal((init.headers as Record<string, string>)["If-Match"], etag);
      entity = JSON.parse(String(init.body)) as typeof entity;
      etag = 'W/"tombstone"';
      return new Response(undefined, { status: 204 });
    }
    throw new Error(`unexpected ${init?.method}`);
  };
  const store = new AzureTableOAuthGrantStore({
    account: "account",
    tableName: "squadoauth",
    getAccessToken: () => Promise.resolve("storage-token-value"),
    fetchImpl,
    endpoint: "https://table.example",
    now: () => 1_800_000_000_000,
  });

  const consumed = await store.consumeWithTombstone("refresh", secret, () => ({
    payload: "replay-family",
    expiresAt: 1_800_000_600_000,
  }));
  assert.deepEqual(consumed, {
    status: "consumed",
    grant: { payload: "active-payload", expiresAt: 1_800_000_600_000 },
  });
  assert.equal(entity.consumed, true);
  assert.equal(entity.payload, "replay-family");

  const replayed = await store.consumeWithTombstone("refresh", secret, () => {
    throw new Error("a replay must not create another tombstone");
  });
  assert.deepEqual(replayed, {
    status: "replayed",
    tombstone: { payload: "replay-family", expiresAt: 1_800_000_600_000 },
  });
});

test("expired-grant sweep deletes a bounded set with wildcard ETags", async () => {
  const deletes: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (init?.method === "GET") {
      assert.match(url, /%24filter=expiresAt\+lt\+1800000000000L/);
      return new Response(
        JSON.stringify({
          value: [
            { PartitionKey: "login", RowKey: "row-a" },
            { PartitionKey: "refresh", RowKey: "row-b" },
          ],
        }),
        { status: 200 },
      );
    }
    if (init?.method === "DELETE") {
      assert.equal((init.headers as Record<string, string>)["If-Match"], "*");
      deletes.push(url);
      return new Response(undefined, { status: 204 });
    }
    throw new Error(`unexpected ${init?.method}`);
  };
  const store = new AzureTableOAuthGrantStore({
    account: "account",
    tableName: "squadoauth",
    getAccessToken: () => Promise.resolve("storage-token-value"),
    fetchImpl,
    endpoint: "https://table.example",
    now: () => 1_800_000_000_000,
  });

  assert.equal(await store.sweepExpired(2), 2);
  assert.equal(deletes.length, 2);
});

test("persistent grant updates use ETag CAS without deleting the family row", async () => {
  let entity = {
    PartitionKey: "refresh-family",
    RowKey: oauthSecretHash("family-id"),
    payload: "generation-0",
    expiresAt: "1800000600000",
    "expiresAt@odata.type": "Edm.Int64",
    createdAt: "1800000000000",
    "createdAt@odata.type": "Edm.Int64",
  };
  let deletes = 0;
  const fetchImpl: typeof fetch = async (_input, init) => {
    if (init?.method === "GET") {
      return new Response(JSON.stringify(entity), {
        status: 200,
        headers: { etag: 'W/"family-0"' },
      });
    }
    if (init?.method === "PUT") {
      assert.equal((init.headers as Record<string, string>)["If-Match"], 'W/"family-0"');
      entity = JSON.parse(String(init.body)) as typeof entity;
      return new Response(undefined, { status: 204 });
    }
    if (init?.method === "DELETE") {
      deletes += 1;
    }
    throw new Error(`unexpected ${init?.method}`);
  };
  const store = new AzureTableOAuthGrantStore({
    account: "account",
    tableName: "squadoauth",
    getAccessToken: () => Promise.resolve("storage-token-value"),
    fetchImpl,
    endpoint: "https://table.example",
    now: () => 1_800_000_000_000,
  });

  assert.equal(
    await store.update("refresh-family", "family-id", (grant) => ({
      ...grant,
      payload: "generation-1",
    })),
    "updated",
  );
  assert.equal(entity.payload, "generation-1");
  assert.equal(deletes, 0);
});
