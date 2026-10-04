---
bump: minor
type: Added
---

- `SQUAD_MCP_AUDIENCE` now accepts a comma-separated list of registered aliases
  for one protected resource. Entries are trimmed, de-duplicated, and matched
  **exactly**, and a blank entry is dropped rather than becoming an audience a
  malformed token could appear to satisfy; a value of only commas fails fast at
  boot. Non-MISE deployments feed the same aliases to Container Apps ingress so
  its two enforcement layers cannot drift apart (`src/config/operator-config.ts`,
  `src/auth/entra.ts`, `host/infra/main.bicep`).
- MISE-enabled deployments use `authClientId` as the single source of truth for
  the application, ingress, and MISE `ClientId`/audience. A separate test
  registration must use a separate deployment with MISE disabled, preventing
  test traffic from being attributed to the production MISE resource.
- `AuthContext.audience` now records **which** configured audience admitted the
  request rather than the whole accepted set.
