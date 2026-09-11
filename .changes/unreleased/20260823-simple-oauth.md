---
bump: minor
type: Added
---

- **Generic MCP clients can now authenticate without registering an Entra application.** An opt-in server-owned OAuth 2.1 authority adds RFC 9728/8414 discovery, RFC 7591 public-client registration, loopback-only PKCE authorization, operator-issued one-time login codes, short-lived local access tokens, rotating refresh tokens, Azure Table one-time grant storage, and a container-local issuance CLI while preserving the existing Entra path and keeping `Squad.Operate` unavailable to local tokens (`src/auth/simple-oauth.ts`, `src/oauth-cli.ts`, `host/infra/main.bicep`).
- **Azure Table workers now use portable status filters and an explicit Int64 expiry literal.** The one-shot worker no longer fails before claiming a run when Azure Table rejects an `or` predicate or parses an epoch-millisecond filter as `Edm.Int32` (`src/engine/backends/azure-table-run-state.ts`).
- **Azure OpenAI throttling is now retried instead of immediately failing a multi-stage run.** The model backend honors Azure retry headers for 408/429/5xx responses, uses a bounded exponential fallback, and still fails non-transient request errors without retrying (`src/engine/backends/azure-openai.ts`).
