import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { convert } from "html-to-text";
import { assessUrl, isNonPublicHost } from "./network-policy.js";

export const UPSTREAM_SOURCE_ORIGINS = [
  "https://learn.microsoft.com", "https://docs.github.com", "https://developer.mozilla.org",
  "https://www.w3.org", "https://w3.org", "https://fidoalliance.org", "https://support.apple.com",
  "https://support.google.com", "https://developers.google.com", "https://www.rfc-editor.org",
] as const;

/** Validates every redirect and pins the connection to a checked DNS answer; never sends credentials. */
export async function readUpstreamPublicSource(raw: string, signal: AbortSignal, origins: readonly string[] = UPSTREAM_SOURCE_ORIGINS): Promise<string> {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(25000)]);
  let target = raw;
  for (let hop = 0; hop <= 4; hop++) {
    const decision = assessUrl(target);
    if (!decision.allowed) throw new Error("Public source refused: " + decision.reason);
    const url = decision.url;
    if (!origins.includes(url.origin) || url.search) throw new Error("Public source origin/query is not authorized.");
    const addresses = await lookup(url.hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(a => isNonPublicHost(a.address))) throw new Error("Public source DNS resolved to a non-public destination.");
    const selected = addresses.find(a => a.family === 4) ?? addresses[0];
    const response = await new Promise<{ status: number; location?: string; type: string; body: Buffer }>((resolve, reject) => {
      const req = request(url, { signal: bounded, headers: { Accept: "text/html,text/plain,application/json", "User-Agent": "HVE-Squad-MCP-source-reader" },
        lookup: (_host, options, callback) => {
          if (typeof options === "object" && options.all) callback(null, [selected]);
          else callback(null, selected.address, selected.family);
        },
      }, res => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 1000000) { res.destroy(new Error("Public source exceeds byte budget.")); return; }
          chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => resolve({ status: res.statusCode ?? 0, location: res.headers.location, type: String(res.headers["content-type"] ?? ""), body: Buffer.concat(chunks) }));
      });
      req.on("error", reject);
      req.end();
    });
    if ([301,302,303,307,308].includes(response.status)) {
      if (!response.location || hop === 4) throw new Error("Public source redirect exceeds policy.");
      target = new URL(response.location, url).href;
      continue;
    }
    if (response.status !== 200 || !/^(?:text\/html|text\/plain|application\/json)/i.test(response.type)) throw new Error("No usable public document: HTTP " + response.status);
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(response.body);
    const html = /text\/html/i.test(response.type);
    const main = html ? decoded.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] ?? decoded : decoded;
    const content = html ? convert(main, {wordwrap:false,selectors:[{selector:"script",format:"skip"},{selector:"style",format:"skip"},{selector:"nav",format:"skip"}]}).trim() : main.trim();
    if (content.length < 100) throw new Error("Public source returned only a title/app shell; rendered-browser verification is required.");
    if (Buffer.byteLength(content) > 256000) throw new Error("Public source text exceeds reader budget; select a smaller document.");
    return content;
  }
  throw new Error("Public source redirect loop.");
}
