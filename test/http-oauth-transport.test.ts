import assert from "node:assert/strict";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { test } from "node:test";

import { createHttpServer } from "../src/transports/http.js";
import type { HttpRequestLike } from "../src/transports/http-core.js";

test("HTTP adapter preserves form bodies/query strings and emits HTML without JSON quoting", async () => {
  let captured: HttpRequestLike | undefined;
  const server = createHttpServer({
    handle(req) {
      captured = req;
      return Promise.resolve({
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
        body: "<!doctype html><title>OAuth</title>",
      });
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const response = await fetch(`http://127.0.0.1:${address.port}/oauth/authorize?x=1`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-forwarded-proto": "https",
        "x-forwarded-for": "203.0.113.10, 10.0.0.4",
      },
      body: "login_code=ABCDE",
    });
    assert.equal(await response.text(), "<!doctype html><title>OAuth</title>");
    assert.equal(captured?.path, "/oauth/authorize");
    assert.equal(captured?.query, "x=1");
    assert.equal(captured?.body, "login_code=ABCDE");
    assert.deepEqual(captured?.tokenValidation, {
      originalUri: `https://127.0.0.1:${address.port}/oauth/authorize?x=1`,
      originalMethod: "POST",
      forwardedFor: "10.0.0.4",
    });
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("HTTP adapter contains malformed targets and rejected handlers", async () => {
  let calls = 0;
  const server = createHttpServer({
    handle() {
      calls += 1;
      return Promise.reject(new Error("simulated handler failure"));
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const send = (path: string): Promise<{ status: number; body: string }> =>
      new Promise((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port: address.port,
            path,
            method: "GET",
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });

    const malformed = await send("//a:b");
    assert.equal(malformed.status, 400);
    assert.match(malformed.body, /invalid_request_target/);
    assert.equal(calls, 0);

    const rejected = await send("/handler-failure");
    assert.equal(rejected.status, 500);
    assert.match(rejected.body, /internal_error/);
    assert.equal(calls, 1);
  } finally {
    server.close();
    await once(server, "close");
  }
});
