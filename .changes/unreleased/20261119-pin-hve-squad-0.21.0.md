---
bump: minor
type: Changed
---

- **The bundled cast lagged behind HVE Squad 0.21.0.** Re-pinned and regenerated
  the cast from the immutable `v0.21.0` tag (`99` agent files across `98` named
  personas). The snapshot resolver now bundles `skills/untrusted-content-boundary/SKILL.md`
  after `microsoft/hve-core` relocated `untrusted-content-boundary.instructions.md`
  into a skill directory, drops the retired `PowerPoint Builder` and `PowerPoint
  Subagent` personas and `presenter` deliverable-producing role, recognizes
  `intake-validator`'s `.copilot-tracking/reviews/` capture root, and advances
  seeded `state.json` records to schema `1.4` (`host/cast/package-pin.json`,
  `host/snapshot-cast.ts`, `host/cast/.github/`, `host/cast/manifest.json`,
  `src/engine/profiles.ts`, `src/engine/squad-ledger.ts`).
- **The tool catalog and delegated coordinator now mirror HVE Squad 0.21.0's
  profiles, packs, `economy` routing, workflow `depth`, and connector `execution`
  controls.** Every catalog tool now exposes all eleven squad profiles
  (`default`, `full`, `security`, `design`, `accessibility`, `architecture`,
  `azure`, `modernization`, `compliance`, `operations`, `product`), and
  `squad_run` and `squad_federate` accept `routing=economy`, per-turn
  `depth=quick|standard`, comma-separated `pack` hints across all nine registered
  packs (`power-platform`, `m365-copilot`, `aws`, `foundry`, `fabric`, `dotnet`,
  `aks`, `azure-functions`, `azure-cloud`), and Contract 1.1
  `execution=original|connector:<binding-id>|both` choices — forwarded verbatim
  on the attended delegated path and ignored with `*_ignored_unattended` logs on
  the unattended embedded path (`tools.catalog.yml`, `src/router/router.ts`,
  `src/engine/coordinator-engine.ts`, `src/engine/persona.ts`,
  `src/engine/delegated.ts`, `src/engine/embedded.ts`, `generated/`,
  `README.md`, `docs/`).
