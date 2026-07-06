/**
 * Streamable HTTP `/mcp` socket binding (SEC-8).
 *
 * A thin `node:http` adapter over the transport-pure {@link HttpMcpHandler}: it
 * reads and size-caps the request body, normalizes headers to lowercase, and
 * writes the handler's plain response. All security logic lives in the handler so
 * it stays unit-testable; this file only moves bytes.
 *
 * **HTTPS-only.** The public endpoint is HTTPS-only — the Azure Container App
 * ingress terminates TLS and is configured with `allowInsecure: false`
 * (see `host/infra/`). The container itself receives forwarded HTTP from the
 * ingress, so as defense-in-depth this adapter additionally rejects any request
 * whose `x-forwarded-proto` is present and not `https`. The server therefore
 * never serves the MCP protocol over a plaintext public hop.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { HttpMcpHandler, type HttpRequestLike } from "./http-core.js";

/** Maximum accepted request body size (defense against oversized payloads). */
export const MAX_BODY_BYTES = 1_000_000;

function lowercaseHeaders(req: IncomingMessage): Record<string, string | undefined> {
  const headers: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    headers[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return headers;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  if (req.method !== "POST" && req.method !== "PUT") {
    return undefined;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      throw new Error("Request body too large.");
    }
    chunks.push(buffer);
  }
  if (total === 0) {
    return undefined;
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    // Hand an unparseable body to the handler as `undefined` => -32700.
    return undefined;
  }
}

/** Build (but do not listen on) a `node:http` server bound to the MCP handler. */
export function createHttpServer(handler: HttpMcpHandler): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(handler, req, res);
  });
}

async function handleRequest(
  handler: HttpMcpHandler,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const headers = lowercaseHeaders(req);

  // SEC-8 defense-in-depth: reject a non-HTTPS forwarded hop.
  const forwardedProto = headers["x-forwarded-proto"];
  if (forwardedProto !== undefined && forwardedProto.split(",")[0].trim() !== "https") {
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "https_required" }));
    return;
  }

  const path = (req.url ?? "/").split("?")[0];
  let body: unknown;
  try {
    body = await readBody(req);
  } catch {
    res.writeHead(413, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "payload_too_large" }));
    return;
  }

  const request: HttpRequestLike = {
    method: req.method ?? "GET",
    path,
    headers,
    body,
  };

  const response = await handler.handle(request);
  res.writeHead(response.status, response.headers);
  if (response.body === undefined) {
    res.end();
  } else {
    res.end(JSON.stringify(response.body));
  }
}
