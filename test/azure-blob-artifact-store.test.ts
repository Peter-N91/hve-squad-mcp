/**
 * Azure Blob artifact store + user-delegation SAS (Phase 2) — the binary-return
 * channel. Uses an INJECTED fake `fetch` so no network is touched.
 *
 * The load-bearing test is the GOLDEN string-to-sign pin (VF-H1 / RK-1 / OQ-1):
 * the user-delegation SAS field order + count are version-locked, and a silent
 * reorder would produce a URL that Azure rejects at download time. The remaining
 * tests prove the upload headers, tenant-scoped non-guessable path (VF-H2),
 * SAS-as-secret handling (SEC-10), and that the full URL is never logged.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac } from "node:crypto";

import {
  AzureBlobArtifactStore,
  BLOB_API_VERSION,
  PPTX_CONTENT_TYPE,
  buildUserDelegationStringToSign,
  toSasTime,
  type UserDelegationKey,
} from "../src/engine/backends/azure-blob-artifact-store.js";

const KEY: UserDelegationKey = {
  signedOid: "11111111-1111-1111-1111-111111111111",
  signedTid: "22222222-2222-2222-2222-222222222222",
  signedStart: "2026-07-06T12:00:00Z",
  signedExpiry: "2026-07-06T13:00:00Z",
  signedService: "b",
  signedVersion: BLOB_API_VERSION,
  value: Buffer.from("super-secret-delegation-key-bytes").toString("base64"),
};

test("VF-H1: user-delegation string-to-sign is pinned (24 fields, exact order)", () => {
  const s2s = buildUserDelegationStringToSign({
    permissions: "r",
    start: "2026-07-06T12:00:00Z",
    expiry: "2026-07-06T13:00:00Z",
    canonicalizedResource: "/blob/acct/renders/renders/t1/id/deck.pptx",
    key: KEY,
    protocol: "https",
    version: BLOB_API_VERSION,
    resource: "b",
  });
  const expected = [
    "r",
    "2026-07-06T12:00:00Z",
    "2026-07-06T13:00:00Z",
    "/blob/acct/renders/renders/t1/id/deck.pptx",
    "11111111-1111-1111-1111-111111111111",
    "22222222-2222-2222-2222-222222222222",
    "2026-07-06T12:00:00Z",
    "2026-07-06T13:00:00Z",
    "b",
    BLOB_API_VERSION,
    "", // saoid
    "", // suoid
    "", // scid
    "", // sip
    "https",
    BLOB_API_VERSION,
    "b",
    "", // sst
    "", // ses
    "", // rscc
    "", // rscd
    "", // rsce
    "", // rscl
    "", // rsct
  ].join("\n");
  assert.equal(s2s, expected);
  // 24 fields => 23 newlines.
  assert.equal(s2s.split("\n").length, 24);
});

/** A recording logger fake capturing secrets + info fields. */
function recordingLogger() {
  const secrets: string[] = [];
  const infos: { message: string; fields?: Record<string, unknown> }[] = [];
  const logger = {
    registerSecret: (v?: string | null) => {
      if (v) secrets.push(v);
    },
    info: (message: string, fields?: Record<string, unknown>) => infos.push({ message, fields }),
    debug: () => {},
    error: () => {},
  };
  return { logger, secrets, infos };
}

/** A fake fetch: 201 for PUT, a user-delegation-key XML for the key POST. */
function fakeFetch(): { impl: typeof fetch; puts: { url: string; init: RequestInit }[] } {
  const puts: { url: string; init: RequestInit }[] = [];
  const impl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "PUT") {
      puts.push({ url, init });
      return new Response(null, { status: 201 });
    }
    if (url.includes("comp=userdelegationkey")) {
      const xml =
        `<?xml version="1.0"?><UserDelegationKey>` +
        `<SignedOid>${KEY.signedOid}</SignedOid><SignedTid>${KEY.signedTid}</SignedTid>` +
        `<SignedStart>${KEY.signedStart}</SignedStart><SignedExpiry>${KEY.signedExpiry}</SignedExpiry>` +
        `<SignedService>${KEY.signedService}</SignedService><SignedVersion>${KEY.signedVersion}</SignedVersion>` +
        `<Value>${KEY.value}</Value></UserDelegationKey>`;
      return new Response(xml, { status: 200 });
    }
    return new Response(null, { status: 500 });
  }) as unknown as typeof fetch;
  return { impl, puts };
}

test("upload PUTs a BlockBlob with the pptx content-type to a tenant-scoped path", async () => {
  const { impl, puts } = fakeFetch();
  const { logger } = recordingLogger();
  const store = new AzureBlobArtifactStore({
    account: "acct",
    container: "renders",
    getAccessToken: async () => "mi-token",
    fetchImpl: impl,
    logger: logger as never,
  });
  const link = await store.uploadAndMintDownloadSas("tenant-A", new Uint8Array([1, 2, 3]), 60 * 60 * 1000);

  assert.equal(puts.length, 1);
  assert.equal((puts[0].init.headers as Record<string, string>)["x-ms-blob-type"], "BlockBlob");
  assert.equal((puts[0].init.headers as Record<string, string>)["Content-Type"], PPTX_CONTENT_TYPE);
  assert.match(link.blobPath, /^renders\/tenant-A\/[0-9a-f-]{36}\/deck\.pptx$/);
  assert.equal(link.contentType, PPTX_CONTENT_TYPE);
});

test("returned SAS URL carries the signed params and a valid HMAC signature", async () => {
  const { impl } = fakeFetch();
  const store = new AzureBlobArtifactStore({
    account: "acct",
    container: "renders",
    getAccessToken: async () => "mi-token",
    fetchImpl: impl,
  });
  const link = await store.uploadAndMintDownloadSas("t1", new Uint8Array([9]), 30 * 60 * 1000);
  const query = new URL(link.downloadUrl).search.slice(1);
  const params = new URLSearchParams(query);
  assert.equal(params.get("sv"), BLOB_API_VERSION);
  assert.equal(params.get("sr"), "b");
  assert.equal(params.get("sp"), "r");
  assert.equal(params.get("spr"), "https");
  assert.ok(params.get("sig"), "signature present");

  // Recompute the signature from the pinned string-to-sign and compare.
  const blobPath = link.blobPath;
  const expectedSig = createHmac("sha256", Buffer.from(KEY.value, "base64"))
    .update(
      buildUserDelegationStringToSign({
        permissions: "r",
        start: params.get("st") as string,
        expiry: params.get("se") as string,
        canonicalizedResource: `/blob/acct/renders/${blobPath}`,
        key: KEY,
        protocol: "https",
        version: BLOB_API_VERSION,
        resource: "b",
      }),
      "utf8",
    )
    .digest("base64");
  assert.equal(params.get("sig"), expectedSig, "signature matches the pinned string-to-sign");
});

test("SEC-10: the SAS query is registered as a secret and the full URL is never logged", async () => {
  const { impl } = fakeFetch();
  const { logger, secrets, infos } = recordingLogger();
  const store = new AzureBlobArtifactStore({
    account: "acct",
    container: "renders",
    getAccessToken: async () => "mi-token",
    fetchImpl: impl,
    logger: logger as never,
  });
  const link = await store.uploadAndMintDownloadSas("t1", new Uint8Array([9]), 30 * 60 * 1000);
  const sasQuery = new URL(link.downloadUrl).search.slice(1);

  assert.ok(secrets.includes("mi-token"), "the MI token is registered as a secret");
  assert.ok(secrets.includes(sasQuery), "the SAS query string is registered as a secret");
  // No info log field may contain the SAS or the full URL.
  for (const entry of infos) {
    const serialized = JSON.stringify(entry.fields ?? {});
    assert.ok(!serialized.includes("sig="), "no SAS signature in any log field");
    assert.ok(!serialized.includes("?"), "no full URL (with query) in any log field");
  }
});

test("VF-H2: two renders get distinct non-guessable artifact ids", async () => {
  const { impl } = fakeFetch();
  const store = new AzureBlobArtifactStore({
    account: "acct",
    container: "renders",
    getAccessToken: async () => "mi-token",
    fetchImpl: impl,
  });
  const a = await store.uploadAndMintDownloadSas("t1", new Uint8Array([1]), 1000);
  const b = await store.uploadAndMintDownloadSas("t1", new Uint8Array([1]), 1000);
  assert.notEqual(a.blobPath, b.blobPath, "each render mints a fresh UUID path");
});

test("toSasTime renders second-precision UTC", () => {
  assert.equal(toSasTime(new Date("2026-07-06T12:34:56.789Z")), "2026-07-06T12:34:56Z");
});

test("IV-001: a delegation-key response without a signing value fails fast", async () => {
  const impl = (async (_input: unknown, init?: RequestInit) => {
    if (init?.method === "PUT") return new Response(null, { status: 201 });
    // A malformed key response missing <Value>.
    return new Response("<?xml version=\"1.0\"?><UserDelegationKey></UserDelegationKey>", { status: 200 });
  }) as unknown as typeof fetch;
  const store = new AzureBlobArtifactStore({
    account: "acct",
    container: "renders",
    getAccessToken: async () => "mi-token",
    fetchImpl: impl,
  });
  await assert.rejects(
    () => store.uploadAndMintDownloadSas("t1", new Uint8Array([1]), 1000),
    /did not contain a signing key/,
  );
});
