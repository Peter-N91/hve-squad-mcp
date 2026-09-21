---
bump: minor
type: Added
---

- **One deployment could accept only one token audience, so it could not serve a
  Copilot Studio connector and a Microsoft Copilot Cowork plugin at the same
  time.** Cowork's Entra SSO auth config mints its own Application ID URI and
  presents that as `aud`, which is never the audience a Copilot Studio connector
  uses — so adding Cowork meant breaking Copilot Studio. `SQUAD_MCP_AUDIENCE` now
  accepts a comma-separated list. Entries are trimmed, de-duplicated, and matched
  **exactly**, and a blank entry is dropped rather than becoming an audience a
  malformed token could appear to satisfy; a value of only commas fails fast at
  boot. The same value feeds the Container Apps ingress `allowedAudiences`, so
  the two enforcement layers cannot drift apart (`src/config/operator-config.ts`,
  `src/auth/entra.ts`, `host/infra/main.bicep`).
- `AuthContext.audience` now records **which** configured audience admitted the
  request rather than the whole accepted set, so logs identify the front door a
  caller came through.
