---
bump: minor
type: Changed
---

- **The bundled cast lagged behind HVE Squad 0.18.0.** Re-pinned and regenerated
  the cast from the immutable `v0.18.0` tag. The bundle now carries the new
  `HVE Demo Material Builder` agent, the refreshed coordinator, Scribe, council, routing,
  and roster instructions, and the scribe hand-off pipelining, scripted ledger,
  and model-routing contracts the deployed cast follows
  (`host/cast/package-pin.json`, `host/cast/.github/`, `host/cast/manifest.json`).
- **The router could not find the Cast Catalog after HVE Squad moved it.**
  `hve-squad@0.18.0` moved the role-to-agent table out of
  `squad-roster.instructions.md` into the squad skill's
  `references/roster-catalog.md`. The snapshot now bundles that reference, and
  routing, profile resolution, the generator, and the bundle drift test read it
  through `rosterCatalogPath()`, falling back to the roster instructions for an
  older install (`host/snapshot-cast.ts`, `src/paths.ts`, `src/engine/routing.ts`,
  `src/engine/profiles.ts`, `generators/build-manifests.ts`).
- **The advisory council required a fixed four-role quorum.** The council is now
  task-fit: it seats one role per lens the request touches, triggers on any
  responsible-AI concern as well as on two or more of the other lenses, and lists
  every lens left out under `Council Members Not Proposed`. When a needed role is
  not in the seeded profile, `squad_run` records a `## Council Extension` naming
  the roles to add instead of a partial verdict. `rai` now matches only as a
  whole word, so `raise` no longer reads as a responsible-AI concern
  (`src/engine/routing.ts`, `src/engine/council.ts`,
  `src/engine/advisory-pipeline.ts`, `src/engine/persona.ts`).
- **`squad_run` and `squad_federate` accept the new `routing` input.** It mirrors
  the `routing=off|ranked|manual` argument HVE Squad 0.18.0 added to `/squad`
  and `/squad-federation`. The delegated path forwards it to the coordinator,
  which persists it in `team.md`; the embedded path ignores it and logs
  `routing_ignored_unattended` (`tools.catalog.yml`, `src/engine/delegated.ts`,
  `src/engine/embedded.ts`, `generated/`).
