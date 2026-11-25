import { request } from "undici";

export const MODEL_TRANSPORT_TIMEOUT_MS = 30 * 60 * 1000;

export interface ModelRequestInit {
  method: "POST";
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}

// Reasoning calls may not send headers until generation completes. Keep this
// policy local to inference; the caller's shorter deadline still cancels it.
export async function fetchModel(url: string, init: ModelRequestInit): Promise<Response> {
  const response = await request(url, {
    ...init,
    headersTimeout: MODEL_TRANSPORT_TIMEOUT_MS,
    bodyTimeout: MODEL_TRANSPORT_TIMEOUT_MS,
  });
  const headers = new Headers();
  for (const [name, value] of Object.entries(response.headers)) {
    for (const entry of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
      headers.append(name, entry);
    }
  }
  const content = await response.body.text();
  return new Response([204, 205, 304].includes(response.statusCode) ? null : content, {
    status: response.statusCode,
    headers,
  });
}
