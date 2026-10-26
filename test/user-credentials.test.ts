import assert from "node:assert/strict";
import { test } from "node:test";

import type { UserPrincipal } from "../src/auth/entra.js";
import { CopilotRuntimeUnavailableError } from "../src/engine/copilot/copilot-credentials.js";
import {
  PerUserCopilotCredentials,
  type UserTokenGrant,
  type UserTokenResolver,
} from "../src/engine/copilot/user-credentials.js";

const ALICE: UserPrincipal = { tenantId: "t1", objectId: "oid-alice" };
const BOB: UserPrincipal = { tenantId: "t1", objectId: "oid-bob" };

class LinkError extends Error {
  constructor(readonly code: string) { super(code); }
}

class FakeTokens implements UserTokenResolver {
  readonly calls: Array<{ who: string; reason: string; expected?: number }> = [];
  readonly grants = new Map<string, UserTokenGrant>();
  async tokenFor(principal: UserPrincipal, options: { reason: "initial" | "refresh"; expectedGithubUserId?: number; expectedLinkGeneration?: string }) {
    this.calls.push({ who: principal.objectId, reason: options.reason, expected: options.expectedGithubUserId });
    const grant = this.grants.get(principal.objectId);
    if (!grant) throw new LinkError("github_connection_required");
    if (options.expectedGithubUserId !== undefined && options.expectedGithubUserId !== grant.githubUserId) {
      throw new LinkError("github_identity_changed");
    }
    if (options.expectedLinkGeneration && options.expectedLinkGeneration !== grant.linkGeneration) {
      throw new LinkError("github_identity_changed");
    }
    return grant;
  }
}

function setup(models: string[] = ["gpt-5"]) {
  const tokens = new FakeTokens();
  tokens.grants.set("oid-alice", { accessToken: "ghu_alice_token_0000000000", expiresInSeconds: 28_000, githubUserId: 111, credentialVersion: 1 });
  tokens.grants.set("oid-bob", { accessToken: "ghu_bob_token_00000000000", expiresInSeconds: 28_000, githubUserId: 222, credentialVersion: 1 });
  const verified: string[] = [];
  let behavior: (token: string) => Promise<{ models: string[]; premiumRemainingPercent?: number }> =
    async () => ({ models, premiumRemainingPercent: 80 });
  let now = 1_000_000;
  const creds = new PerUserCopilotCredentials({
    tokens,
    verifier: { verify: async (token) => { verified.push(token); return behavior(token); } },
    now: () => now,
  });
  return { tokens, creds, verified, setBehavior: (b: typeof behavior) => { behavior = b; }, advance: (ms: number) => { now += ms; } };
}

test("two users resolve to their own GitHub tokens and are verified separately", async () => {
  const { creds, verified } = setup();
  const alice = await creds.verifyFor(ALICE);
  const bob = await creds.verifyFor(BOB);
  assert.equal(alice.ready, true);
  assert.equal(alice.githubUserId, 111);
  assert.equal(bob.githubUserId, 222);
  assert.deepEqual(verified, ["ghu_alice_token_0000000000", "ghu_bob_token_00000000000"]);

  const aliceToken = await creds.tokenProviderFor(ALICE)({ reason: "initial" });
  const bobToken = await creds.tokenProviderFor(BOB)({ reason: "initial" });
  assert.equal(aliceToken.kind === "token" && aliceToken.accessToken, "ghu_alice_token_0000000000");
  assert.equal(bobToken.kind === "token" && bobToken.accessToken, "ghu_bob_token_00000000000");
});

test("an unlinked user is not ready, never reaches the verifier and never borrows another user's token", async () => {
  const { creds, verified } = setup();
  const carol = await creds.verifyFor({ tenantId: "t1", objectId: "oid-carol" });
  assert.equal(carol.ready, false);
  assert.equal(carol.code, "github_connection_required");
  assert.equal(carol.cause, "credential");
  assert.equal(verified.length, 0);
  await assert.rejects(creds.tokenProviderFor({ tenantId: "t1", objectId: "oid-carol" })({ reason: "initial" }),
    (error: unknown) => (error as { code?: string }).code === "github_connection_required");
});

test("a pinned GitHub user id that no longer matches fails closed with github_identity_changed", async () => {
  const { creds, tokens } = setup();
  tokens.grants.set("oid-alice", { accessToken: "ghu_other_account_00000000", expiresInSeconds: 28_000, githubUserId: 999, credentialVersion: 2 });
  const status = await creds.verifyFor(ALICE, { githubUserId: 111 });
  assert.equal(status.ready, false);
  assert.equal(status.code, "github_identity_changed");
  await assert.rejects(creds.tokenProviderFor(ALICE, { githubUserId: 111 })({ reason: "refresh" }),
    (error: unknown) => (error as { code?: string }).code === "github_identity_changed");
});

test("a verified credential version is cached and a new version is re-verified", async () => {
  const { creds, tokens, verified, advance } = setup();
  await creds.verifyFor(ALICE);
  await creds.verifyFor(ALICE);
  assert.equal(verified.length, 1);
  assert.equal(creds.cachedStatus(ALICE)?.ready, true);

  tokens.grants.set("oid-alice", { accessToken: "ghu_alice_rotated_000000", expiresInSeconds: 28_000, githubUserId: 111, credentialVersion: 2 });
  await creds.verifyFor(ALICE);
  assert.equal(verified.length, 2);

  advance(6 * 60_000);
  assert.equal(creds.cachedStatus(ALICE), undefined);
});

test("concurrent checks for one user share a single entitlement call", async () => {
  const { creds, verified, setBehavior } = setup();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  setBehavior(async () => { await gate; return { models: ["gpt-5"] }; });
  const all = Promise.all([creds.verifyFor(ALICE), creds.verifyFor(ALICE), creds.verifyFor(ALICE)]);
  release();
  const results = await all;
  assert.equal(verified.length, 1);
  assert.ok(results.every((result) => result.ready));
});

test("entitlement failures are classified and a runtime outage is not cached or blamed on the user", async () => {
  const { creds, setBehavior, verified } = setup();

  setBehavior(async () => ({ models: [] }));
  assert.equal((await creds.verifyFor(ALICE)).code, "copilot_entitlement_missing");

  setBehavior(async () => { throw new Error("GitHub responded 403 Forbidden"); });
  assert.equal((await creds.verifyFor(BOB)).code, "copilot_entitlement_missing");

  // Exact error captured from the real runtime for a revoked or invalid token.
  setBehavior(async () => {
    throw new Error('Request models.list failed with message: Failed to fetch Copilot user info: 401 Unauthorized: {"message":"Bad credentials"}');
  });
  const revoked = await creds.verifyFor(ALICE);
  assert.equal(revoked.code, "github_reauthentication_required");
  assert.equal(revoked.cause, "credential");

  // The shape a fresh runtime returns for the same revoked token, captured live.
  setBehavior(async () => {
    throw new Error('Request models.list failed with message: GenericFailure, {"kind":"http","status":401,"statusText":"Unauthorized","body":"unauthorized: token authentication failed\\n"}');
  });
  assert.equal((await creds.verifyFor(ALICE)).code, "github_reauthentication_required");

  setBehavior(async () => { throw new Error("socket hang up"); });
  const unknown = await creds.verifyFor(ALICE);
  assert.equal(unknown.code, "copilot_verification_failed");

  setBehavior(async () => { throw new CopilotRuntimeUnavailableError("sandbox down"); });
  const down = await creds.verifyFor(ALICE);
  assert.equal(down.code, "copilot_runtime_unavailable");
  assert.equal(down.cause, "runtime");

  setBehavior(async () => ({ models: ["gpt-5"] }));
  assert.equal((await creds.verifyFor(ALICE)).ready, true);
  assert.ok(verified.length >= 5);
});

test("the provider refuses to report a lifetime the runtime would reject", async () => {
  const { creds, tokens } = setup();
  // Captured from the real runtime: a credential with 1800 seconds left fails session creation.
  tokens.grants.set("oid-alice", { accessToken: "ghu_alice_nearly_expired_00", expiresInSeconds: 1800, githubUserId: 111, credentialVersion: 3 });
  await assert.rejects(creds.tokenProviderFor(ALICE)({ reason: "initial" }),
    (error: unknown) => (error as { code?: string }).code === "github_reauthentication_required");
  tokens.grants.set("oid-alice", { accessToken: "ghu_alice_fresh_0000000000", expiresInSeconds: 3601, githubUserId: 111, credentialVersion: 4 });
  const ok = await creds.tokenProviderFor(ALICE)({ reason: "initial" });
  assert.equal(ok.kind === "token" && ok.expiresIn, 3601);
});

test("status messages never contain token material", async () => {
  const { creds, setBehavior } = setup();
  setBehavior(async (token) => { throw new Error(`rejected ${token}`); });
  const status = await creds.verifyFor(ALICE);
  assert.doesNotMatch(JSON.stringify(status), /ghu_/);
});

test("session token providers preserve the expected GitHub host boundary", async () => {
  const { creds, tokens } = setup();
  const provider = creds.tokenProviderFor(ALICE, { githubUserId: 111 });
  await assert.rejects(provider({ host: "https://attacker.invalid", sessionId: "session", reason: "initial" }), /not permitted/);
  assert.equal(tokens.calls.length, 0, "a foreign host is rejected before acquiring a credential");
  await assert.rejects(provider({ host: "https://github.com/foreign", reason: "initial" }), /not permitted/);
  assert.equal((await provider({ host: "https://github.com", sessionId: "session", reason: "initial" })).kind, "token");
});

test("a same-account relink cannot revive a run pinned to a disconnected generation", async () => {
  const { creds, tokens } = setup();
  const grant = tokens.grants.get(ALICE.objectId)!;
  tokens.grants.set(ALICE.objectId, { ...grant, linkGeneration: "generation-a" });
  const pin = { githubUserId: 111, linkGeneration: "generation-a" };
  assert.equal((await creds.verifyFor(ALICE, pin)).linkGeneration, "generation-a");
  const provider = creds.tokenProviderFor(ALICE, pin);
  await provider({ reason: "initial" });
  tokens.grants.set(ALICE.objectId, { ...grant, credentialVersion: 2, linkGeneration: "generation-b" });
  assert.equal((await creds.verifyFor(ALICE, pin)).code, "github_identity_changed");
  await assert.rejects(provider({ reason: "refresh" }),
    (error: unknown) => (error as { code?: string }).code === "github_identity_changed");
});

test("a production-configured GitHub host must be supplied by the SDK callback", async () => {
  const { tokens } = setup();
  const creds = new PerUserCopilotCredentials({
    tokens, githubHost: "github.com", verifier: { verify: async () => ({ models: ["synthetic"] }) },
  });
  await assert.rejects(creds.tokenProviderFor(ALICE)({ reason: "initial" }), /omitted its effective host/);
  assert.equal(tokens.calls.length, 0);
  assert.equal((await creds.tokenProviderFor(ALICE)({ reason: "initial", host: "https://github.com" })).kind, "token");
});
