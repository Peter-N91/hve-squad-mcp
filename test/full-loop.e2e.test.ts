/**
 * The whole loop with no injected tokens: refusal, connect tool, browser sign-in,
 * GitHub authorization through the handler's own /github/link routes, then a run
 * that executes with the token the link service stored. Only the leaf systems are
 * fakes (GitHub, Entra sign-in, Entra token signature, Copilot entitlement).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DurableRunStateStore } from "../src/engine/durable-run-state.js";
import { perUserRunPreflight, perUserStageExecutor } from "../src/engine/copilot/per-user-executor.js";
import { PerUserCopilotCredentials } from "../src/engine/copilot/user-credentials.js";
import type { GitHubLinkService } from "../src/github-link/index.js";
import { UserIdentityGate, type GitHubLinkFacade } from "../src/transports/user-identity-gate.js";
import type { HttpResponseLike } from "../src/transports/http-core.js";
import { buildHarness, callTool, initializeSession } from "./conformance/support/harness.js";
import { FakeJwtVerifier } from "./conformance/support/fake-auth.js";
import { scriptedStageExecutor } from "./helpers/scripted-stage-executor.js";
import {
  ALICE, BOB, Browser, GH_ALICE, GH_BOB, asIdentity, runLinkFlow, startHarness,
} from "./github-link/harness.js";

const EXECUTION_TOOLS = new Set(["squad_plan", "squad_run", "squad_research", "squad_architect", "squad_review"]);

const text = (res: HttpResponseLike): string =>
  ((res.body as { result?: { content?: { text: string }[] } }).result?.content ?? []).map((c) => c.text).join("\n");

test("full loop: unlinked refusal, connect link, browser sign-in and GitHub consent, run as the linked user", async () => {
  const gh = await startHarness();
  const dir = mkdtempSync(join(tmpdir(), "squad-full-loop-"));
  try {
    const service: GitHubLinkService = gh.makeService({ now: () => Date.now() });
    const store = new DurableRunStateStore({ baseDir: dir });
    const verified: string[] = [];
    const credentials = new PerUserCopilotCredentials({
      tokens: service,
      verifier: { verify: async (token) => { verified.push(token); return { models: ["gpt-5"] }; } },
    });
    const link: GitHubLinkFacade = {
      begin: async (principal) => {
        const begun = await service.begin(principal);
        return { url: begun.startUrl, expiresAt: begun.expiresAt };
      },
      status: (principal) => service.status(principal),
      unlink: async (principal) => { await service.unlink(principal); },
    };
    const used: Array<{ runId: string; token: string }> = [];
    const verifier = new FakeJwtVerifier();
    verifier.register({ token: "alice", tenantId: ALICE.tenantId, subject: ALICE.objectId, scopes: ["Squad.Run", "Squad.Plan"] });
    verifier.register({ token: "bob", tenantId: BOB.tenantId, subject: BOB.objectId, scopes: ["Squad.Run", "Squad.Plan"] });
    const harness = buildHarness({
      verifier,
      runStateStore: store,
      userIdentity: new UserIdentityGate({ link, credentials, executionTools: EXECUTION_TOOLS }),
      linkRoutes: (req) => service.handleHttp(req),
      runPreflight: perUserRunPreflight(credentials),
      stageExecutorFactory: (_w, _p, runId) => perUserStageExecutor({
        runs: store, credentials, runId,
        build: ({ tokenProvider }) => ({
          execute: async (...args) => {
            const granted = await tokenProvider({ reason: "initial" });
            used.push({ runId, token: granted.kind === "token" ? granted.accessToken : "" });
            return scriptedStageExecutor(harness.backend).execute(...args);
          },
        }),
      }),
    });
    // A browser whose requests go through the HTTP handler, as in production.
    const viaHandler = { handleHttp: (req: Parameters<typeof service.handleHttp>[0]) => harness.handler.handle(req) };

    const aliceSession = await initializeSession(harness.handler, "alice");
    const bobSession = await initializeSession(harness.handler, "bob");

    // 1. Refused, nothing started.
    const refused = await callTool(harness.handler, { token: "alice", sessionId: aliceSession, name: "squad_plan", args: { request: "plan it" } });
    assert.match(text(refused), /^github_connection_required:/);
    assert.equal(harness.backend.callCount, 0);

    // 2. Connect tool returns a link bound to Alice.
    const connect = await callTool(harness.handler, { token: "alice", sessionId: aliceSession, name: "squad_github_connect", args: {} });
    const startUrl = text(connect).match(/https:\/\/mcp\.test\/github\/link\/start\?nonce=\S+/)?.[0];
    assert.ok(startUrl, "the connect tool returned a start link");
    assert.doesNotMatch(text(connect), /gh[uor]_/);

    // 3. Bob opens Alice's link and signs in as himself: refused, nothing linked for anyone.
    const attack = await runLinkFlow(gh, service, startUrl, asIdentity(BOB), GH_BOB, new Browser(viaHandler));
    assert.notEqual(attack.final.status, 200);
    assert.equal((await service.status(ALICE)).linked, false);
    assert.equal((await service.status(BOB)).linked, false);

    // 4. Alice completes her own flow through the handler's routes.
    const fresh = text(await callTool(harness.handler, { token: "alice", sessionId: aliceSession, name: "squad_github_connect", args: {} }))
      .match(/https:\/\/mcp\.test\/github\/link\/start\?nonce=\S+/)![0];
    const flow = await runLinkFlow(gh, service, fresh, asIdentity(ALICE), GH_ALICE, new Browser(viaHandler));
    assert.equal(flow.final.status, 200);
    const status = await callTool(harness.handler, { token: "alice", sessionId: aliceSession, name: "squad_github_status", args: {} });
    assert.match(text(status), /Connected as GitHub user alice-gh/);

    // 5. Her run executes with the token the link service stored, pinned to her GitHub id.
    const ran = await callTool(harness.handler, { token: "alice", sessionId: aliceSession, name: "squad_plan", args: { request: "plan it" } });
    assert.doesNotMatch(text(ran), /^[a-z_]+:/);
    const stored = await service.tokenFor(ALICE, { reason: "initial" });
    assert.ok(used.length > 0);
    assert.ok(used.every((entry) => entry.token === stored.accessToken));
    const run = await store.get(used[0].runId);
    assert.equal(run?.owner?.objectId, ALICE.objectId);
    assert.equal(run?.owner?.githubUserId, GH_ALICE.id);

    // 6. Bob is still unlinked and cannot borrow Alice's identity.
    const bobTry = await callTool(harness.handler, { token: "bob", sessionId: bobSession, name: "squad_plan", args: { request: "plan it" } });
    assert.match(text(bobTry), /^github_connection_required:/);
    assert.equal(used.length, 1);

    // 7. Disconnect removes access; the next run is refused again.
    await callTool(harness.handler, { token: "alice", sessionId: aliceSession, name: "squad_github_disconnect", args: {} });
    const after = await callTool(harness.handler, { token: "alice", sessionId: aliceSession, name: "squad_plan", args: { request: "plan it" } });
    assert.match(text(after), /^github_connection_required:/);

    // 8. No credential in any response or log line produced along the way.
    const everything = JSON.stringify([refused.body, connect.body, status.body, ran.body, bobTry.body, after.body, harness.lines]);
    assert.doesNotMatch(everything, /gh[uor]_[A-Za-z0-9]{8,}/);
    assert.ok(verified.length >= 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await gh.stop();
  }
});
