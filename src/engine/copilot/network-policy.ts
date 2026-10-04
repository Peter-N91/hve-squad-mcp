/**
 * Network policy for agent tools running in a Copilot sandbox.
 *
 * This is a policy and audit layer evaluated in the trusted executor. It cannot
 * see DNS resolution or what an arbitrary shell command does at run time, so
 * the sandbox's egress controls remain the security boundary; this layer stops
 * the obvious paths (cloud metadata, loopback, private ranges, credentials in
 * URLs) and records why a request was refused.
 */
import { isIP } from "node:net";

export interface NetworkPolicy {
  /** Optional host allow-list; a host matches itself or any subdomain. Empty = any public host. */
  allowedHosts?: readonly string[];
}

export type UrlDecision = { allowed: true; url: URL } | { allowed: false; reason: string };

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
  "metadata.azure.com",
  "instance-data",
]);
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];

function ipv4Blocked(address: string): boolean {
  const [a, b] = address.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

function ipv6Blocked(address: string): boolean {
  const value = address.toLowerCase();
  if (value === "::" || value === "::1") return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  if (mapped) return ipv4Blocked(mapped[1]);
  return /^(fc|fd|fe[89ab]|ff)/.test(value);
}

/** Integer, octal, or hex IPv4 spellings ("2852039166", "0xa9.0xfe.0xa9.0xfe") still resolve to addresses. */
function isNumericIpv4Spelling(host: string): boolean {
  const parts = host.split(".");
  return parts.length <= 4 && parts.every((part) => /^(0x[0-9a-f]+|\d+)$/.test(part));
}

/** True when a hostname or IP literal names a non-public destination. */
export function isNonPublicHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (host.length === 0) return true;
  const family = isIP(host);
  if (family === 4) return ipv4Blocked(host);
  if (family === 6) return ipv6Blocked(host);
  if (isNumericIpv4Spelling(host)) return true;
  if (BLOCKED_HOSTNAMES.has(host) || !host.includes(".")) return true;
  return BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/** Decide whether an agent may fetch a URL. */
export function assessUrl(raw: string, policy: NetworkPolicy = {}): UrlDecision {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { allowed: false, reason: "not an absolute URL" };
  }
  if (url.protocol !== "https:") return { allowed: false, reason: `scheme ${url.protocol} is not permitted; use https` };
  if (url.username || url.password) return { allowed: false, reason: "credentials in URLs are not permitted" };
  if (url.port && url.port !== "443") return { allowed: false, reason: "non-default ports are not permitted" };
  if (isNonPublicHost(url.hostname)) return { allowed: false, reason: `host ${url.hostname} is not a public destination` };
  const allowed = policy.allowedHosts ?? [];
  if (allowed.length > 0) {
    const host = url.hostname.toLowerCase();
    if (!allowed.some((entry) => host === entry.toLowerCase() || host.endsWith(`.${entry.toLowerCase()}`))) {
      return { allowed: false, reason: `host ${url.hostname} is not in the operator allow-list` };
    }
  }
  return { allowed: true, url };
}

const URL_PATTERN = /\b(?:https?|ftp|file|gopher|dict):\/\/[^\s"'`<>|;)]+/gi;
const BARE_ADDRESS = /\b(?:\d{1,3}\.){3}\d{1,3}\b|\[[0-9a-f:]+\]/gi;
// `.copilot` (the runtime's own state, e.g. ~/.copilot) but not `.copilot-tracking`, the project tree.
const SENSITIVE_PATHS = /(?:\/proc\/[^\s]*\/environ|\/proc\/self\/|\.copilot(?![-\w])|\/var\/run\/secrets|\/run\/secrets)/i;

/**
 * Best-effort screen of a shell command for network and secret-path access.
 * Returns the reasons it must be refused, or an empty list.
 */
export function screenShellCommand(command: string, extraUrls: readonly string[], policy: NetworkPolicy = {}): string[] {
  const reasons: string[] = [];
  const urls = new Set<string>([...extraUrls, ...(command.match(URL_PATTERN) ?? [])]);
  for (const url of urls) {
    const decision = assessUrl(url, policy);
    if (!decision.allowed) reasons.push(`${url}: ${decision.reason}`);
  }
  for (const address of command.match(BARE_ADDRESS) ?? []) {
    if (isNonPublicHost(address)) reasons.push(`${address}: non-public address`);
  }
  if (SENSITIVE_PATHS.test(command)) reasons.push("command references runtime credential or process-environment paths");
  return reasons;
}
