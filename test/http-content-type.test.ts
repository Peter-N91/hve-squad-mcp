/**
 * The node:http adapter declares the content type of every response body, so a
 * string a handler returns can never be served as markup by accident.
 */
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import type { HttpResponseLike } from "../src/transports/http-core.js";
import { createHttpServer } from "../src/transports/http.js";

async function serve(response: HttpResponseLike): Promise<Response> {
  const server = createHttpServer({ handle: async () => response });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    return await fetch(`http://127.0.0.1:${port}/x`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("a string body is plain text unless the handler explicitly marks it text/html", async () => {
  const untyped = await serve({ status: 200, headers: {}, body: "<script>alert(1)</script>" });
  assert.equal(untyped.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(await untyped.text(), "<script>alert(1)</script>");

  const mislabeled = await serve({ status: 400, headers: { "content-type": "text/xml" }, body: "<x/>" });
  assert.equal(mislabeled.headers.get("content-type"), "text/plain; charset=utf-8");

  const html = await serve({ status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: "<p>ok</p>" });
  assert.equal(html.headers.get("content-type"), "text/html; charset=utf-8");
});

test("an object body is JSON and an empty body keeps the handler's headers", async () => {
  const json = await serve({ status: 200, headers: { "content-type": "text/html", "x-extra": "kept" }, body: { ok: true } });
  assert.equal(json.headers.get("content-type"), "application/json");
  assert.equal(json.headers.get("x-extra"), "kept");
  assert.deepEqual(await json.json(), { ok: true });

  const empty = await serve({ status: 204, headers: { "x-extra": "kept" } });
  assert.equal(empty.status, 204);
  assert.equal(empty.headers.get("x-extra"), "kept");
});
