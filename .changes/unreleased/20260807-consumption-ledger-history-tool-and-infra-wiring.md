---
bump: patch
type: Added
---

- **A run recorded no cost and its history could not be opened remotely.** The scribe now appends a measured `#### Consumption` block per dispatch from the backend's real token counts, and `consumption.md` is rebuilt from every block in `history/*.md` so an earlier turn's roles survive a later rewrite. `squad_history` is served over HTTP with `op=index|list|read`, and `enableArtifacts` plus `enableAdvisoryAutopilot` are wired through `host/infra/main.bicep` and documented in the runbook (`src/engine/consumption.ts`, `src/transports/http-core.ts`, `host/infra/main.bicep`).
