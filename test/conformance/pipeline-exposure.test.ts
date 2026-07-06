/**
 * Pipeline exposure default (HIGH-1), handler level.
 *
 * The gated async pipeline (squad_run + squad_status) must be OFF by default: a
 * handler built without pipelineExposed serves the advisory tools only (the hero
 * tools plus squad_plan / squad_architect), and rejects squad_run / squad_status
 * even for a fully-scoped caller. This is the safe council-gated posture until the
 * operator enables the durable-backed pipeline.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildHarness, callTool, initializeSession } from "./support/harness.js";
import { FakeJwtVerifier, bearer } from "./support/fake-auth.js";
import type { HttpResponseLike } from "../../src/transports/http-core.js";

const ORIGIN = "https://copilotstudio.microsoft.com";
const JSON_HEADERS: Record<string, string> = { "content-type": "application/json" };
const TENANT = "77777777-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function rpcErrorOf(res: HttpResponseLike): { code: number; message: string } | undefined {
  return (res.body as { error?: { code: number; message: string } } | undefined)?.error;
}

test("HIGH-1: with the pipeline disabled, tools/list is hero-only", async () => {
  const verifier = new FakeJwtVerifier();
  const harness = buildHarness({ verifier, pipelineExposed: false });
  verifier.register({
    token: "all-scopes",
    tenantId: TENANT,
    subject: "a",
    scopes: ["Squad.Research", "Squad.Review", "Squad.Run"],
  });
  const sessionId = await initializeSession(harness.handler, "all-scopes");

  const res = await harness.handler.handle({
    method: "POST",
    path: "/mcp",
    headers: { origin: ORIGIN, authorization: bearer("all-scopes"), "mcp-session-id": sessionId, ...JSON_HEADERS },
    body: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  });
  const tools = (res.body as { result?: { tools?: { name: string }[] } }).result?.tools ?? [];
  // The single-stage advisory tools (squad_plan, squad_architect) land NO impactful
  // action, so they are hero-style and exposed even when the gated async pipeline is
  // disabled; only squad_run + squad_status stay hidden until the operator enables it.
  assert.deepEqual(tools.map((t) => t.name).sort(), ["squad_architect", "squad_plan", "squad_research", "squad_review"]);
});

test("HIGH-1: with the pipeline disabled, squad_run and squad_status are rejected", async () => {
  const verifier = new FakeJwtVerifier();
  const harness = buildHarness({ verifier, pipelineExposed: false });
  verifier.register({
    token: "all-scopes",
    tenantId: TENANT,
    subject: "a",
    scopes: ["Squad.Research", "Squad.Review", "Squad.Run"],
  });
  const sessionId = await initializeSession(harness.handler, "all-scopes");

  for (const name of ["squad_run", "squad_status"]) {
    const res = await callTool(harness.handler, {
      token: "all-scopes",
      sessionId,
      name,
      args: name === "squad_status" ? { runId: "00000000-0000-0000-0000-000000000000" } : { request: "x" },
    });
    assert.equal(rpcErrorOf(res)?.code, -32601, `${name} must be unavailable when the pipeline is disabled`);
  }
  assert.equal(harness.backend.callCount, 0);
});
