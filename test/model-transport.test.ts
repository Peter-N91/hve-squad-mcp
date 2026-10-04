import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import { createServer } from "node:http";
import { test } from "node:test";

import { fetchModel, MODEL_TRANSPORT_TIMEOUT_MS } from "../src/engine/backends/model-transport.js";

const INIT = { method: "POST" as const, headers: { "content-type": "application/json" }, body: "{}" };

test("inference transport applies its actual 30-minute header/body limits", async () => {
  const server = createServer((_request, response) => response.end("done"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;
  let inspected = false;
  const inspect = (message: unknown) => {
    assert.ok(message && typeof message === "object" && "request" in message);
    const request = message.request;
    assert.ok(request && typeof request === "object" && "origin" in request);
    if (String(request.origin) !== url) return;
    assert.ok("headersTimeout" in request && "bodyTimeout" in request);
    assert.equal(request.headersTimeout, MODEL_TRANSPORT_TIMEOUT_MS);
    assert.equal(request.bodyTimeout, MODEL_TRANSPORT_TIMEOUT_MS);
    assert.equal(MODEL_TRANSPORT_TIMEOUT_MS, 1_800_000);
    inspected = true;
  };
  const events = channel("undici:request:create");
  events.subscribe(inspect);
  try {
    assert.equal(await (await fetchModel(url, INIT)).text(), "done");
    assert.equal(inspected, true);
  } finally {
    events.unsubscribe(inspect);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("caller cancellation still aborts a model waiting for response headers", async () => {
  const server = createServer(() => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await assert.rejects(
      fetchModel(`http://127.0.0.1:${address.port}`, { ...INIT, signal: AbortSignal.timeout(50) }),
      (error: unknown) => error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name),
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("caller cancellation still aborts a model while reading its body", async () => {
  const controller = new AbortController();
  const server = createServer((_request, response) => {
    response.writeHead(200);
    response.write("{");
    setTimeout(() => controller.abort(), 50);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await assert.rejects(
      fetchModel(`http://127.0.0.1:${address.port}`, { ...INIT, signal: controller.signal }),
      { name: "AbortError" },
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
