---
bump: patch
type: Fixed
---

- **Status polls no longer hold the connection past the ingress ceiling.**
  Without a background worker, a `squad_status` poll that claimed a run drove
  the whole advisory pipeline inside the request. Long stages (for example on
  the Copilot runtime) kept it open past the 240-second Azure Container Apps
  ingress limit, which MCP clients report as an unreachable connector. The poll
  now waits up to 30 seconds, then answers `run_already_in_flight` while the
  run continues in the same process; later polls report it in flight and then
  return the stored result. An in-process guard prevents a second drive even if
  the claim lease lapses. Worker deployments are unchanged
  (`src/engine/embedded.ts`, `src/server-http.ts`).
- **Fetched documentation is parsed as text, not stripped with regular
  expressions.** `fetch_documentation` converts the page with `html-to-text`
  (scripts, styles and navigation skipped, entities left encoded), replacing a
  regex tag strip that static analysis flagged as incomplete sanitization.
- **HTTP responses declare their content type.** String bodies are served as
  `text/plain` unless a handler explicitly marks them `text/html`, and object
  bodies as `application/json`, so a reflected string can never be interpreted
  as markup (`src/transports/http.ts`).
- **The background worker no longer leaks an abort listener per tick**
  (`src/engine/run-worker.ts`).
- **A declining backlog handoff no longer fails a reviewed run.** When the
  optional backlog-handoff agent stops because the request has nothing to plan
  (for example a research question), the run completes and records the stage as
  skipped. Runtime failures and limits in that stage still halt the run.
