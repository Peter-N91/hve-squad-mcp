import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { principalKeyOf } from "../../src/auth/entra.js";
import { credentialBinding, TokenSealer } from "../../src/github-link/token-seal.js";
import { InMemoryGitHubLinkStore } from "../../src/github-link/store.js";
import {
  GitHubLinkError,
  type GitHubLinkRecord,
  type GitHubLinkStore,
  type PutResult,
  type StoredGitHubLink,
} from "../../src/github-link/types.js";
import { DEFAULT_REFRESH_WINDOW_SECONDS, GitHubLinkService } from "../../src/github-link/service.js";
import { ALICE, GH_ALICE, GH_BOB, linkAs, startHarness, type Harness } from "./harness.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const HOURS = 3600;

let h: Harness;

afterEach(async () => {
  await h.stop();
});

/** Wraps the in-memory store so a test can stall or fail the persist of a refreshed pair (version 2). */
class InstrumentedStore implements GitHubLinkStore {
  readonly inner = new InMemoryGitHubLinkStore();
  readonly events: string[] = [];
  gate?: Promise<void>;
  failPersist = false;

  get(principalKey: string): Promise<StoredGitHubLink | undefined> {
    return this.inner.get(principalKey);
  }

  async putIfMatch(record: GitHubLinkRecord, expectedEtag: string | undefined): Promise<PutResult> {
    const isRefreshedPair = record.credentialVersion === 2 && record.refreshLease === undefined;
    if (isRefreshedPair && this.gate) {
      this.events.push("persist-begin");
      await this.gate;
      this.events.push("persist-done");
    }
    if (isRefreshedPair && this.failPersist) {
      throw new Error("simulated crash before the store write");
    }
    return this.inner.putIfMatch(record, expectedEtag);
  }

  delete(principalKey: string, expectedEtag?: string): Promise<boolean> {
    return this.inner.delete(principalKey, expectedEtag);
  }
}

describe("refresh window (default 65 minutes)", () => {
  beforeEach(async () => {
    h = await startHarness();
  });

  it("defaults to 65 minutes and refuses windows below the SDK threshold", () => {
    assert.equal(DEFAULT_REFRESH_WINDOW_SECONDS, 65 * 60);
    assert.throws(() => h.makeService({ refreshWindowSeconds: 3600 }), /at least 3601/);
  });

  it("refreshes a token with 30 minutes left", async () => {
    const service = h.makeService();
    await linkAs(h, service, ALICE, GH_ALICE);
    h.clock.advanceSeconds(7.5 * HOURS);
    const result = await service.tokenFor(ALICE, { reason: "refresh" });
    assert.equal(result.refreshed, true);
    assert.equal(h.gh.refreshCalls, 1);
    assert.equal(result.credentialVersion, 2);
    assert.equal(result.expiresInSeconds, 8 * HOURS);
    assert.ok(h.gh.accessTokens.has(result.accessToken));
  });

  it("does not refresh a token with 3 hours left", async () => {
    const service = h.makeService();
    await linkAs(h, service, ALICE, GH_ALICE);
    h.clock.advanceSeconds(5 * HOURS);
    const result = await service.tokenFor(ALICE, { reason: "initial" });
    assert.equal(result.refreshed, false);
    assert.equal(h.gh.refreshCalls, 0);
    assert.equal(result.credentialVersion, 1);
    assert.equal(result.expiresInSeconds, 3 * HOURS);
  });

  it("refreshes strictly inside the window: 65 minutes left no, 64 minutes left yes", async () => {
    const service = h.makeService();
    await linkAs(h, service, ALICE, GH_ALICE);
    h.clock.advanceSeconds(8 * HOURS - 65 * 60);
    assert.equal((await service.tokenFor(ALICE, { reason: "initial" })).refreshed, false);
    h.clock.advanceSeconds(60);
    assert.equal((await service.tokenFor(ALICE, { reason: "initial" })).refreshed, true);
    assert.equal(h.gh.refreshCalls, 1);
  });

  it("honours a custom window", async () => {
    const service = h.makeService({ refreshWindowSeconds: 3 * HOURS });
    await linkAs(h, service, ALICE, GH_ALICE);
    h.clock.advanceSeconds(5.5 * HOURS); // 2.5h left < 3h
    assert.equal((await service.tokenFor(ALICE, { reason: "initial" })).refreshed, true);
  });

  it("refreshes roughly every seven hours over a long-lived link", async () => {
    const service = h.makeService();
    await linkAs(h, service, ALICE, GH_ALICE);
    for (let hour = 1; hour <= 48; hour++) {
      h.clock.advanceSeconds(HOURS);
      const result = await service.tokenFor(ALICE, { reason: "refresh" });
      assert.ok(result.expiresInSeconds >= 65 * 60 - 1);
    }
    assert.ok(h.gh.refreshCalls >= 6 && h.gh.refreshCalls <= 8, `refreshCalls=${h.gh.refreshCalls}`);
  });
});

describe("asGitHubTokenProvider", () => {
  beforeEach(async () => {
    h = await startHarness();
  });

  it("returns the SDK shape and always reports expiresIn >= 3601", async () => {
    const service = h.makeService();
    await linkAs(h, service, ALICE, GH_ALICE);
    const provider = service.asGitHubTokenProvider(ALICE, GH_ALICE.id);
    for (let step = 0; step < 40; step++) {
      const out = await provider({ reason: step === 0 ? "initial" : "refresh" });
      assert.equal(out.kind, "token");
      assert.ok(out.accessToken.startsWith("ghu_"));
      assert.ok(Number.isInteger(out.expiresIn) && out.expiresIn >= 3601, `expiresIn=${out.expiresIn}`);
      h.clock.advanceSeconds(1.7 * HOURS);
    }
  });

  it("reports 8h for a non-expiring OAuth app (gho_) token and never calls refresh", async () => {
    h.gh.tokenStyle = "gho";
    const service = h.makeService();
    await linkAs(h, service, ALICE, GH_ALICE);
    h.clock.advanceSeconds(1000 * HOURS);
    const out = await service.asGitHubTokenProvider(ALICE)({ reason: "refresh" });
    assert.equal(out.expiresIn, 8 * HOURS);
    assert.ok(out.accessToken.startsWith("gho_"));
    assert.equal(h.gh.refreshCalls, 0);
    assert.equal((await service.status(ALICE)).tokenKind, "gho");
  });

  it("throws github_reauthentication_required when the token is short-lived and cannot be refreshed", async () => {
    const service = h.makeService();
    await linkAs(h, service, ALICE, GH_ALICE);
    const stored = await h.store.get(principalKeyOf(ALICE));
    assert.ok(stored);
    const { refreshTokenEnc: _dropped, ...withoutRefresh } = stored.record;
    assert.ok((await h.store.putIfMatch(withoutRefresh as GitHubLinkRecord, stored.etag)).ok);
    h.clock.advanceSeconds(7.5 * HOURS);

    await assert.rejects(service.tokenFor(ALICE, { reason: "initial" }), { code: "github_reauthentication_required" });
    await assert.rejects(service.asGitHubTokenProvider(ALICE)({ reason: "refresh" }), {
      code: "github_reauthentication_required",
    });
    assert.equal(h.gh.refreshCalls, 0);
  });

  it("throws, with no fallback credential, when nothing is linked or the identity differs", async () => {
    const service = h.makeService();
    const saved = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "ghp_environment_fallback_must_not_be_used";
    try {
      await assert.rejects(service.asGitHubTokenProvider(ALICE)({ reason: "initial" }), (error: unknown) => {
        assert.ok(error instanceof GitHubLinkError);
        assert.equal(error.code, "github_connection_required");
        return true;
      });
      await linkAs(h, service, ALICE, GH_ALICE);
      await assert.rejects(service.asGitHubTokenProvider(ALICE, GH_BOB.id)({ reason: "initial" }), {
        code: "github_identity_changed",
      });
    } finally {
      if (saved === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = saved;
    }
  });

  it("throws when the refresh token is past its own expiry", async () => {
    const service = h.makeService();
    await linkAs(h, service, ALICE, GH_ALICE);
    h.clock.advanceSeconds(200 * 24 * HOURS);
    await assert.rejects(service.asGitHubTokenProvider(ALICE)({ reason: "refresh" }), {
      code: "github_reauthentication_required",
    });
    assert.equal(h.gh.refreshCalls, 0);
  });
});

describe("rotating refresh tokens", () => {
  beforeEach(async () => {
    h = await startHarness();
  });

  it("(h) ten concurrent callers across two service instances cause exactly one GitHub refresh", async () => {
    const a = h.makeService();
    const b = h.makeService();
    await linkAs(h, a, ALICE, GH_ALICE);
    h.clock.advanceSeconds(7.5 * HOURS);
    h.gh.refreshDelayMs = 150;

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? a : b).tokenFor(ALICE, { reason: "refresh" })),
    );
    assert.equal(h.gh.refreshCalls, 1);
    assert.equal(results.filter((r) => r.refreshed).length, 1);
    const tokens = new Set(results.map((r) => r.accessToken));
    assert.equal(tokens.size, 1);
    for (const r of results) {
      assert.ok(h.gh.accessTokens.has(r.accessToken), "every caller got a token GitHub considers valid");
      assert.equal(r.credentialVersion, 2);
      assert.ok(r.expiresInSeconds > 7 * HOURS);
    }
    const row = await h.store.get(principalKeyOf(ALICE));
    assert.equal(row?.record.refreshLease, undefined);
  });

  it("(h) six independent service instances (no in-process coalescing) still refresh once", async () => {
    const first = h.makeService();
    await linkAs(h, first, ALICE, GH_ALICE);
    h.clock.advanceSeconds(7.5 * HOURS);
    h.gh.refreshDelayMs = 120;
    const services: GitHubLinkService[] = Array.from({ length: 6 }, () => h.makeService());
    const results = await Promise.all(services.map((s) => s.tokenFor(ALICE, { reason: "refresh" })));
    assert.equal(h.gh.refreshCalls, 1);
    assert.equal(new Set(results.map((r) => r.accessToken)).size, 1);
    assert.equal(results.filter((r) => r.refreshed).length, 1);
  });

  it("(i) the refreshed pair is persisted before tokenFor resolves", async () => {
    const store = new InstrumentedStore();
    await h.stop();
    h = await startHarness({ store });
    const service = h.makeService();
    await linkAs(h, service, ALICE, GH_ALICE);
    h.clock.advanceSeconds(7.5 * HOURS);

    let release!: () => void;
    store.gate = new Promise<void>((resolve) => (release = resolve));
    let settled = false;
    const pending = service.tokenFor(ALICE, { reason: "refresh" }).then((r) => {
      settled = true;
      store.events.push("resolved");
      return r;
    });
    for (let i = 0; i < 100 && !store.events.includes("persist-begin"); i++) await sleep(10);
    assert.ok(store.events.includes("persist-begin"), "persist was attempted");
    assert.equal(h.gh.refreshCalls, 1, "GitHub already answered");
    await sleep(60);
    assert.equal(settled, false, "tokenFor must not resolve before the new pair is stored");
    assert.equal((await store.inner.get(principalKeyOf(ALICE)))?.record.credentialVersion, 1);

    release();
    const result = await pending;
    assert.deepEqual(store.events, ["persist-begin", "persist-done", "resolved"]);
    const stored = await store.inner.get(principalKeyOf(ALICE));
    assert.equal(stored?.record.credentialVersion, 2);
    const sealer = new TokenSealer(h.cipher);
    assert.ok(stored);
    assert.equal(sealer.open(credentialBinding(principalKeyOf(ALICE), stored.record), "access", stored.record.accessTokenEnc), result.accessToken);
  });

  it("(i) known residual risk: a crash between GitHub's answer and the store write loses the rotated pair", async () => {
    const store = new InstrumentedStore();
    await h.stop();
    h = await startHarness({ store });
    const service = h.makeService();
    await linkAs(h, service, ALICE, GH_ALICE);
    h.clock.advanceSeconds(7.5 * HOURS);

    store.failPersist = true;
    await assert.rejects(service.tokenFor(ALICE, { reason: "refresh" }), { code: "github_token_refresh_conflict" });
    assert.equal(h.gh.refreshCalls, 1);
    store.failPersist = false;

    // GitHub rotated the refresh token, so the stored (old) one is dead: the user must relink.
    h.clock.advanceSeconds(31); // let the orphaned lease expire
    await assert.rejects(service.tokenFor(ALICE, { reason: "refresh" }), { code: "github_reauthentication_required" });
  });

  it("(j) a revoked refresh token persists reauthentication-required without changing credentials", async () => {
    const service = h.makeService();
    await linkAs(h, service, ALICE, GH_ALICE);
    const before = (await h.store.get(principalKeyOf(ALICE)))?.record;
    h.gh.revokeAllRefreshTokens();
    h.clock.advanceSeconds(7.5 * HOURS);

    await assert.rejects(service.tokenFor(ALICE, { reason: "refresh" }), (error: unknown) => {
      assert.ok(error instanceof GitHubLinkError);
      assert.equal(error.code, "github_reauthentication_required");
      return true;
    });
    assert.equal(h.gh.refreshCalls, 1);
    const after = (await h.store.get(principalKeyOf(ALICE)))?.record;
    assert.equal(after?.state, "reauth-required");
    assert.equal(after?.accessTokenEnc, before?.accessTokenEnc);
    assert.equal(after?.refreshTokenEnc, before?.refreshTokenEnc);
    await assert.rejects(h.makeService().tokenFor(ALICE, { reason: "refresh" }), { code: "github_reauthentication_required" });
    assert.equal(h.gh.refreshCalls, 1);
    assert.equal((await service.status(ALICE)).linked, true, "the link is not deleted");
  });

  it("an unknown GitHub failure persists reauthentication-required and cannot replay rotation", async () => {
    const service = h.makeService();
    await linkAs(h, service, ALICE, GH_ALICE);
    const before = (await h.store.get(principalKeyOf(ALICE)))?.record;
    h.clock.advanceSeconds(7.5 * HOURS);
    h.gh.refreshMode = "server_error";
    await assert.rejects(service.tokenFor(ALICE, { reason: "refresh" }), { code: "github_reauthentication_required" });
    assert.equal((await h.store.get(principalKeyOf(ALICE)))?.record.state, "reauth-required");
    assert.equal((await h.store.get(principalKeyOf(ALICE)))?.record.refreshTokenEnc, before?.refreshTokenEnc);

    h.gh.refreshMode = "ok";
    await assert.rejects(h.makeService().tokenFor(ALICE, { reason: "refresh" }), { code: "github_reauthentication_required" });
    assert.equal(h.gh.refreshCalls, 1);
  });

  it("an orphaned lease blocks callers until expiry, then requires reauthentication without replay", async () => {
    const service = h.makeService({ leaseWaitMs: 60 });
    await linkAs(h, service, ALICE, GH_ALICE);
    h.clock.advanceSeconds(7.5 * HOURS);
    const stored = await h.store.get(principalKeyOf(ALICE));
    assert.ok(stored);
    const lease = { id: "crashed-holder", expiresAt: new Date(h.clock.now() + 30_000).toISOString() };
    assert.ok((await h.store.putIfMatch({ ...stored.record, refreshLease: lease }, stored.etag)).ok);

    await assert.rejects(service.tokenFor(ALICE, { reason: "refresh" }), { code: "github_token_refresh_conflict" });
    assert.equal(h.gh.refreshCalls, 0);

    h.clock.advanceSeconds(31);
    await assert.rejects(service.tokenFor(ALICE, { reason: "refresh" }), { code: "github_reauthentication_required" });
    assert.equal(h.gh.refreshCalls, 0);
    assert.equal((await h.store.get(principalKeyOf(ALICE)))?.record.state, "reauth-required");
  });

  it("unlinking while a refresh is in flight does not resurrect the row", async () => {
    const service = h.makeService();
    await linkAs(h, service, ALICE, GH_ALICE);
    h.clock.advanceSeconds(7.5 * HOURS);
    h.gh.refreshDelayMs = 100;
    const pending = service.tokenFor(ALICE, { reason: "refresh" });
    pending.catch(() => undefined);
    await sleep(30);
    await service.unlink(ALICE);
    await assert.rejects(pending, { code: "github_connection_required" });
    assert.equal((await h.store.get(principalKeyOf(ALICE)))?.record.state, "unlinked");
    assert.equal((await h.store.get(principalKeyOf(ALICE)))?.record.accessTokenEnc, "");
  });

  it("reports github_connection_required before linking and github_identity_changed on a mismatch", async () => {
    const service = h.makeService();
    await assert.rejects(service.tokenFor(ALICE, { reason: "initial" }), { code: "github_connection_required" });
    await linkAs(h, service, ALICE, GH_ALICE);
    await assert.rejects(service.tokenFor(ALICE, { reason: "initial", expectedGithubUserId: 42 }), {
      code: "github_identity_changed",
    });
    const ok = await service.tokenFor(ALICE, { reason: "initial", expectedGithubUserId: GH_ALICE.id });
    assert.equal(ok.githubUserId, GH_ALICE.id);
    assert.equal(ok.refreshed, false);
  });
});
