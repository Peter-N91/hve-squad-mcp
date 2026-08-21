---
bump: patch
type: Changed
---

- **The Copilot Studio agent package named roles the squad no longer has, and
  covered four of the fourteen served tools.** `copilot-studio/` now tracks the
  current cast and its ten connected children are each **named for the squad role
  their tool routes to** — `Squad Researcher`, `System Architecture Reviewer`,
  `Squad Lead`, `Squad Reviewer`, `BRD Builder`, `Functional Planner`,
  `Squad Coordinator`, and `Squad Federation Coordinator` replace the invented
  advisor names, so the package introduces no persona of its own. Six of those
  children are new, covering the business, gated-pipeline, federation,
  memory/ledger, and render surfaces (`copilot-studio/parent/`,
  `copilot-studio/child/`). `Memory Curator` and `Deck Renderer` keep functional
  names and say plainly that their deterministic tools dispatch no role.
- **The package documented a Human Gate no Copilot Studio agent could release,
  and a discovery gate the remote path ignores.** `copilot-studio/README.md` now
  records `SQUAD_MCP_ADVISORY_AUTOPILOT_ENABLED` and `SQUAD_MCP_ENABLE_ARTIFACTS`,
  states that `discovery` is accepted but discarded on the unattended HTTP path,
  and maps every child to the operator flag and scope that serve it. The
  connector templates request the full scope surface
  (`copilot-studio/connector/*.template.json`).
