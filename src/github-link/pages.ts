import type { HttpResponseLike } from "../transports/http-core.js";
import type { GitHubLinkErrorCode } from "./types.js";

const BASE_HEADERS: Record<string, string> = {
  "cache-control": "no-store",
  pragma: "no-cache",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function page(status: number, title: string, message: string, extraHeaders: Record<string, string> = {}): HttpResponseLike {
  // Both strings are compile-time constants below; nothing request-derived is ever interpolated.
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex">` +
    `<title>${title}</title></head><body><main><h1>${title}</h1><p>${message}</p></main></body></html>`;
  return {
    status,
    headers: { ...BASE_HEADERS, "content-type": "text/html; charset=utf-8", ...extraHeaders },
    body: html,
  };
}

export function redirectResponse(location: string, extraHeaders: Record<string, string> = {}): HttpResponseLike {
  return { status: 302, headers: { ...BASE_HEADERS, location, ...extraHeaders } };
}

export function successPage(extraHeaders: Record<string, string> = {}): HttpResponseLike {
  return page(
    200,
    "GitHub account linked",
    "Your GitHub account is now linked. You can close this window and return to your assistant.",
    extraHeaders,
  );
}

const ERROR_PAGES: Record<GitHubLinkErrorCode, { status: number; message: string }> = {
  github_connection_required: { status: 404, message: "No GitHub link was found. Start again from your assistant." },
  github_reauthentication_required: { status: 401, message: "Sign in again from your assistant to relink GitHub." },
  github_identity_changed: {
    status: 409,
    message: "This GitHub account differs from the one already linked. Ask your assistant to confirm the change first.",
  },
  github_link_state_invalid: {
    status: 400,
    message: "This link is invalid, expired or already used. Start again from your assistant.",
  },
  github_link_principal_mismatch: {
    status: 403,
    message: "You are signed in as a different user than the one who requested this link. Nothing was linked.",
  },
  github_token_refresh_conflict: { status: 503, message: "Please try again in a moment." },
};

export function errorPage(code: GitHubLinkErrorCode, extraHeaders: Record<string, string> = {}): HttpResponseLike {
  const entry = ERROR_PAGES[code];
  return page(entry.status, "GitHub link failed", entry.message, extraHeaders);
}

export function methodNotAllowed(): HttpResponseLike {
  return page(405, "GitHub link failed", "Method not allowed.", { allow: "GET, POST" });
}

export function consentPage(action: string, fields: Record<string, string>, switching = false, extraHeaders: Record<string, string> = {}, accounts?: { from: string; to: string }, authorizeOrigin?: string): HttpResponseLike {
  const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  // no-referrer makes browsers send Origin: null on the form POST.
  const csp = authorizeOrigin
    ? `${BASE_HEADERS["content-security-policy"]} ${new URL(authorizeOrigin).origin}`
    : BASE_HEADERS["content-security-policy"];
  const response = page(200, switching ? "Confirm GitHub account switch" : "Connect GitHub",
    switching ? `A different GitHub account was selected${accounts ? `: ${escape(accounts.from)} to ${escape(accounts.to)}` : ""}. Confirm to replace your existing connection.` : "Continue to sign in and connect your GitHub account.", { ...extraHeaders, "referrer-policy": "same-origin", "content-security-policy": csp });
  response.body = String(response.body).replace("</main>", `<form method="post" action="${escape(action)}">${Object.entries(fields).map(([key, value]) => `<input type="hidden" name="${escape(key)}" value="${escape(value)}">`).join("")}<button type="submit">${switching ? "Confirm account switch" : "Continue to sign in"}</button></form></main>`);
  return response;
}
