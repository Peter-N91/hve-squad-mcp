/**
 * Conformance — the business-user tools (`squad_business_plan`, `squad_backlog`).
 *
 * These are the surfaces a non-technical Copilot Studio / Teams user reaches, so
 * the claims that matter are: they are OFF by default, fail-closed on their own
 * least-privilege scopes, produce a SCHEMA-VALID backlog a native ADO/Jira
 * connector can loop, and fail cleanly (never half-parsed JSON) when the model
 * returns something unusable.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildHarness, callTool, initializeSession } from "./support/harness.js";
import { FakeJwtVerifier } from "./support/fake-auth.js";
import { MockModelBackend } from "./support/mock-backend.js";
import type { HttpResponseLike } from "../../src/transports/http-core.js";

const TENANT = "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BUSINESS_SCOPES = ["Squad.Business", "Squad.Backlog"];

const VALID_BACKLOG = JSON.stringify({
  summary: "Ship a self-service onboarding flow.",
  epics: [
    {
      title: "Self-service onboarding",
      description: "Let a customer onboard without a call.",
      acceptanceCriteria: ["A customer can complete onboarding unaided."],
      stories: [
        {
          title: "As a new customer, I want to create an account, so that I can start",
          description: "Account creation with email verification.",
          acceptanceCriteria: ["Given a valid email When I submit Then I receive a verification link"],
          estimate: "S",
          tasks: [{ title: "Design the form", description: "Wireframe the signup form." }],
        },
      ],
    },
  ],
});

function resultOf(res: HttpResponseLike): Record<string, unknown> | undefined {
  return (res.body as { result?: Record<string, unknown> } | undefined)?.result;
}

test("the business tools are hidden by default (the unchanged remote surface)", async () => {
  const verifier = new FakeJwtVerifier();
  verifier.register({ token: "biz", tenantId: TENANT, subject: "u", scopes: BUSINESS_SCOPES });
  const { handler, backend } = buildHarness({ verifier });
  const sessionId = await initializeSession(handler, "biz");

  const list = await handler.handle({
    method: "POST",
    path: "/mcp",
    headers: {
      origin: "https://copilotstudio.microsoft.com",
      authorization: "Bearer biz",
      "mcp-session-id": sessionId,
      "content-type": "application/json",
    },
    body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
  });
  const names = ((list.body as { result?: { tools?: { name: string }[] } }).result?.tools ?? []).map(
    (tool) => tool.name,
  );
  assert.ok(!names.includes("squad_backlog"));

  const res = await callTool(handler, {
    token: "biz",
    sessionId,
    name: "squad_backlog",
    args: { request: "build a backlog" },
  });
  assert.equal((res.body as { error?: { code?: number } }).error?.code, -32601);
  assert.equal(backend.callCount, 0, "an unavailable tool makes no model call");
});

test("SEC-2: squad_backlog is denied without Squad.Backlog, before any model call", async () => {
  const verifier = new FakeJwtVerifier();
  // Holds the sibling business scope only — proves the scopes are independent.
  verifier.register({ token: "plan-only", tenantId: TENANT, subject: "u", scopes: ["Squad.Business"] });
  const { handler, backend } = buildHarness({ verifier, businessToolsExposed: true });
  const sessionId = await initializeSession(handler, "plan-only");

  const res = await callTool(handler, {
    token: "plan-only",
    sessionId,
    name: "squad_backlog",
    args: { request: "build a backlog" },
  });
  assert.equal(res.status, 403);
  assert.equal((res.body as { error?: string }).error, "missing_scope");
  assert.equal(backend.callCount, 0);
});

test("squad_backlog returns a validated contract with flattened, parent-first work items", async () => {
  const verifier = new FakeJwtVerifier();
  verifier.register({ token: "biz", tenantId: TENANT, subject: "u", scopes: BUSINESS_SCOPES });
  const backend = new MockModelBackend({ reply: VALID_BACKLOG });
  const { handler } = buildHarness({ verifier, backend, businessToolsExposed: true });
  const sessionId = await initializeSession(handler, "biz");

  const res = await callTool(handler, {
    token: "biz",
    sessionId,
    name: "squad_backlog",
    args: { request: "turn the onboarding idea into a backlog" },
  });
  const result = resultOf(res) as
    | { summary?: string; epics?: unknown[]; workItems?: { ref: string; type: string; parentRef?: string }[] }
    | undefined;
  assert.ok(result, "a structured contract is returned");
  assert.match(result.summary ?? "", /onboarding/i);
  assert.equal(result.epics?.length, 1);

  const items = result.workItems ?? [];
  assert.deepEqual(
    items.map((item) => item.ref),
    ["E1", "E1-S1", "E1-S1-T1"],
    "stable refs, parents first, so the agent can link children by parentRef",
  );
  assert.deepEqual(
    items.map((item) => item.type),
    ["Epic", "User Story", "Task"],
  );
  assert.equal(items[1]?.parentRef, "E1");
  assert.equal(items[2]?.parentRef, "E1-S1");
});

test("squad_backlog tolerates a fenced JSON reply (the common model shape)", async () => {
  const verifier = new FakeJwtVerifier();
  verifier.register({ token: "biz", tenantId: TENANT, subject: "u", scopes: BUSINESS_SCOPES });
  const backend = new MockModelBackend({
    reply: "Here is the backlog:\n\n```json\n" + VALID_BACKLOG + "\n```\n",
  });
  const { handler } = buildHarness({ verifier, backend, businessToolsExposed: true });
  const sessionId = await initializeSession(handler, "biz");

  const res = await callTool(handler, {
    token: "biz",
    sessionId,
    name: "squad_backlog",
    args: { request: "turn the onboarding idea into a backlog" },
  });
  const result = resultOf(res) as { workItems?: unknown[] } | undefined;
  assert.equal(result?.workItems?.length, 3);
});

test("squad_backlog fails cleanly on unusable model output (never half-parsed JSON)", async () => {
  const verifier = new FakeJwtVerifier();
  verifier.register({ token: "biz", tenantId: TENANT, subject: "u", scopes: BUSINESS_SCOPES });
  const backend = new MockModelBackend({ reply: "I could not produce a backlog for that." });
  const { handler } = buildHarness({ verifier, backend, businessToolsExposed: true });
  const sessionId = await initializeSession(handler, "biz");

  const res = await callTool(handler, {
    token: "biz",
    sessionId,
    name: "squad_backlog",
    args: { request: "???" },
  });
  const result = resultOf(res) as { isError?: boolean; content?: { text?: string }[] } | undefined;
  assert.equal(result?.isError, true);
  assert.match(result?.content?.[0]?.text ?? "", /structured form/i);
});

test("squad_business_plan returns advisory text under its own scope", async () => {
  const verifier = new FakeJwtVerifier();
  verifier.register({ token: "biz", tenantId: TENANT, subject: "u", scopes: BUSINESS_SCOPES });
  const backend = new MockModelBackend({ reply: "## Summary\n\nA plan." });
  const { handler } = buildHarness({ verifier, backend, businessToolsExposed: true });
  const sessionId = await initializeSession(handler, "biz");

  const res = await callTool(handler, {
    token: "biz",
    sessionId,
    name: "squad_business_plan",
    args: { request: "a subscription box for office plants" },
  });
  const content = (resultOf(res) as { content?: { text?: string }[] } | undefined)?.content ?? [];
  assert.match(content.map((block) => block.text ?? "").join("\n"), /## Summary/);
});

test("an empty request is rejected before any model call", async () => {
  const verifier = new FakeJwtVerifier();
  verifier.register({ token: "biz", tenantId: TENANT, subject: "u", scopes: BUSINESS_SCOPES });
  const { handler, backend } = buildHarness({ verifier, businessToolsExposed: true });
  const sessionId = await initializeSession(handler, "biz");

  const res = await callTool(handler, {
    token: "biz",
    sessionId,
    name: "squad_business_plan",
    args: { request: "   " },
  });
  assert.equal((res.body as { error?: { code?: number } }).error?.code, -32602);
  assert.equal(backend.callCount, 0);
});
