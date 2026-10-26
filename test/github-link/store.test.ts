import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { principalKeyOf } from "../../src/auth/entra.js";
import { AesGcmFieldCipher } from "../../src/engine/field-cipher.js";
import { FileGitHubLinkStore, InMemoryGitHubLinkStore } from "../../src/github-link/store.js";
import { TokenSealer } from "../../src/github-link/token-seal.js";
import { GitHubLinkError, type GitHubLinkRecord, type GitHubLinkStore } from "../../src/github-link/types.js";
import { ALICE, BOB, TENANT } from "./harness.js";

function record(principal = ALICE, patch: Partial<GitHubLinkRecord> = {}): GitHubLinkRecord {
  return {
    tenantId: principal.tenantId,
    oid: principal.objectId,
    githubUserId: 1001,
    githubLogin: "alice-gh",
    tokenKind: "ghu",
    accessTokenEnc: "enc-a",
    credentialVersion: 1,
    linkedAt: "2026-10-17T08:00:00.000Z",
    updatedAt: "2026-10-17T08:00:00.000Z",
    ...patch,
  };
}

function contract(name: string, make: () => Promise<{ store: GitHubLinkStore; cleanup?: () => Promise<void> }>): void {
  describe(`${name} CAS contract`, () => {
    let store: GitHubLinkStore;
    let cleanup: (() => Promise<void>) | undefined;
    beforeEach(async () => {
      ({ store, cleanup } = await make());
    });
    afterEach(async () => cleanup?.());

    it("creates only when absent and returns an etag", async () => {
      assert.equal(await store.get(principalKeyOf(ALICE)), undefined);
      const first = await store.putIfMatch(record(), undefined);
      assert.ok(first.ok);
      assert.deepEqual((await store.get(principalKeyOf(ALICE)))?.record, record());
      assert.deepEqual(await store.putIfMatch(record(ALICE, { credentialVersion: 9 }), undefined), { ok: false });
    });

    it("updates only with the current etag; stale etags lose", async () => {
      const first = await store.putIfMatch(record(), undefined);
      assert.ok(first.ok);
      const second = await store.putIfMatch(record(ALICE, { credentialVersion: 2 }), first.etag);
      assert.ok(second.ok);
      assert.notEqual(second.etag, first.etag);
      assert.deepEqual(await store.putIfMatch(record(ALICE, { credentialVersion: 3 }), first.etag), { ok: false });
      assert.equal((await store.get(principalKeyOf(ALICE)))?.record.credentialVersion, 2);
    });

    it("exactly one of many concurrent writers with the same etag wins", async () => {
      const first = await store.putIfMatch(record(), undefined);
      assert.ok(first.ok);
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) => store.putIfMatch(record(ALICE, { credentialVersion: 10 + i }), first.etag)),
      );
      assert.equal(results.filter((r) => r.ok).length, 1);
    });

    it("keeps principals separate and deletes with or without an etag", async () => {
      const a = await store.putIfMatch(record(ALICE), undefined);
      await store.putIfMatch(record(BOB, { githubUserId: 2002 }), undefined);
      assert.equal((await store.get(principalKeyOf(BOB)))?.record.githubUserId, 2002);
      assert.ok(a.ok);
      assert.equal(await store.delete(principalKeyOf(ALICE), "stale"), false);
      assert.equal(await store.delete(principalKeyOf(ALICE), a.etag), true);
      assert.equal(await store.delete(principalKeyOf(ALICE)), false);
      assert.equal(await store.delete(principalKeyOf(BOB)), true);
    });

    it("returns copies, not live references", async () => {
      await store.putIfMatch(record(), undefined);
      const read = await store.get(principalKeyOf(ALICE));
      assert.ok(read);
      read.record.githubLogin = "mutated";
      assert.equal((await store.get(principalKeyOf(ALICE)))?.record.githubLogin, "alice-gh");
    });
  });
}

contract("InMemoryGitHubLinkStore", async () => ({ store: new InMemoryGitHubLinkStore() }));

let dirs: string[] = [];
contract("FileGitHubLinkStore", async () => {
  const dir = await mkdtemp(join(process.cwd(), "test", "github-link", ".tmp-store-"));
  dirs.push(dir);
  return { store: new FileGitHubLinkStore(dir), cleanup: () => rm(dir, { recursive: true, force: true }) };
});

describe("FileGitHubLinkStore specifics", () => {
  let dir: string;
  let store: FileGitHubLinkStore;
  beforeEach(async () => {
    dir = await mkdtemp(join(process.cwd(), "test", "github-link", ".tmp-store-"));
    store = new FileGitHubLinkStore(dir);
  });
  afterEach(async () => rm(dir, { recursive: true, force: true }));

  it("hashes the tenant in the file name and leaves no temp or lock files", async () => {
    await store.putIfMatch(record(), undefined);
    const files = await readdir(dir);
    assert.equal(files.length, 1);
    assert.ok(!files[0].includes(TENANT), "raw tenant id must not appear in the file name");
    assert.match(files[0], /^[0-9a-f]{16}__[a-z0-9-]+\.json$/);
    assert.equal(store.pathFor(principalKeyOf(ALICE)), join(dir, files[0]));
  });

  it("neutralises hostile object ids in the file name", () => {
    const path = store.pathFor(`${TENANT}|../../etc/passwd`);
    assert.ok(path.startsWith(dir));
    assert.ok(!path.slice(dir.length).includes(".."));
  });

  it("survives a second store instance (cross-process style) racing on the same etag", async () => {
    const other = new FileGitHubLinkStore(dir);
    const first = await store.putIfMatch(record(), undefined);
    assert.ok(first.ok);
    const results = await Promise.all([
      store.putIfMatch(record(ALICE, { credentialVersion: 2 }), first.etag),
      other.putIfMatch(record(ALICE, { credentialVersion: 3 }), first.etag),
    ]);
    assert.equal(results.filter((r) => r.ok).length, 1);
  });

  it("a row file copied to another principal's name fails closed through the sealer", async () => {
    const cipher = new AesGcmFieldCipher(randomBytes(32));
    const sealer = new TokenSealer(cipher);
    const aliceKey = principalKeyOf(ALICE);
    const bobKey = principalKeyOf(BOB);
    await store.putIfMatch(record(ALICE, { accessTokenEnc: sealer.seal(aliceKey, "access", "ghu_alice_secret_value") }), undefined);
    await copyFile(store.pathFor(aliceKey), store.pathFor(bobKey));

    const copied = await store.get(bobKey);
    assert.ok(copied, "the copy is readable, which is exactly why decrypt must bind the principal");
    assert.equal(copied.record.oid, ALICE.objectId, "the row still names its true owner");
    assert.throws(() => sealer.open(bobKey, "access", copied.record.accessTokenEnc), (error: unknown) => {
      assert.ok(error instanceof GitHubLinkError);
      assert.equal(error.code, "github_link_principal_mismatch");
      return true;
    });
    assert.equal(sealer.open(aliceKey, "access", copied.record.accessTokenEnc), "ghu_alice_secret_value");
  });

  it("stores only ciphertext on disk and rejects a malformed file", async () => {
    const cipher = new AesGcmFieldCipher(randomBytes(32));
    const sealer = new TokenSealer(cipher);
    const key = principalKeyOf(ALICE);
    await store.putIfMatch(record(ALICE, { accessTokenEnc: sealer.seal(key, "access", "ghu_plain_marker_12345") }), undefined);
    const [file] = await readdir(dir);
    assert.ok(!(await readFile(join(dir, file), "utf8")).includes("ghu_plain_marker_12345"));
    await writeFile(join(dir, file), "{not json", "utf8");
    await assert.rejects(store.get(key));
  });
});

describe("TokenSealer", () => {
  it("round-trips, and binds both principal and field", () => {
    const sealer = new TokenSealer(new AesGcmFieldCipher(randomBytes(32)));
    const key = principalKeyOf(ALICE);
    const sealed = sealer.seal(key, "refresh", "ghr_secret_token_value");
    assert.ok(!sealed.includes("ghr_secret"));
    assert.equal(sealer.open(key, "refresh", sealed), "ghr_secret_token_value");
    assert.throws(() => sealer.open(principalKeyOf(BOB), "refresh", sealed), { code: "github_link_principal_mismatch" });
    assert.throws(() => sealer.open(key, "access", sealed), { code: "github_link_state_invalid" });
  });

  it("fails closed under a different key", () => {
    const sealed = new TokenSealer(new AesGcmFieldCipher(randomBytes(32))).seal(principalKeyOf(ALICE), "access", "ghu_x_token_value");
    const other = new TokenSealer(new AesGcmFieldCipher(randomBytes(32)));
    assert.throws(() => other.open(principalKeyOf(ALICE), "access", sealed), { code: "github_link_state_invalid" });
  });
});

afterEach(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs = [];
});
