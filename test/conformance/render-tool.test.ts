/**
 * Conformance: the deterministic `squad_render_pptx` tool over the real HTTP
 * handler. Proves the transport-level security invariants for the render surface:
 *   * fail-closed scope — a token without `Squad.Render` is denied 403 and NO
 *     render work runs (backend call count stays 0);
 *   * tenant scoping — the blob path carries the caller's tenant id;
 *   * SAS hygiene — the minted SAS never appears in captured logs (SEC-10);
 *   * disabled posture — with no render service the tool is hidden from tools/list
 *     and a call returns -32601.
 *
 * The render backend + blob fetch are fakes (no Python, no live Azure); the auth,
 * scope, session, and routing path is the real production code.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildHarness, initializeSession, callTool, resultText } from "./support/harness.js";
import { bearer } from "./support/fake-auth.js";
import { createCapturingLogger } from "./support/log-capture.js";
import { PptxRenderService } from "../../src/engine/render/pptx-render-service.js";
import { AzureBlobArtifactStore, BLOB_API_VERSION } from "../../src/engine/backends/azure-blob-artifact-store.js";
import type { RenderBackend } from "../../src/engine/render/render-backend.js";
import type { RedactingLogger } from "../../src/observability/logger.js";

const ORIGIN = "https://copilotstudio.microsoft.com";
const CONTENT = "slides:\n  - slide: 1\n    title: Hello\n";
const STYLE = "dimensions:\n  width: 13.333\n  height: 7.5\n";

/** A render backend spy that records how many times it renders. */
function spyBackend(): { backend: RenderBackend; calls: () => number } {
  let calls = 0;
  const backend: RenderBackend = {
    async renderPptx() {
      calls += 1;
      return { pptxBytes: new Uint8Array([80, 75, 3, 4]), slideCount: 1, usedDefaultTemplate: true };
    },
  };
  return { backend, calls: () => calls };
}

/** A fake blob fetch: 201 on PUT (recording the path), user-delegation key XML on POST. */
function blobFetch(): { impl: typeof fetch; putPaths: string[] } {
  const putPaths: string[] = [];
  const impl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "PUT") {
      putPaths.push(url);
      return new Response(null, { status: 201 });
    }
    if (url.includes("comp=userdelegationkey")) {
      const xml =
        `<?xml version="1.0"?><UserDelegationKey><SignedOid>oid</SignedOid><SignedTid>tid</SignedTid>` +
        `<SignedStart>2026-07-06T12:00:00Z</SignedStart><SignedExpiry>2026-07-06T13:00:00Z</SignedExpiry>` +
        `<SignedService>b</SignedService><SignedVersion>${BLOB_API_VERSION}</SignedVersion>` +
        `<Value>${Buffer.from("k").toString("base64")}</Value></UserDelegationKey>`;
      return new Response(xml, { status: 200 });
    }
    return new Response(null, { status: 500 });
  }) as unknown as typeof fetch;
  return { impl, putPaths };
}

function makeRenderService(
  backend: RenderBackend,
  logger: RedactingLogger,
): { service: PptxRenderService; putPaths: string[] } {
  const { impl, putPaths } = blobFetch();
  const store = new AzureBlobArtifactStore({
    account: "acct",
    container: "renders",
    getAccessToken: async () => "mi-token",
    fetchImpl: impl,
    logger,
  });
  return { service: new PptxRenderService({ backend, store, ttlMs: 60 * 60 * 1000 }), putPaths };
}

test("render succeeds with Squad.Render and scopes the blob path to the caller tenant", async () => {
  const { logger, lines } = createCapturingLogger();
  const spy = spyBackend();
  const { service, putPaths } = makeRenderService(spy.backend, logger);
  const h = buildHarness({ logger, lines, renderService: service });
  h.verifier.register({ token: "render-tok", tenantId: "tenant-XYZ", subject: "u1", scopes: ["Squad.Render"] });

  const sessionId = await initializeSession(h.handler, "render-tok");
  const res = await callTool(h.handler, {
    token: "render-tok",
    sessionId,
    name: "squad_render_pptx",
    args: { contentYaml: CONTENT, styleYaml: STYLE },
  });

  assert.equal(res.status, 200);
  const text = resultText(res);
  assert.match(text, /Download the deck/);
  assert.match(text, /expires/);
  assert.equal(spy.calls(), 1, "the render backend ran once");
  assert.equal(putPaths.length, 1);
  assert.match(putPaths[0], /\/renders\/tenant-XYZ\/[0-9a-f-]{36}\/deck\.pptx$/, "tenant-scoped blob path");
  // SEC-10: no SAS signature appears in any captured log line.
  assert.ok(!lines.some((l) => l.includes("sig=")), "the SAS is never logged");
});

test("fail-closed: a token without Squad.Render is denied and NO render runs", async () => {
  const { logger, lines } = createCapturingLogger();
  const spy = spyBackend();
  const { service } = makeRenderService(spy.backend, logger);
  const h = buildHarness({ logger, lines, renderService: service });
  h.verifier.register({ token: "wrong-scope", tenantId: "t1", subject: "u1", scopes: ["Squad.Research"] });

  const sessionId = await initializeSession(h.handler, "wrong-scope");
  const res = await callTool(h.handler, {
    token: "wrong-scope",
    sessionId,
    name: "squad_render_pptx",
    args: { contentYaml: CONTENT, styleYaml: STYLE },
  });

  assert.equal(res.status, 403);
  assert.equal((res.body as { error?: string }).error, "missing_scope");
  assert.equal(spy.calls(), 0, "fail-closed: no render work before the scope check passes");
});

test("disabled: with no render service the tool is hidden and rejected", async () => {
  const h = buildHarness({}); // no renderService
  h.verifier.register({ token: "render-tok", tenantId: "t1", subject: "u1", scopes: ["Squad.Render"] });
  const sessionId = await initializeSession(h.handler, "render-tok");

  // tools/list must NOT include squad_render_pptx.
  const list = await h.handler.handle({
    method: "POST",
    path: "/mcp",
    headers: {
      origin: ORIGIN,
      authorization: bearer("render-tok"),
      "mcp-session-id": sessionId,
      "content-type": "application/json",
    },
    body: { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
  });
  const names = ((list.body as { result?: { tools?: { name: string }[] } }).result?.tools ?? []).map((t) => t.name);
  assert.ok(!names.includes("squad_render_pptx"), "render tool hidden when disabled");

  // A call is rejected as an unknown/unavailable tool.
  const res = await callTool(h.handler, {
    token: "render-tok",
    sessionId,
    name: "squad_render_pptx",
    args: { contentYaml: CONTENT, styleYaml: STYLE },
  });
  const body = res.body as { error?: { code?: number } };
  assert.equal(body.error?.code, -32601, "disabled render tool returns method-not-found");
});

test("missing contentYaml/styleYaml is a -32602 invalid params error", async () => {
  const { logger, lines } = createCapturingLogger();
  const spy = spyBackend();
  const { service } = makeRenderService(spy.backend, logger);
  const h = buildHarness({ logger, lines, renderService: service });
  h.verifier.register({ token: "render-tok", tenantId: "t1", subject: "u1", scopes: ["Squad.Render"] });
  const sessionId = await initializeSession(h.handler, "render-tok");

  const res = await callTool(h.handler, {
    token: "render-tok",
    sessionId,
    name: "squad_render_pptx",
    args: { contentYaml: CONTENT },
  });
  const body = res.body as { error?: { code?: number } };
  assert.equal(body.error?.code, -32602);
  assert.equal(spy.calls(), 0);
});
