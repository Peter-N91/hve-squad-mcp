import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { JwtClaims, JwtVerifier } from "../../src/auth/entra.js";
import { EntraBrowserSignIn, newPkce } from "../../src/github-link/entra-sign-in.js";
import { GitHubOAuthClient } from "../../src/github-link/github-oauth-client.js";
import { consentPage } from "../../src/github-link/pages.js";
import { GitHubLinkError, GitHubOAuthError } from "../../src/github-link/types.js";
import { ALICE, CLIENT_ID, CLIENT_SECRET, GH_ALICE, PUBLIC_BASE, FakeGitHub, startHarness, type Harness } from "./harness.js";

describe("GitHubOAuthClient", () => {
  let gh: FakeGitHub;
  let client: GitHubOAuthClient;

  beforeEach(async () => {
    gh = new FakeGitHub();
    await gh.start();
    client = new GitHubOAuthClient({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, webBaseUrl: gh.url, apiBaseUrl: gh.url });
  });
  afterEach(async () => {
    await gh.stop();
  });

  it("defaults to github.com and api.github.com and builds the documented authorize URL", () => {
    const real = new GitHubOAuthClient({ clientId: "abc", clientSecret: "s", scopes: ["offline_access"] });
    const url = new URL(real.buildAuthorizeUrl("state123", "https://mcp.test/github/link/callback", { codeChallenge: "chal" }));
    assert.equal(url.origin + url.pathname, "https://github.com/login/oauth/authorize");
    assert.equal(url.searchParams.get("client_id"), "abc");
    assert.equal(url.searchParams.get("redirect_uri"), "https://mcp.test/github/link/callback");
    assert.equal(url.searchParams.get("state"), "state123");
    assert.equal(url.searchParams.get("scope"), "offline_access");
    assert.equal(url.searchParams.get("code_challenge"), "chal");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("allow_signup"), "false");
    assert.ok(!url.searchParams.has("client_secret"));
  });

  it("exchanges a code with PKCE, then getUser returns the numeric id", async () => {
    const pkce = newPkce();
    const redirect = `${PUBLIC_BASE}/github/link/callback`;
    const callback = new URL(gh.authorize(client.buildAuthorizeUrl("s", redirect, { codeChallenge: pkce.codeChallenge }), GH_ALICE));
    const tokens = await client.exchangeCode(callback.searchParams.get("code") as string, redirect, { codeVerifier: pkce.codeVerifier });
    assert.equal(tokens.tokenKind, "ghu");
    assert.equal(tokens.expiresInSeconds, 28800);
    assert.equal(tokens.refreshExpiresInSeconds, 15897600);
    assert.ok(tokens.refreshToken?.startsWith("ghr_"));
    assert.deepEqual(await client.getUser(tokens.accessToken), GH_ALICE);
  });

  it("accepts enterprise-managed usernames with underscores and preserves the numeric identity", async () => {
    const managedUser = { id: 987654321, login: "managed_user_shortcode" };
    const issued = gh.issueFor(managedUser) as { access_token: string };
    assert.deepEqual(await client.getUser(issued.access_token), managedUser);
  });

  it("renders managed usernames unchanged while escaping untrusted account labels", () => {
    const page = consentPage("/github/link/confirm", { state: "synthetic-state", csrf: "synthetic-csrf" }, true, {},
      { from: "managed_user_shortcode", to: '<script>alert("synthetic")</script>&' });
    const html = String(page.body);
    assert.match(html, /managed_user_shortcode/);
    assert.ok(html.includes("&lt;script&gt;alert(&quot;synthetic&quot;)&lt;/script&gt;&amp;"));
    assert.ok(!html.includes("<script>"));
  });

  it("keeps the origin on both consent form posts without sending cross-origin referrers", () => {
    for (const action of ["/github/link/start", "/github/link/confirm"]) {
      const response = consentPage(action, { csrf: "synthetic-csrf" }, action.endsWith("/confirm"));
      assert.equal(response.headers["referrer-policy"], "same-origin");
      assert.equal(response.headers["cache-control"], "no-store");
      assert.match(response.headers["content-security-policy"], /form-action 'self'/);
    }
  });

  it("allows only the configured authorization origin for a consent form redirect", () => {
    const response = consentPage("/github/link/start", { csrf: "synthetic-csrf" }, false, {}, undefined,
      "https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize?scope=openid");
    assert.equal(response.headers["content-security-policy"],
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://login.microsoftonline.com");
    assert.ok(!response.headers["content-security-policy"].includes("*"));
    const confirm = consentPage("/github/link/confirm", { csrf: "synthetic-csrf" }, true);
    assert.equal(confirm.headers["content-security-policy"],
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  });

  it("treats HTTP 200 with an error body as a failure, mapping the kinds without echoing text", async () => {
    await assert.rejects(client.exchangeCode("bogus", "https://x"), (error: unknown) => {
      assert.ok(error instanceof GitHubOAuthError);
      assert.equal(error.kind, "invalid_grant");
      assert.equal(error.githubError, "bad_verification_code");
      assert.ok(!error.message.includes("bogus"), "error_description echo must not leak");
      return true;
    });
    const wrongSecret = new GitHubOAuthClient({ clientId: CLIENT_ID, clientSecret: "nope", webBaseUrl: gh.url, apiBaseUrl: gh.url });
    await assert.rejects(wrongSecret.exchangeCode("c", "https://x"), { kind: "configuration" });
  });

  it("(refresh) rotates the pair and kills the old refresh token", async () => {
    const first = gh.issueFor(GH_ALICE) as { access_token: string; refresh_token: string };
    const rotated = await client.refresh(first.refresh_token);
    assert.notEqual(rotated.refreshToken, first.refresh_token);
    assert.notEqual(rotated.accessToken, first.access_token);
    assert.equal(rotated.expiresInSeconds, 28800);
    await assert.rejects(client.refresh(first.refresh_token), (error: unknown) => {
      assert.ok(error instanceof GitHubOAuthError);
      assert.equal(error.kind, "invalid_grant");
      assert.ok(!error.message.includes(first.refresh_token));
      return true;
    });
  });

  it("maps 5xx, network failure, unparseable bodies and 401 on /user sensibly", async () => {
    gh.refreshMode = "server_error";
    await assert.rejects(client.refresh("ghr_x"), { kind: "transient" });
    const dead = new GitHubOAuthClient({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, webBaseUrl: "http://127.0.0.1:1", apiBaseUrl: "http://127.0.0.1:1", timeoutMs: 500 });
    await assert.rejects(dead.refresh("ghr_x"), { kind: "transient" });
    const html = new GitHubOAuthClient({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      fetchImpl: async () => new Response("<html>oops</html>", { status: 200 }),
    });
    await assert.rejects(html.refresh("ghr_x"), { kind: "transient" });
    await assert.rejects(client.getUser("ghu_unknown"), { kind: "invalid_grant" });
  });

  it("sends form-encoded POSTs with Accept: application/json and never puts secrets in the URL", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const stub = new GitHubOAuthClient({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      fetchImpl: async (input, init) => {
        seen.push({ url: String(input), init: init as RequestInit });
        return new Response(JSON.stringify({ access_token: "gho_abc", token_type: "bearer", scope: "" }), { status: 200 });
      },
    });
    const tokens = await stub.exchangeCode("the-code", "https://mcp.test/cb", { codeVerifier: "ver" });
    assert.equal(tokens.tokenKind, "gho");
    assert.equal(tokens.expiresInSeconds, undefined);
    assert.equal(tokens.refreshToken, undefined);
    assert.equal(seen[0].url, "https://github.com/login/oauth/access_token");
    const headers = seen[0].init.headers as Record<string, string>;
    assert.equal(headers.accept, "application/json");
    assert.equal(headers["content-type"], "application/x-www-form-urlencoded");
    const form = new URLSearchParams(String(seen[0].init.body));
    assert.equal(form.get("code"), "the-code");
    assert.equal(form.get("code_verifier"), "ver");
    assert.equal(form.get("redirect_uri"), "https://mcp.test/cb");
    assert.ok(!seen[0].url.includes("the-code"));
  });

  it("revoke calls DELETE /applications/{client_id}/token with basic auth", async () => {
    await client.revoke("ghu_to_revoke");
    assert.deepEqual(gh.revoked, ["ghu_to_revoke"]);
  });
});

describe("EntraBrowserSignIn", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await h.stop();
  });

  function build(overrides: Partial<ConstructorParameters<typeof EntraBrowserSignIn>[0]> = {}): EntraBrowserSignIn {
    return new EntraBrowserSignIn({
      authorizeEndpoint: h.entra.authorizeEndpoint,
      tokenEndpoint: h.entra.tokenEndpoint,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      verifier: h.entra.verifier(),
      ...overrides,
    });
  }

  async function signIn(client: EntraBrowserSignIn, identity = { tenantId: ALICE.tenantId, oid: ALICE.objectId }) {
    const pkce = newPkce();
    const redirectUri = `${PUBLIC_BASE}/github/link/entra-callback`;
    const authorize = client.buildAuthorizeUrl({ state: "st", nonce: "nonce-1", codeChallenge: pkce.codeChallenge, redirectUri });
    const code = new URL(h.entra.signIn(authorize, identity)).searchParams.get("code") as string;
    return { code, pkce, redirectUri, authorize };
  }

  it("builds a code + PKCE URL that forces re-authentication", async () => {
    const { authorize } = await signIn(build());
    const url = new URL(authorize);
    assert.equal(url.searchParams.get("response_type"), "code");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("prompt"), "login");
    assert.equal(url.searchParams.get("scope"), "openid profile");
    assert.equal(url.searchParams.get("nonce"), "nonce-1");
    assert.ok(!url.searchParams.has("client_secret"));
  });

  it("returns {tenantId, oid} from the verified id_token and ignores the pairwise sub", async () => {
    const client = build();
    const { code, pkce, redirectUri } = await signIn(client);
    const principal = await client.completeSignIn({ code, codeVerifier: pkce.codeVerifier, nonce: "nonce-1", redirectUri });
    assert.deepEqual(principal, { tenantId: ALICE.tenantId, objectId: ALICE.objectId });
  });

  it("refuses an openid-only sign-in when Entra omits the profile-scoped oid", async () => {
    const client = build({ scope: "openid" });
    const { code, pkce, redirectUri } = await signIn(client);
    await assert.rejects(client.completeSignIn({
      code, codeVerifier: pkce.codeVerifier, nonce: "nonce-1", redirectUri,
    }), /missing tid or oid/);
  });

  it("rejects a nonce mismatch, a wrong PKCE verifier and a reused code", async () => {
    const client = build();
    const a = await signIn(client);
    await assert.rejects(client.completeSignIn({ code: a.code, codeVerifier: a.pkce.codeVerifier, nonce: "other", redirectUri: a.redirectUri }), GitHubLinkError);
    const b = await signIn(client);
    await assert.rejects(client.completeSignIn({ code: b.code, codeVerifier: newPkce().codeVerifier, nonce: "nonce-1", redirectUri: b.redirectUri }), GitHubLinkError);
    await assert.rejects(client.completeSignIn({ code: a.code, codeVerifier: a.pkce.codeVerifier, nonce: "nonce-1", redirectUri: a.redirectUri }), GitHubLinkError);
  });

  it("rejects wrong audience, missing tid/oid, disallowed tenant and issuer mismatch", async () => {
    const real = h.entra.verifier();
    const tamper = (mutate: (claims: JwtClaims) => void): JwtVerifier => ({
      verify: async (token) => {
        const claims = { ...(await real.verify(token)) };
        mutate(claims);
        return claims;
      },
    });
    const cases: [string, EntraBrowserSignIn][] = [
      ["aud", build({ verifier: tamper((c) => void (c.aud = "someone-else")) })],
      ["aud-array", build({ verifier: tamper((c) => void (c.aud = [CLIENT_ID, "x"])) })],
      ["no-oid", build({ verifier: tamper((c) => void delete c.oid) })],
      ["no-tid", build({ verifier: tamper((c) => void delete c.tid) })],
      ["tenant", build({ allowedTenantIds: ["99999999-9999-4999-8999-999999999999"] })],
      ["issuer", build({ issuerForTenant: () => "https://evil.example/v2.0" })],
      ["verifier-throws", build({ verifier: { verify: async () => { throw new Error("bad signature"); } } })],
    ];
    for (const [label, client] of cases) {
      const flow = await signIn(client);
      await assert.rejects(
        client.completeSignIn({ code: flow.code, codeVerifier: flow.pkce.codeVerifier, nonce: "nonce-1", redirectUri: flow.redirectUri }),
        (error: unknown) => error instanceof GitHubLinkError && error.code === "github_link_state_invalid",
        label,
      );
    }
  });

  it("supports a pluggable client assertion instead of a secret", async () => {
    let calls = 0;
    const client = build({
      clientSecret: undefined,
      clientAssertion: async () => {
        calls++;
        return "federated-assertion";
      },
    });
    const flow = await signIn(client);
    const principal = await client.completeSignIn({ code: flow.code, codeVerifier: flow.pkce.codeVerifier, nonce: "nonce-1", redirectUri: flow.redirectUri });
    assert.equal(principal.objectId, ALICE.objectId);
    assert.equal(calls, 1);
  });

  it("requires exactly one client credential", () => {
    assert.throws(() => build({ clientSecret: undefined }), /exactly one/);
    assert.throws(() => build({ clientAssertion: async () => "x" }), /exactly one/);
  });

  it("fails closed when the token endpoint rejects the client", async () => {
    const client = build({ clientSecret: "wrong" });
    const flow = await signIn(client);
    await assert.rejects(client.completeSignIn({ code: flow.code, codeVerifier: flow.pkce.codeVerifier, nonce: "nonce-1", redirectUri: flow.redirectUri }), GitHubLinkError);
  });
});
