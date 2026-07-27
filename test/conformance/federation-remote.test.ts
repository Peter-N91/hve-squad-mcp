/**
 * Conformance — `squad_federate` over the remote (Copilot Studio) boundary.
 *
 * Federation was previously unreachable over HTTP: no scope, not in the exposed
 * set, and no dispatch branch. This corpus pins the shipped behavior:
 *
 *   * SEC-2 — `squad_federate` is fail-closed on its own `Squad.Federate` scope
 *     (a fully-scoped-but-for-federate token is denied with NO model call).
 *   * PROD-1 — it is listed/callable ONLY when the operator enabled the gated
 *     pipeline, mirroring `squad_run`'s exposure rule.
 *   * SEC-6 / PROD-5 — it HOLDS at the Human Gate and makes no model call.
 *   * The federation inputs (`squad` / `init` / `promote`) survive the durable
 *     boundary, so an approved run executes as a FEDERATION turn rather than
 *     degrading into a plain pipeline run.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildHarness, callTool, initializeSession } from "./support/harness.js";
import { FakeJwtVerifier } from "./support/fake-auth.js";
import { EphemeralRunStateStore } from "../../src/engine/run-state.js";
import { decodeRunParams } from "../../src/engine/run-params.js";
import { federationDirective, federationInputs } from "../../src/engine/federation.js";
import type { HttpResponseLike } from "../../src/transports/http-core.js";

const TENANT = "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const ALL_SCOPES = [
  "Squad.Research",
  "Squad.Review",
  "Squad.Plan",
  "Squad.Architect",
  "Squad.Run",
  "Squad.Federate",
];

function textOf(res: HttpResponseLike): string {
  const result = (res.body as { result?: { content?: { text?: string }[] } } | undefined)?.result;
  return result?.content?.map((block) => block.text ?? "").join("\n") ?? "";
}

test("PROD-1: squad_federate is listed over HTTP when the pipeline is exposed", async () => {
  const verifier = new FakeJwtVerifier();
  verifier.register({ token: "all", tenantId: TENANT, subject: "u", scopes: ALL_SCOPES });
  const { handler } = buildHarness({ verifier });
  const sessionId = await initializeSession(handler, "all");

  const res = await handler.handle({
    method: "POST",
    path: "/mcp",
    headers: {
      origin: "https://copilotstudio.microsoft.com",
      authorization: `Bearer all`,
      "mcp-session-id": sessionId,
      "content-type": "application/json",
    },
    body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
  });
  const tools = (res.body as { result?: { tools?: { name: string }[] } }).result?.tools ?? [];
  assert.ok(tools.some((tool) => tool.name === "squad_federate"));
});

test("PROD-1: squad_federate is hidden and rejected in the advisory-only posture", async () => {
  const verifier = new FakeJwtVerifier();
  verifier.register({ token: "all", tenantId: TENANT, subject: "u", scopes: ALL_SCOPES });
  const { handler, backend } = buildHarness({ verifier, pipelineExposed: false });
  const sessionId = await initializeSession(handler, "all");

  const res = await callTool(handler, {
    token: "all",
    sessionId,
    name: "squad_federate",
    args: { request: "route this across the federation" },
  });
  const error = (res.body as { error?: { code?: number } } | undefined)?.error;
  assert.equal(error?.code, -32601, "an unexposed gated tool is not callable");
  assert.equal(backend.callCount, 0, "no model call for an unavailable tool");
});

test("SEC-2: squad_federate requires Squad.Federate (Squad.Run is not enough)", async () => {
  const verifier = new FakeJwtVerifier();
  verifier.register({
    token: "no-fed",
    tenantId: TENANT,
    subject: "u",
    scopes: ["Squad.Research", "Squad.Review", "Squad.Plan", "Squad.Architect", "Squad.Run"],
  });
  const { handler, backend } = buildHarness({ verifier });
  const sessionId = await initializeSession(handler, "no-fed");

  const res = await callTool(handler, {
    token: "no-fed",
    sessionId,
    name: "squad_federate",
    args: { request: "route this across the federation" },
  });
  assert.equal(res.status, 403);
  assert.equal((res.body as { error?: string }).error, "missing_scope");
  assert.equal(backend.callCount, 0, "denied before any model call");
});

test("SEC-6/PROD-5: squad_federate holds at the Human Gate and persists its federation inputs", async () => {
  const verifier = new FakeJwtVerifier();
  verifier.register({ token: "all", tenantId: TENANT, subject: "u", scopes: ALL_SCOPES });
  const runStateStore = new EphemeralRunStateStore();
  const { handler, backend } = buildHarness({ verifier, runStateStore });
  const sessionId = await initializeSession(handler, "all");

  const res = await callTool(handler, {
    token: "all",
    sessionId,
    name: "squad_federate",
    args: { request: "plan the product and azure workstreams", squad: "product", init: true },
  });
  assert.equal(backend.callCount, 0, "a held run makes no model call");
  const body = textOf(res);
  assert.match(body, /"outcome": "held"/, "the run is held at the Human Gate");
  const runId = /"runId": "([^"]+)"/.exec(body)?.[1];
  assert.ok(runId, "the caller receives a run id to poll");

  // The federation inputs must survive the durable boundary — the regression this
  // corpus exists to prevent (a resumed run would otherwise be a plain pipeline).
  const run = await runStateStore.get(runId);
  assert.ok(run, "the federation run was persisted");
  assert.equal(run.toolId, "squad_federate");
  const params = decodeRunParams(run.params);
  assert.equal(params.squad, "product");
  assert.equal(params.init, true);
});

test("the federation directive is composed only from validated inputs", () => {
  // A hostile sub-squad name must never reach the charter.
  const hostile = federationInputs({
    toolId: "squad_federate",
    request: "x",
    squad: "../../etc/passwd",
    init: false,
    promote: false,
  });
  assert.equal(hostile.squad, undefined);
  const directive = federationDirective(hostile);
  assert.doesNotMatch(directive, /etc\/passwd/);
  assert.match(directive, /meta-routing/i, "with no pinned target it routes via meta-routing");

  const pinned = federationDirective(
    federationInputs({ toolId: "squad_federate", request: "x", squad: "azure" }),
  );
  assert.match(pinned, /members\/azure\//);

  // Promotion is stated before init so the order is never ambiguous.
  const both = federationDirective(
    federationInputs({ toolId: "squad_federate", request: "x", init: true, promote: true }),
  );
  assert.ok(
    both.indexOf("Promotion Mode") < both.indexOf("Init / Expansion Mode"),
    "promotion is resolved before init",
  );
});
