---
bump: minor
type: Fixed
---

- **A product run produced text and wrote nothing.** `SquadRunRecorder.recordStage` existed but was never called, and the recorder was never constructed in `server-http.ts`, so a run left a compiled artifact and an empty tree. The advisory pipeline now writes each finished stage through a ledger sink to its roster Deliverable Root, and the recorder is wired in the composition root behind `SQUAD_MCP_ENABLE_ARTIFACTS` (`src/engine/advisory-pipeline.ts`, `src/engine/embedded.ts`, `src/server-http.ts`).
