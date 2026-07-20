# Changelog

All notable changes to the hve-squad-mcp server are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This server is a companion to the [hve-squad](https://github.com/Peter-N91/hve-squad)
APM package. Each release pins the squad cast it bundles to a specific package
version, recorded in `host/cast/package-pin.json` and enforced by
`npm run snapshot:cast`.

## [0.2.2] - 2026-07-20

### Added

- **Requirements intake gate awareness**, tracking the conditional intake gate now shipped in `hve-squad@0.10.3`. When a request is grounded in requirement or input artifacts and will lead to a plan, a build, or a deliverable, the delegated coordinator payload now instructs the host to validate those inputs first via the new `intake-validator` role, record an `## Intake Readiness Verdict` (`Ready` / `Ready-With-Gaps` / `Not-Ready`), and on `Not-Ready` run the bounded auto-remediation loop (dispatch `analyst`/`product-owner` → re-validate, capped at two cycles) or escalate — all ahead of the Implementation Gate.
  - New Intake Gate paragraph in the delegated persona gate context (`src/engine/persona.ts`, `GATE_INSTRUCTIONS`), surfaced for the pipeline/council tools (`squad_run`, `squad_review`, `squad_federate`).

### Changed

- Bumped the bundled cast pin to `Peter-N91/hve-squad@0.10.3` and refreshed the snapshot (`host/cast/`), so `squad-intake-gate.instructions.md`, the `intake-validator` roster row, and the Intake Gate routing section are on disk for the routing engine, persona resolution, and the drift check.
- Documented the intake gate in the README.

### Notes

- Surfacing the intake gate as an explicit stage of the embedded/advisory pipeline (`squad_run`) is deferred, mirroring the staged embedded federation work; the delegated (local VS Code) path carries the full intake-gate behavior today.

[0.2.2]: https://github.com/Peter-N91/hve-squad-mcp/releases/tag/v0.2.2

## [0.2.1] - 2026-07-17

### Added

- **Federation-level autopilot** surfaced through `squad_federate`, tracking the federation-autopilot feature now shipped in `hve-squad@0.10.2`. When `mode=autopilot` is passed with **no** `squad=` target, the delegated payload now drives the federation-level meta-pipeline: order the meta-routing-selected sub-squads by dependency, run each sub-squad's standard autopilot inner run scoped to `members/<name>/`, aggregate every Impactful-Action and Risk Gate to the federation level (attributed to the raising sub-squad), apply one aggregate `cost-ceiling`, and end with a single consolidated final-outcome validation.
  - New `FEDERATION_AUTOPILOT_NOTE` persona block and federation-autopilot framed-request branch in the delegated engine (`src/engine/persona.ts`, `src/engine/delegated.ts`). A single `squad=` target still forwards autopilot to that one sub-squad unchanged.
  - Updated the `squad_federate` `mode` input description in `tools.catalog.yml` and regenerated `generated/mcp-tools.schema.json` and the Copilot Studio connector.

### Changed

- Bumped the bundled cast pin to `Peter-N91/hve-squad@0.10.2` and refreshed the snapshot (`host/cast/`), so the Squad Federation Coordinator's **Federation Autopilot Mode** section and the new `squad-federation-autopilot.instructions.md` are on disk for persona resolution and the generator drift check.
- Updated the README federation section: a coordinated federation-wide autopilot is now shipped (was previously deferred).

[0.2.1]: https://github.com/Peter-N91/hve-squad-mcp/releases/tag/v0.2.1

## [0.2.0] - 2026-07-17

### Added

- **Federation support** for the opt-in in-repo sub-squads shipped in `hve-squad@0.10.1`.
  - New `squad_federate` tool mapping to the **Squad Federation Coordinator**: reads the federation registry (`federation.md`) and meta-routing (`meta-routing.md`), routes to one or more named sub-squads (or an explicit `squad=<name>`), and runs each scoped to `.copilot-tracking/squad/members/<name>/`. Supports `init` for Federation Init Mode. Catch-all tool at the `confirm` tier with gates.
  - New optional `squad` input on the five coarse tools (`squad_research`, `squad_plan`, `squad_review`, `squad_architect`, `squad_run`) to target a federation sub-squad; the delegated state context and framed request scope to that sub-squad's root.
  - Delegated engine gains a Federation Coordinator persona, a federation-detection note (resolve the sub-squad from `squad=`/meta-routing before dispatching), and a `squadStateRoot()` helper (`src/engine/persona.ts`, `src/engine/delegated.ts`, `src/engine/coordinator-engine.ts`, `src/router/router.ts`).
  - Refreshed the bundled cast snapshot from `hve-squad@0.10.1` so the Squad Federation Coordinator persona and `squad-federation.instructions.md` are on disk for persona resolution and the generator drift check (`host/cast/`).

### Notes

- Autonomy modes are forwarded to a single targeted sub-squad; a coordinated federation-wide pipeline across sub-squads (the embedded/async multi-sub-squad case) is deferred, mirroring the deferred federation-autopilot work in the package.

[0.2.0]: https://github.com/Peter-N91/hve-squad-mcp/releases/tag/v0.2.0

## [0.1.9] - 2026-07-17

### Changed

- Bumped the package pin to `Peter-N91/hve-squad@0.10.1` and cut this release to track it.
  Run `npm run snapshot:cast` on this branch if the bundled cast changed (the cast-bundle CI check enforces it).

[0.1.9]: https://github.com/Peter-N91/hve-squad-mcp/releases/tag/v0.1.9

## [0.1.8] - 2026-07-15

### Changed

- Bumped the package pin to `Peter-N91/hve-squad@0.9.5` and cut this release to track it.
  Run `npm run snapshot:cast` on this branch if the bundled cast changed (the cast-bundle CI check enforces it).

[0.1.8]: https://github.com/Peter-N91/hve-squad-mcp/releases/tag/v0.1.8

## [0.1.7] - 2026-07-14

### Changed

- Bumped the package pin to `Peter-N91/hve-squad@0.9.4` and cut this release to track it.
  Run `npm run snapshot:cast` on this branch if the bundled cast changed (the cast-bundle CI check enforces it).

[0.1.7]: https://github.com/Peter-N91/hve-squad-mcp/releases/tag/v0.1.7

## [0.1.6] - 2026-07-12

### Changed

- Bumped the package pin to `Peter-N91/hve-squad@0.9.3` and cut this release to track it.
  Run `npm run snapshot:cast` on this branch if the bundled cast changed (the cast-bundle CI check enforces it).

[0.1.6]: https://github.com/Peter-N91/hve-squad-mcp/releases/tag/v0.1.6

## [0.1.5] - 2026-07-11

### Changed

- Bumped the package pin to `Peter-N91/hve-squad@0.9.2` and cut this release to track it.
  Run `npm run snapshot:cast` on this branch if the bundled cast changed (the cast-bundle CI check enforces it).

[0.1.5]: https://github.com/Peter-N91/hve-squad-mcp/releases/tag/v0.1.5

## [0.1.4] - 2026-07-10

### Changed

- Bumped the package pin to `Peter-N91/hve-squad@0.9.1` and cut this release to track it.
  Run `npm run snapshot:cast` on this branch if the bundled cast changed (the cast-bundle CI check enforces it).

[0.1.4]: https://github.com/Peter-N91/hve-squad-mcp/releases/tag/v0.1.4

## [0.1.3] - 2026-07-08

### Changed

- Bumped the package pin to `Peter-N91/hve-squad@0.9.0` and cut this release to track it.
  Run `npm run snapshot:cast` on this branch if the bundled cast changed (the cast-bundle CI check enforces it).

[0.1.3]: https://github.com/Peter-N91/hve-squad-mcp/releases/tag/v0.1.3

## [0.1.2] - 2026-07-08

### Changed

- Bumped the package pin to `Peter-N91/hve-squad@0.8.23` and cut this release to track it.
  Run `npm run snapshot:cast` on this branch if the bundled cast changed (the cast-bundle CI check enforces it).

[0.1.2]: https://github.com/Peter-N91/hve-squad-mcp/releases/tag/v0.1.2

## [0.1.1] - 2026-07-08

### Changed

- Bumped the package pin to `Peter-N91/hve-squad@0.8.22` and cut this release to track it.
  Run `npm run snapshot:cast` on this branch if the bundled cast changed (the cast-bundle CI check enforces it).

[0.1.1]: https://github.com/Peter-N91/hve-squad-mcp/releases/tag/v0.1.1

## [0.1.0] - 2026-07-06

Initial standalone release, split from the hve-squad monorepo.

### Added

- Remote MCP advisory surface over Streamable HTTP with Entra auth: `squad_research`,
  `squad_plan`, `squad_review`, `squad_architect`, the gated async `squad_run`
  pipeline, and the `squad_status` poll utility.
- Deterministic `squad_render_pptx` file-output tool: renders deck content YAML to a
  `.pptx` with python-pptx and returns a short-lived Azure Blob user-delegation SAS
  download link (tenant-scoped path, SAS never logged, fail-closed `Squad.Render` scope).
- Full-cast persona bundle under `host/cast/.github`, snapshotted from the package and
  pinned via `host/cast/package-pin.json` (drift-checked by `npm run snapshot:cast` and
  `test/cast-bundle.test.ts`).
- Azure Container Apps hosting IaC (`host/infra/main.bicep`) with scale-to-zero, Entra
  auth, managed identity, Key Vault, and an optional durable run-state + worker path.
- Copilot Studio connector projection (`npm run generate:connector`).

### Linked package

- Built against `hve-squad@0.8.18`.

[0.1.0]: https://github.com/Peter-N91/hve-squad-mcp/releases/tag/v0.1.0
