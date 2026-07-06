/**
 * Secret redaction (SEC-10).
 *
 * The single chokepoint that scrubs secret-shaped material out of any string
 * before it can reach a log sink or a tool response. Two layers:
 *
 *   1. Registered secrets — exact values the server knows are sensitive (bearer
 *      tokens, model API keys, downstream tokens). Registered once at the trust
 *      boundary (auth middleware, backend credential provider) and never logged
 *      verbatim anywhere else.
 *   2. Structural patterns — defense-in-depth for secret-shaped substrings that
 *      were never registered (JWTs, `Bearer` headers, `Authorization` headers,
 *      long high-entropy keys), so an un-registered leak is still caught.
 *
 * This module holds NO state of its own; the active secret set is owned by the
 * logger so registration and scrubbing share one source of truth.
 */

/** A redaction placeholder that never collides with real content. */
export const REDACTED = "[redacted]";

/**
 * Structural patterns for secret-shaped substrings. Order matters: the broadest
 * (whole `Authorization: Bearer ...` header) runs first so its inner token is
 * already gone before the bare-JWT pass would have matched it.
 */
const STRUCTURAL_PATTERNS: { label: string; pattern: RegExp }[] = [
  // `Authorization: Bearer <token>` (header form).
  { label: "authorization-header", pattern: /\bauthorization\b\s*[:=]\s*bearer\s+[\w.\-+/=]+/gi },
  // A bare `Bearer <token>`.
  { label: "bearer", pattern: /\bbearer\s+[\w.\-+/=]+/gi },
  // A JWT: three base64url segments separated by dots, starting `eyJ`.
  { label: "jwt", pattern: /\beyJ[\w-]+\.[\w-]+\.[\w-]+/g },
  // Azure OpenAI / Cognitive Services style 32+ char hex/base64 keys near a key hint.
  { label: "api-key", pattern: /\b(api[_-]?key|ocp-apim-subscription-key)\b\s*[:=]\s*[\w.\-+/=]{16,}/gi },
];

/** Escape a string for safe use inside a `RegExp`. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Scrub a single string: replace every registered secret value and every
 * structural secret pattern with {@link REDACTED}. Short registered values
 * (< 8 chars) are ignored to avoid pathological over-redaction of common words.
 */
export function redactString(value: string, secrets: ReadonlySet<string>): string {
  let out = value;
  for (const secret of secrets) {
    if (secret.length < 8) {
      continue;
    }
    out = out.replace(new RegExp(escapeRegExp(secret), "g"), REDACTED);
  }
  for (const { pattern } of STRUCTURAL_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

/**
 * Deep-scrub an arbitrary value (string, array, or plain object) for logging.
 * Non-string leaves are returned unchanged; strings are passed through
 * {@link redactString}. Used so structured log fields are scrubbed too.
 */
export function redactValue(value: unknown, secrets: ReadonlySet<string>): unknown {
  if (typeof value === "string") {
    return redactString(value, secrets);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, secrets));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactValue(item, secrets);
    }
    return out;
  }
  return value;
}
