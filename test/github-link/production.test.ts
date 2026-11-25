import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, it } from "node:test";

import { principalKeyOf } from "../../src/auth/entra.js";
import { PrincipalVault } from "../../src/auth/principal-vault.js";
import { NullFieldCipher } from "../../src/engine/field-cipher.js";
import { GitHubOAuthClient } from "../../src/github-link/github-oauth-client.js";
import { GitHubLinkService } from "../../src/github-link/service.js";
import { TokenSealer } from "../../src/github-link/token-seal.js";
import { newPkce } from "../../src/github-link/entra-sign-in.js";
import { GitHubLinkError, GitHubUnlinkPartialError, type GitHubLinkStore } from "../../src/github-link/types.js";
import { ALICE, BOB, Browser, CLIENT_ID, CLIENT_SECRET, GH_ALICE, GH_BOB, PUBLIC_BASE, asIdentity, linkAs, runLinkFlow, startHarness, type Harness } from "./harness.js";

let h: Harness;
beforeEach(async () => { h = await startHarness(); });
afterEach(async () => { await h.stop(); });

describe("production browser consent", () => {
  it("GET previews never consume the nonce or start sign-in; human POST is single-use", async () => {
    const service = h.makeService();
    const { startUrl } = await service.begin(ALICE);
    for (let i = 0; i < 3; i++) {
      const preview = await new Browser(service).get(startUrl);
      assert.equal(preview.status, 200);
      assert.equal(preview.headers.location, undefined);
      assert.match(String(preview.body), /Continue to sign in/);
    }
    const browser = new Browser(service);
    const landing = await browser.get(startUrl);
    const first = await browser.submit(landing);
    assert.equal(first.status, 302);
    // Restore the original CSRF cookie to test nonce replay, not cookie failure.
    const csrf = /name="csrf" value="([^"]+)"/.exec(String(landing.body))![1];
    browser.jar.set("ghlink_bind", csrf);
    assert.equal((await browser.submit(landing)).status, 400);
    assert.equal(h.gh.exchangeCalls, 0);
  });

  it("rejects cross-origin or missing CSRF POST without burning the nonce", async () => {
    const service = h.makeService();
    const { startUrl } = await service.begin(ALICE);
    const browser = new Browser(service);
    const page = await browser.get(startUrl);
    const nonce = new URL(startUrl).searchParams.get("nonce")!;
    const csrf = browser.jar.get("ghlink_bind")!;
    for (const headers of [
      { origin: "https://attacker.example", cookie: `ghlink_bind=${csrf}` },
      { origin: PUBLIC_BASE, cookie: "" },
    ]) {
      const response = await service.handleHttp({ method: "POST", path: "/github/link/start",
        body: new URLSearchParams({ nonce, csrf }).toString(),
        headers: { ...headers, "content-type": "application/x-www-form-urlencoded" } });
      assert.equal(response?.status, 400);
    }
    // Failed requests clear their own browser cookie, not this browser's jar.
    assert.equal((await browser.submit(page)).status, 302);
  });

  it("allowRebind from a model cannot bypass explicit browser switch confirmation", async () => {
    const service = h.makeService();
    await linkAs(h, service, ALICE, GH_ALICE);
    const original = await service.tokenFor(ALICE, { reason: "initial" });
    const begin = await service.begin(ALICE, { allowRebind: true });
    const flow = await runLinkFlow(h, service, begin.startUrl, asIdentity(ALICE), GH_BOB);
    assert.match(String(flow.final.body), /Confirm GitHub account switch/);
    assert.equal((await service.status(ALICE)).githubUserId, GH_ALICE.id);
    const csrf = flow.browser.jar.get("ghlink_bind")!;
    const state = /name="state" value="([^"]+)"/.exec(String(flow.final.body))![1];
    assert.equal((await service.handleHttp({ method: "POST", path: "/github/link/confirm",
      body: new URLSearchParams({ state, csrf }).toString(),
      headers: { origin: "https://attacker.example", cookie: `ghlink_bind=${csrf}`, "content-type": "application/x-www-form-urlencoded" } }))?.status, 400);
    const confirmed = await flow.browser.submit(flow.final);
    assert.equal(confirmed.status, 200);
    assert.equal((await service.status(ALICE)).githubUserId, GH_BOB.id);
    assert.equal(h.gh.revoked.includes(original.accessToken), true);
    flow.browser.jar.set("ghlink_bind", csrf);
    assert.equal((await flow.browser.submit(flow.final)).status, 400);
  });

  it("an unlinked principal's old callback and old link URL cannot resurrect a link on another replica", async () => {
    const service = h.makeService();
    const other = h.makeService({ flowStore: undefined });
    await linkAs(h, service, ALICE, GH_ALICE);
    const pending = await service.begin(ALICE);
    const browser = new Browser(service);
    const start = await browser.start(pending.startUrl);
    const entra = await browser.get(h.entra.signIn(start.headers.location, asIdentity(ALICE)));
    const callback = h.gh.authorize(entra.headers.location, GH_ALICE);
    await other.unlink(ALICE);
    assert.equal((await browser.get(callback)).status, 400);
    assert.equal((await service.status(ALICE)).linked, false);
    assert.equal((await h.store.get(principalKeyOf(ALICE)))?.record.state, "unlinked");
  });

  it("unlink before the first callback invalidates an initial link flow", async () => {
    const service = h.makeService();
    const pending = await service.begin(ALICE);
    await service.unlink(ALICE);
    const attempt = await runLinkFlow(h, service, pending.startUrl, asIdentity(ALICE), GH_ALICE);
    assert.equal(attempt.final.status, 400);
    assert.equal((await service.status(ALICE)).linked, false);
  });

  it("same-account relink changes generation, never revives a previously pinned provider", async () => {
    const service = h.makeService();
    await linkAs(h, service, ALICE, GH_ALICE);
    const initial = await service.tokenFor(ALICE, { reason: "initial" });
    const provider = service.asGitHubTokenProvider(ALICE, GH_ALICE.id);
    await provider({ reason: "initial", host: "github.com" });
    await service.unlink(ALICE);
    const other = h.makeService();
    await linkAs(h, other, ALICE, GH_ALICE);
    const relinked = await service.tokenFor(ALICE, { reason: "initial" });
    assert.notEqual(relinked.linkGeneration, initial.linkGeneration);
    await assert.rejects(provider({ reason: "refresh", host: "github.com" }), { code: "github_identity_changed" });
    await assert.rejects(other.tokenFor(ALICE, { reason: "initial", expectedLinkGeneration: initial.linkGeneration }), { code: "github_identity_changed" });
    assert.equal((await other.status(ALICE)).linkGeneration, relinked.linkGeneration);
  });

  it("host mismatch never releases a GitHub credential", async () => {
    const service = h.makeService();
    await linkAs(h, service, ALICE, GH_ALICE);
    const provider = service.asGitHubTokenProvider(ALICE);
    await assert.rejects(provider({ reason: "initial", host: "attacker.example" }), /host mismatch/);
    assert.equal((await provider({ reason: "initial", host: "github.com" })).kind, "token");
  });

  it("unlink immediately disables use while revocation is pending and provides a partial receipt on failure", async () => {
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const service = h.makeService({ revoke: async () => { await wait; throw new Error("synthetic-secret-value"); } });
    await linkAs(h, service, ALICE, GH_ALICE);
    const unlink = service.unlink(ALICE);
    const outcome = assert.rejects(unlink, (error: unknown) => {
      assert.ok(error instanceof GitHubUnlinkPartialError);
      assert.equal(error.localUnlinked, true);
      assert.equal(error.revocation, "failed");
      assert.ok(!error.message.includes("synthetic-secret-value"));
      return true;
    });
    await assert.rejects(service.tokenFor(ALICE, { reason: "initial" }), { code: "github_connection_required" });
    release();
    await outcome;
    assert.equal((await service.status(ALICE)).linked, false);
  });
});

describe("production credential envelopes", () => {
  for (const encryption of ["vault", "field-cipher"] as const) {
    it(`${encryption} authenticates GitHub ID and generation for access and refresh, including forged old-run metadata`, async () => {
      const cipher = encryption === "vault" ? new PrincipalVault("current", { current: randomBytes(32) }) : h.cipher;
      const service = h.makeService({ cipher });
      await linkAs(h, service, ALICE, GH_ALICE);
      const old = await service.tokenFor(ALICE, { reason: "initial" });
      const oldProvider = service.asGitHubTokenProvider(ALICE, old.githubUserId, old.linkGeneration);
      await oldProvider({ reason: "initial", host: "github.com" });
      await linkAs(h, service, ALICE, GH_BOB, { allowRebind: true });
      const key = principalKeyOf(ALICE);
      const linked = (await h.store.get(key))!.record;
      const patches = [
        { githubUserId: old.githubUserId },
        { linkGeneration: old.linkGeneration },
        { githubUserId: old.githubUserId, linkGeneration: old.linkGeneration },
      ];
      const isAuthenticationFailure = (error: unknown) => {
        assert.ok(error instanceof GitHubLinkError);
        assert.ok(["github_link_state_invalid", "github_link_principal_mismatch"].includes(error.code));
        return true;
      };
      for (const reason of ["initial", "refresh"] as const) {
        for (const patch of patches) {
          const latest = (await h.store.get(key))!;
          const forged = { ...linked, ...patch,
            accessExpiresAt: new Date(h.clock.now() + (reason === "refresh" ? 1800 : 28800) * 1000).toISOString() };
          assert.ok((await h.store.putIfMatch(forged, latest.etag)).ok);
          await assert.rejects(service.tokenFor(ALICE, { reason, expectedGithubUserId: forged.githubUserId,
            expectedLinkGeneration: forged.linkGeneration }), isAuthenticationFailure);
          if ("githubUserId" in patch && "linkGeneration" in patch && reason === "initial") {
            await assert.rejects(oldProvider({ reason: "refresh", host: "github.com" }), isAuthenticationFailure);
          }
          assert.equal(h.gh.refreshCalls, 0, "tampered immutable identity must never reach rotating refresh");
        }
      }
      const latest = (await h.store.get(key))!;
      assert.ok((await h.store.putIfMatch({ ...linked, credentialVersion: linked.credentialVersion + 5,
        refreshLease: { id: "synthetic-lease", expiresAt: new Date(h.clock.now() + 30_000).toISOString() },
        updatedAt: new Date(h.clock.now() + 1000).toISOString() }, latest.etag)).ok);
      const unchanged = await service.tokenFor(ALICE, { reason: "initial" });
      assert.equal(unchanged.githubUserId, GH_BOB.id);
      assert.equal(unchanged.linkGeneration, linked.linkGeneration);
      assert.equal(unchanged.credentialVersion, linked.credentialVersion + 5);
    });

    it(`${encryption} refuses principal-only historical envelopes and missing link-generation metadata`, async () => {
      const cipher = encryption === "vault" ? new PrincipalVault("current", { current: randomBytes(32) }) : h.cipher;
      const service = h.makeService({ cipher });
      await linkAs(h, service, ALICE, GH_ALICE);
      const key = principalKeyOf(ALICE);
      const linked = (await h.store.get(key))!;
      const unbound = new TokenSealer(cipher).seal(key, "access", "synthetic-historical-token");
      assert.ok((await h.store.putIfMatch({ ...linked.record, accessTokenEnc: unbound }, linked.etag)).ok);
      await assert.rejects(service.tokenFor(ALICE, { reason: "initial" }), GitHubLinkError);
      const latest = (await h.store.get(key))!;
      assert.ok((await h.store.putIfMatch({ ...linked.record, linkGeneration: undefined }, latest.etag)).ok);
      await assert.rejects(service.tokenFor(ALICE, { reason: "initial" }), { code: "github_link_state_invalid" });
    });
  }

  it("requires encryption and authenticates principal and field with real AAD, including read-old/write-current key rotation", async () => {
    assert.throws(() => h.makeService({ cipher: new NullFieldCipher() }), /encryption is required/);
    const oldKey = randomBytes(32);
    const newKey = randomBytes(32);
    const old = new TokenSealer(new PrincipalVault("old", { old: oldKey }));
    const rotating = new TokenSealer(new PrincipalVault("current", { old: oldKey, current: newKey }));
    const key = principalKeyOf(ALICE);
    const sealed = old.seal(key, "access", "synthetic-access-value");
    assert.equal(rotating.open(key, "access", sealed), "synthetic-access-value");
    assert.match(rotating.seal(key, "access", "synthetic-access-value"), /^v1\.current\./);
    for (const [principal, field, envelope] of [
      [principalKeyOf(BOB), "access", sealed], [key, "refresh", sealed], [key, "access", "synthetic-access-value"],
      [key, "access", `${sealed.slice(0, -5)}AAAAA`],
    ] as const) assert.throws(() => rotating.open(principal, field, envelope), { code: "github_link_state_invalid" });
    const service = h.makeService({ cipher: new PrincipalVault("current", { current: newKey }) });
    assert.equal((await linkAs(h, service, ALICE, GH_ALICE)).final.status, 200);
    assert.equal((await service.tokenFor(ALICE, { reason: "initial" })).githubUserId, GH_ALICE.id);
  });

  it("unknown outcomes after the provider rotated refresh tokens never get blindly retried", async () => {
    const oauth = new GitHubOAuthClient({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, webBaseUrl: h.gh.url, apiBaseUrl: h.gh.url });
    const service = h.makeService({ oauth: {
      buildAuthorizeUrl: oauth.buildAuthorizeUrl.bind(oauth), exchangeCode: oauth.exchangeCode.bind(oauth),
      getUser: oauth.getUser.bind(oauth), revoke: oauth.revoke.bind(oauth),
      refresh: async token => { await oauth.refresh(token); throw new Error("synthetic ambiguous transport failure"); },
    } });
    await linkAs(h, service, ALICE, GH_ALICE);
    h.clock.advanceSeconds(7.5 * 3600);
    await assert.rejects(service.tokenFor(ALICE, { reason: "refresh" }), { code: "github_reauthentication_required" });
    assert.equal((await h.store.get(principalKeyOf(ALICE)))?.record.state, "reauth-required");
    h.clock.advanceSeconds(120);
    await assert.rejects(h.makeService().tokenFor(ALICE, { reason: "refresh" }), { code: "github_reauthentication_required" });
    assert.equal(h.gh.refreshCalls, 1);
  });

  it("generation remains stable across refresh, and invalid runtime expiry cannot pass as non-expiring", async () => {
    const service = h.makeService();
    await linkAs(h, service, ALICE, GH_ALICE);
    const generation = (await service.status(ALICE)).linkGeneration;
    h.clock.advanceSeconds(7.5 * 3600);
    assert.equal((await service.tokenFor(ALICE, { reason: "refresh" })).linkGeneration, generation);
    const row = (await h.store.get(principalKeyOf(ALICE)))!;
    await h.store.putIfMatch({ ...row.record, accessExpiresAt: "malformed" }, row.etag);
    await assert.rejects(service.tokenFor(ALICE, { reason: "initial" }), { code: "github_reauthentication_required" });
  });

  it("fake GitHub really rejects a wrong PKCE verifier", async () => {
    const client = new GitHubOAuthClient({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, webBaseUrl: h.gh.url, apiBaseUrl: h.gh.url });
    const pkce = newPkce();
    const redirect = "https://mcp.test/github/link/callback";
    const callback = new URL(h.gh.authorize(client.buildAuthorizeUrl("test-state", redirect, { codeChallenge: pkce.codeChallenge }), GH_ALICE));
    await assert.rejects(client.exchangeCode(callback.searchParams.get("code")!, redirect, { codeVerifier: "wrong-verifier" }), { kind: "invalid_grant" });
  });

  it("does not include unrecognized upstream machine error values or invalid expiries in errors", async () => {
    const client = (body: unknown) => new GitHubOAuthClient({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET,
      fetchImpl: async () => new Response(JSON.stringify(body), { status: 200 }) });
    await assert.rejects(client({ error: "ghu_synthetic_secret" }).refresh("synthetic-refresh"), (error: Error) => {
      assert.ok(!error.message.includes("ghu_synthetic_secret"));
      return true;
    });
    for (const expires_in of [0, -10, "invalid", 0.5]) {
      await assert.rejects(client({ access_token: "synthetic-access", expires_in }).refresh("synthetic-refresh"), /invalid_expiry/);
    }
  });

  it("recognizes lost store-write receipts without revoking an already persisted credential or replaying refresh", async () => {
    let drop = true;
    const store: GitHubLinkStore = {
      get: key => h.store.get(key),
      delete: (key, etag) => h.store.delete(key, etag),
      putIfMatch: async (record, etag) => {
        const result = await h.store.putIfMatch(record, etag);
        if (drop && result.ok && !record.refreshLease && record.credentialVersion > 0) {
          drop = false;
          throw new Error("synthetic lost write receipt");
        }
        return result;
      },
    };
    const service = h.makeService({ store });
    assert.equal((await linkAs(h, service, ALICE, GH_ALICE)).final.status, 200);
    assert.equal(h.gh.revoked.length, 0);
    h.clock.advanceSeconds(7.5 * 3600);
    drop = true;
    const refreshed = await service.tokenFor(ALICE, { reason: "refresh" });
    assert.equal(h.gh.refreshCalls, 1);
    assert.ok(h.gh.accessTokens.has(refreshed.accessToken));
    assert.equal(h.gh.revoked.length, 0);
    drop = true;
    assert.equal(await service.unlink(ALICE), true);
    assert.deepEqual(h.gh.revoked, [refreshed.accessToken]);
    assert.equal((await service.status(ALICE)).linked, false);
  });
});

it("socket HTTP browser route completes both PKCE legs and the explicit POST through the real module", async () => {
  let service: GitHubLinkService;
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const url = new URL(req.url!, "http://localhost");
      const response = await service.handleHttp({ method: req.method!, path: url.pathname, query: url.search.slice(1),
        headers: Object.fromEntries(Object.entries(req.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join("; ") : value])),
        body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(response?.status ?? 404, response?.headers);
      res.end(response?.body === undefined ? "" : String(response.body));
    } catch { res.writeHead(500); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  service = h.makeService({ publicBaseUrl: base, secureCookies: false });
  let cookie = "";
  const visit = async (url: string, init: RequestInit = {}) => {
    const response = await fetch(url, { ...init, redirect: "manual", headers: { cookie, ...(init.headers as Record<string, string>) } });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    return response;
  };
  try {
    const { startUrl } = await service.begin(ALICE);
    const preview = await visit(startUrl);
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get("location"), null);
    const html = await preview.text();
    const fields = [...html.matchAll(/name="([^"]+)" value="([^"]*)"/g)];
    const started = await visit(`${base}/github/link/start`, { method: "POST",
      headers: { origin: base, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields.map(match => [match[1], match[2]])).toString() });
    assert.equal(started.status, 302);
    const entraUrl = started.headers.get("location")!;
    assert.equal(new URL(entraUrl).searchParams.get("code_challenge_method"), "S256");
    const entraCallback = await visit(h.entra.signIn(entraUrl, asIdentity(ALICE)));
    assert.equal(entraCallback.status, 302);
    const githubUrl = entraCallback.headers.get("location")!;
    assert.equal(new URL(githubUrl).searchParams.get("code_challenge_method"), "S256");
    const githubCallback = h.gh.authorize(githubUrl, GH_ALICE);
    const finished = await visit(githubCallback);
    assert.equal(finished.status, 200);
    assert.match(await finished.text(), /GitHub account linked/);
    assert.equal((await service.status(ALICE)).githubUserId, GH_ALICE.id);
    assert.equal((await visit(githubCallback)).status, 400);
    assert.equal(h.gh.exchangeCalls, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
