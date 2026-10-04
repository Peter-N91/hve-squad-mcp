---
bump: minor
type: Added
---

- **Advisory runs write a report before review.** When no deliverable fan-out
  replaces it, the advisory pipeline runs a bounded, text-only report stage
  between Plan and Review. It may read project artifacts and write one Markdown
  report under `.copilot-tracking/changes/`, with no shell, network or
  delegation, and a budget of 10 model calls and 12 tool calls (agentic
  runtimes spend one model call per tool round trip), so the reviewer no longer
  fails runs for a missing developer artifact.
- **Copilot research can read full pages through curl or a real browser.** The
  Copilot sandbox image includes pinned Playwright 1.63.0 and Chromium, exposed
  as `squad-browser`. Researchers are told that `web_fetch` may return only a
  summary or an app shell, and to fall back to `curl` for static text or to
  `squad-browser` for JavaScript-rendered pages and ordinary click,
  search-field and scroll navigation. Each workflow uses a fresh browser
  context with at most 12 actions; afterwards the page is scrolled so lazy
  content renders, and visible text including open shadow roots is extracted.
  Output is one `HVE_BROWSER_RESULT` metadata line followed by up to 30,000
  characters of text and links. Requests are limited to public HTTPS hosts
  (checked after DNS resolution) and the optional host allow-list, which the
  sandbox reads from `COPILOT_BROWSER_ALLOWED_HOSTS`. Sign-in, passwords,
  paywalls and CAPTCHAs are out of scope. Browser results are recorded as
  `browser-reported:` evidence with the visited URLs; output redirected or
  piped by the agent is recorded as `browser-output-redirected:`, so reviewers
  know that receipt has no page text.
- IPv4-mapped IPv6 addresses written in hex (`::ffff:a00:1`) are treated as
  non-public by the sandbox network policy.
- Files under `host/sandbox/` are pinned to LF, because a CRLF shebang stops
  the launcher from running in the Linux image.
