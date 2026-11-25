import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { principalKeyOf } from "../../src/auth/entra.js";
import { RedactingLogger } from "../../src/observability/logger.js";
import { GitHubLinkError } from "../../src/github-link/types.js";
import {
  ALICE,
  BOB,
  Browser,
  GH_ALICE,
  GH_BOB,
  PUBLIC_BASE,
  asIdentity,
  linkAs,
  runLinkFlow,
  startHarness,
  type Harness,
} from "./harness.js";

let h: Harness;

beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.stop();
});

function assertNoStore(response: { headers: Record<string, string> }): void {
  assert.match(response.headers["cache-control"], /no-store/);
}

describe("link flow happy path", () => {
  it("links a user end to end and serves a no-store success page", async () => {
    const service = h.makeService();
    const result = await linkAs(h, service, ALICE, GH_ALICE);
    assert.equal(result.final.status, 200);
    assertNoStore(result.final);
    assert.match(String(result.final.body), /GitHub account linked/);

    const status = await service.status(ALICE);
    assert.deepEqual(
      { linked: status.linked, id: status.githubUserId, login: status.githubLogin, kind: status.tokenKind },
      { linked: true, id: GH_ALICE.id, login: GH_ALICE.login, kind: "ghu" },
    );
    assert.ok(status.accessExpiresAt);
    assert.equal((await service.status(BOB)).linked, false);
    assert.equal(h.gh.exchangeCalls, 1);
  });

  it("uses the oid, never the pairwise sub, as the principal", async () => {
    const service = h.makeService();
    const { startUrl } = await service.begin(ALICE);
    const flow = await runLinkFlow(h, service, startUrl, asIdentity(ALICE), GH_ALICE);
    assert.equal(flow.final.status, 200);
    const stored = await h.store.get(principalKeyOf(ALICE));
    assert.equal(stored?.record.oid, ALICE.objectId);
    assert.ok(!JSON.stringify(stored).includes("pairwise-"));
  });

  it("ignores requests outside its routes and rejects non-GET", async () => {
    const service = h.makeService();
    assert.equal(await service.handleHttp({ method: "GET", path: "/mcp", headers: {} }), undefined);
    assert.equal(await service.handleHttp({ method: "GET", path: "/github/link/status", headers: {} }), undefined);
    const post = await service.handleHttp({ method: "POST", path: "/github/link/start", headers: {} });
    assert.equal(post?.status, 400);
  });

  it("unlink deletes the row and revokes best effort", async () => {
    const service = h.makeService();
    await linkAs(h, service, ALICE, GH_ALICE);
    const before = await service.tokenFor(ALICE, { reason: "initial" });
    assert.equal(await service.unlink(ALICE), true);
    assert.deepEqual(h.gh.revoked, [before.accessToken]);
    assert.equal((await service.status(ALICE)).linked, false);
    await assert.rejects(service.tokenFor(ALICE, { reason: "initial" }), { code: "github_connection_required" });
    assert.equal(await service.unlink(ALICE), false);
  });

  it("unlink still deletes when revocation fails", async () => {
    const service = h.makeService({
      revoke: async () => {
        throw new Error("network down");
      },
    });
    await linkAs(h, service, ALICE, GH_ALICE);
    await assert.rejects(service.unlink(ALICE), /disconnected locally/);
    assert.equal((await service.status(ALICE)).linked, false);
  });
});

describe("security properties", () => {
  it("(a) rejects a replayed nonce", async () => {
    const service = h.makeService();
    const { startUrl } = await service.begin(ALICE);
    const first = await new Browser(service).start(startUrl);
    assert.equal(first.status, 302);
    const replay = await new Browser(service).start(startUrl);
    assert.equal(replay.status, 400);
    assert.match(String(replay.body), /invalid, expired or already used/);
  });

  it("(b) rejects an expired nonce", async () => {
    const service = h.makeService();
    const { startUrl } = await service.begin(ALICE);
    h.clock.advanceSeconds(10 * 60 + 1);
    const response = await new Browser(service).start(startUrl);
    assert.equal(response.status, 400);
    assert.equal(response.headers.location, undefined);
  });

  it("rejects unknown, malformed and missing nonces without reflecting them", async () => {
    const service = h.makeService();
    const probe = "<script>alert(1)</script>";
    for (const query of ["", "nonce=", `nonce=${encodeURIComponent(probe)}`]) {
      const response = await service.handleHttp({ method: "GET", path: "/github/link/start", query, headers: {} });
      assert.equal(response?.status, 400);
      assert.ok(!String(response?.body).includes("script"));
      assert.ok(!String(response?.body).includes("AAAA"));
    }
  });

  it("(c) attack A: a link issued to the attacker, opened by the victim, is rejected and stores nothing", async () => {
    const service = h.makeService();
    const { startUrl } = await service.begin(BOB); // BOB is the attacker
    const victimBrowser = new Browser(service);
    const result = await runLinkFlow(h, service, startUrl, asIdentity(ALICE), GH_ALICE, victimBrowser);
    assert.equal(result.final.status, 403);
    assert.equal(result.githubCallback, undefined, "must never be redirected to GitHub");
    assert.match(String(result.final.body), /different user/);
    assert.equal((await service.status(ALICE)).linked, false);
    assert.equal((await service.status(BOB)).linked, false);
    assert.equal(h.gh.exchangeCalls, 0);
  });

  it("(d) attack B: a leaked victim link completed by the attacker's own identity is rejected", async () => {
    const service = h.makeService();
    const { startUrl } = await service.begin(ALICE); // victim's link, leaked
    const result = await runLinkFlow(h, service, startUrl, asIdentity(BOB), GH_BOB, new Browser(service));
    assert.equal(result.final.status, 403);
    assert.equal((await service.status(ALICE)).linked, false);
    assert.equal(await h.store.get(principalKeyOf(BOB)), undefined);
    assert.equal(h.gh.exchangeCalls, 0);
  });

  it("(d2) a leaked Entra callback URL replayed from another browser is rejected (browser binding)", async () => {
    const service = h.makeService();
    const { startUrl } = await service.begin(ALICE);
    const victim = new Browser(service);
    const start = await victim.start(startUrl);
    const callbackUrl = h.entra.signIn(start.headers.location, asIdentity(ALICE));
    const attacker = new Browser(service);
    const stolen = await attacker.get(callbackUrl);
    assert.equal(stolen.status, 400);
    assert.equal(stolen.headers.location, undefined);
    // The state was consumed by the failed attempt, so the victim cannot reuse it either.
    assert.equal((await victim.get(callbackUrl)).status, 400);
  });

  it("(e) rejects a tampered GitHub state", async () => {
    const service = h.makeService();
    const { startUrl } = await service.begin(ALICE);
    const browser = new Browser(service);
    const start = await browser.start(startUrl);
    const entraCallback = await browser.get(h.entra.signIn(start.headers.location, asIdentity(ALICE)));
    const callbackUrl = new URL(h.gh.authorize(entraCallback.headers.location, GH_ALICE));
    const state = callbackUrl.searchParams.get("state") as string;
    callbackUrl.searchParams.set("state", `${state.slice(0, -1)}${state.endsWith("A") ? "B" : "A"}`);
    const response = await browser.get(callbackUrl.toString());
    assert.equal(response.status, 400);
    assert.equal((await service.status(ALICE)).linked, false);
    assert.equal(h.gh.exchangeCalls, 0);
  });

  it("(e) rejects a replayed GitHub state, and a state or nonce used in the wrong leg", async () => {
    const service = h.makeService();
    const { startUrl } = await service.begin(ALICE);
    const nonce = new URL(startUrl).searchParams.get("nonce") as string;
    const browser = new Browser(service);
    const start = await browser.start(startUrl);
    const entraState = new URL(start.headers.location).searchParams.get("state") as string;
    const entraCallback = await browser.get(h.entra.signIn(start.headers.location, asIdentity(ALICE)));
    const githubUrl = h.gh.authorize(entraCallback.headers.location, GH_ALICE);
    assert.equal((await browser.get(githubUrl)).status, 200);
    assert.equal((await browser.get(githubUrl)).status, 400, "replay");
    assert.equal(h.gh.exchangeCalls, 1);

    const cross = (state: string) => `${PUBLIC_BASE}/github/link/callback?code=x&state=${state}`;
    assert.equal((await browser.get(cross(entraState))).status, 400);
    assert.equal((await browser.get(cross(nonce))).status, 400);
  });

  it("(e) a GitHub error redirect or missing code stores nothing", async () => {
    const service = h.makeService();
    const { startUrl } = await service.begin(ALICE);
    const browser = new Browser(service);
    const start = await browser.start(startUrl);
    const entraCallback = await browser.get(h.entra.signIn(start.headers.location, asIdentity(ALICE)));
    const state = new URL(entraCallback.headers.location).searchParams.get("state");
    const response = await browser.get(`${PUBLIC_BASE}/github/link/callback?error=access_denied&state=${state}`);
    assert.equal(response.status, 400);
    assert.equal((await service.status(ALICE)).linked, false);
    assert.equal((await h.store.get(principalKeyOf(ALICE)))?.record.accessTokenEnc, "");
  });

  it("(f) no token, code or id_token ever appears in a response, redirect, log line or error message", async () => {
    const logger = new RedactingLogger({ sink: (line) => h.logs.push(line), level: "debug" });
    const service = h.makeService({ logger });
    const flow = await linkAs(h, service, ALICE, GH_ALICE);
    assert.equal(flow.final.status, 200);

    const problems: string[] = [];
    const tokenResult = await service.tokenFor(ALICE, { reason: "initial" });
    // Force a refresh against a revoked refresh token: GitHub echoes the secret in error_description.
    h.gh.revokeAllRefreshTokens();
    h.clock.advanceSeconds(7.5 * 3600);
    try {
      await service.tokenFor(ALICE, { reason: "refresh" });
      assert.fail("expected reauthentication");
    } catch (error) {
      assert.ok(error instanceof GitHubLinkError);
      problems.push(error.message, String(error.stack));
    }
    // A wrong-principal attempt and a replay also produce responses.
    const attacker = await runLinkFlow(h, service, (await service.begin(BOB)).startUrl, asIdentity(ALICE), GH_ALICE);
    const everything = [
      ...flow.browser.responses,
      ...attacker.browser.responses,
    ].map((r) => JSON.stringify({ status: r.status, headers: r.headers, body: r.body }));
    everything.push(...h.logs, ...problems);

    const secrets = [...h.gh.secrets, ...h.entra.secrets, tokenResult.accessToken];
    assert.ok(secrets.length >= 6);
    for (const secret of secrets) {
      for (const text of everything) {
        assert.ok(!text.includes(secret), `a secret leaked: ${secret.slice(0, 8)}...`);
      }
    }
    assert.ok(h.logs.length > 0, "the service should have logged something");
  });

  it("(g) a stored row copied to another principal fails closed", async () => {
    const service = h.makeService();
    await linkAs(h, service, ALICE, GH_ALICE);
    const alice = await h.store.get(principalKeyOf(ALICE));
    assert.ok(alice);

    // Re-key the whole row for BOB (oid edited) with ALICE's ciphertext.
    await h.store.putIfMatch({ ...alice.record, oid: BOB.objectId }, undefined);
    await assert.rejects(service.tokenFor(BOB, { reason: "initial" }), (error: unknown) => {
      assert.ok(error instanceof GitHubLinkError);
      assert.equal(error.code, "github_link_principal_mismatch");
      return true;
    });
  });

  it("(g) rejects a refresh ciphertext planted in the access slot, plaintext and tampered ciphertext", async () => {
    const service = h.makeService();
    await linkAs(h, service, ALICE, GH_ALICE);
    const stored = await h.store.get(principalKeyOf(ALICE));
    assert.ok(stored?.record.refreshTokenEnc);

    const put = async (patch: Record<string, string>) => {
      const latest = await h.store.get(principalKeyOf(ALICE));
      assert.ok(latest);
      const result = await h.store.putIfMatch({ ...latest.record, ...patch }, latest.etag);
      assert.ok(result.ok);
    };
    await put({ accessTokenEnc: stored.record.refreshTokenEnc });
    await assert.rejects(service.tokenFor(ALICE, { reason: "initial" }), { code: "github_link_state_invalid" });
    await put({ accessTokenEnc: "ghu_plaintext_planted_token_value" });
    await assert.rejects(service.tokenFor(ALICE, { reason: "initial" }), { code: "github_link_state_invalid" });
    await put({ accessTokenEnc: `${stored.record.accessTokenEnc.slice(0, -4)}AAAA` });
    await assert.rejects(service.tokenFor(ALICE, { reason: "initial" }), { code: "github_link_state_invalid" });
  });

  it("(k) a different GitHub account requires browser confirmation, not model allowRebind", async () => {
    const service = h.makeService();
    await linkAs(h, service, ALICE, GH_ALICE);
    const before = await h.store.get(principalKeyOf(ALICE));

    const attempt = await linkAs(h, service, ALICE, GH_BOB);
    assert.equal(attempt.final.status, 200);
    assert.match(String(attempt.final.body), /Confirm GitHub account switch/);
    assert.deepEqual(await h.store.get(principalKeyOf(ALICE)), before, "row untouched");
    assert.equal(h.gh.revoked.length, 0, "pending confirmation is not saved");

    const begin = await service.begin(ALICE);
    assert.equal(begin.alreadyLinked, true);
    assert.equal(begin.linkedGithubLogin, GH_ALICE.login);
    assert.equal(begin.lastLinkError, undefined);

    await assert.rejects(service.tokenFor(ALICE, { reason: "initial", expectedGithubUserId: GH_BOB.id }), {
      code: "github_identity_changed",
    });
  });

  it("(k) allowRebind replaces the link and revokes the old GitHub token", async () => {
    const service = h.makeService();
    await linkAs(h, service, ALICE, GH_ALICE);
    const old = await service.tokenFor(ALICE, { reason: "initial" });

    const rebound = await linkAs(h, service, ALICE, GH_BOB, { allowRebind: true });
    assert.equal(rebound.final.status, 200);
    const status = await service.status(ALICE);
    assert.equal(status.githubUserId, GH_BOB.id);
    assert.equal(status.lastLinkError, undefined);
    const next = await service.tokenFor(ALICE, { reason: "initial", expectedGithubUserId: GH_BOB.id });
    assert.equal(next.credentialVersion, old.credentialVersion + 1);
    assert.deepEqual(h.gh.revoked, [old.accessToken]);
  });

  it("relinking the same GitHub account keeps linkedAt and bumps credentialVersion", async () => {
    const service = h.makeService();
    await linkAs(h, service, ALICE, GH_ALICE);
    const first = await h.store.get(principalKeyOf(ALICE));
    h.clock.advanceSeconds(3600);
    await linkAs(h, service, ALICE, GH_ALICE);
    const second = await h.store.get(principalKeyOf(ALICE));
    assert.equal(second?.record.linkedAt, first?.record.linkedAt);
    assert.equal(second?.record.credentialVersion, 2);
  });

  it("serves every page with no-store and a locked-down CSP", async () => {
    const service = h.makeService();
    const ok = await linkAs(h, service, ALICE, GH_ALICE);
    const bad = await new Browser(service).get(`${PUBLIC_BASE}/github/link/start?nonce=nope`);
    for (const response of [...ok.browser.responses, bad]) {
      assertNoStore(response);
      const consent = String(response.body).includes('<form method="post"');
      assert.equal(response.headers["referrer-policy"], consent ? "same-origin" : "no-referrer");
      assert.match(response.headers["content-security-policy"], /default-src 'none'/);
    }
    assert.match(ok.start.headers["set-cookie"], /HttpOnly/);
    assert.match(ok.start.headers["set-cookie"], /Secure/);
    assert.match(ok.start.headers["set-cookie"], /SameSite=Lax/);
    const landing = ok.browser.responses.find(response => String(response.body).includes('<form method="post"'));
    assert.ok(landing);
    assert.equal(landing.headers["content-security-policy"],
      `default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' ${new URL(h.entra.authorizeEndpoint).origin}`);
  });

  it("an Entra id_token with the wrong nonce or audience cannot complete the flow", async () => {
    const service = h.makeService();
    h.entra.claimsHook = (claims) => {
      claims.nonce = "attacker-chosen-nonce";
    };
    const wrongNonce = await linkAs(h, service, ALICE, GH_ALICE);
    assert.equal(wrongNonce.final.status, 400);
    h.entra.claimsHook = (claims) => {
      delete claims.oid;
    };
    const noOid = await linkAs(h, service, ALICE, GH_ALICE);
    assert.equal(noOid.final.status, 400);
    assert.equal((await service.status(ALICE)).linked, false);
  });
});
