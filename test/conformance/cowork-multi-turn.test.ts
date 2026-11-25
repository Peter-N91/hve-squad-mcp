import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_UNTRUSTED_SECTION_CHARS } from "../../src/engine/embedded-prompt.js";
import {
  buildHarness,
  callTool,
  initializeSession,
  resultText,
} from "./support/harness.js";
import { FakeJwtVerifier } from "./support/fake-auth.js";

test("Cowork rejects oversized context before dispatch and accepts a corrected same-session request", async () => {
  const verifier = new FakeJwtVerifier();
  const harness = buildHarness({ verifier });
  verifier.register({
    token: "cowork-multi-turn",
    tenantId: "cowork-tenant",
    subject: "cowork-user",
    scopes: ["Squad.Research", "Squad.Architect"],
  });
  const sessionId = await initializeSession(harness.handler, "cowork-multi-turn");

  const research = await callTool(harness.handler, {
    token: "cowork-multi-turn",
    sessionId,
    name: "squad_research",
    args: { request: "Research the current platform constraints." },
    id: 2,
  });
  assert.equal(research.status, 200);
  assert.doesNotMatch(resultText(research), /internal error/i);

  const context =
    "RESEARCH-BEGIN\n" +
    "x".repeat(MAX_UNTRUSTED_SECTION_CHARS + 20_000) +
    "\nRESEARCH-END";
  const architect = await callTool(harness.handler, {
    token: "cowork-multi-turn",
    sessionId,
    name: "squad_architect",
    args: {
      request: "Recommend the target architecture.",
      context,
    },
    id: 3,
  });

  assert.equal(architect.status, 200);
  assert.doesNotMatch(resultText(architect), /internal error/i);
  assert.equal(harness.backend.callCount, 1);
  assert.match(JSON.stringify(architect.body), /"providerAttempted":false/);
  assert.match(JSON.stringify(architect.body), /"providerCode":"local_context_preflight_rejected"/);

  const prefix = "RESEARCH-BEGIN\n";
  const suffix = "\nRESEARCH-END";
  const correctedContext = prefix
    + "x".repeat(MAX_UNTRUSTED_SECTION_CHARS - prefix.length - suffix.length)
    + suffix;
  const corrected = await callTool(harness.handler, {
    token: "cowork-multi-turn",
    sessionId,
    name: "squad_architect",
    args: {
      request: "Recommend the target architecture.",
      context: correctedContext,
    },
    id: 4,
  });
  assert.equal(corrected.status, 200);
  assert.doesNotMatch(resultText(corrected), /internal error/i);
  assert.equal(harness.backend.callCount, 2);
  const laterTurn = harness.backend.calls[1].messages[0].content;
  assert.ok(laterTurn.includes(correctedContext));
  assert.doesNotMatch(laterTurn, /middle omitted by the server/);
  assert.equal(harness.sessions.size, 1);
});
