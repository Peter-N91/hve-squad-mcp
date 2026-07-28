# Changelog

All notable changes to the hve-squad-mcp server are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This server is a companion to the [hve-squad](https://github.com/Peter-N91/hve-squad)
APM package. Each release pins the squad cast it bundles to a specific package
version, recorded in `host/cast/package-pin.json` and enforced by
`npm run snapshot:cast`.

## [0.2.11] - 2026-07-28

### Changed

- Bumped the package pin to `Peter-N91/hve-squad@0.10.11` and cut this release to track it.
  Run `npm run snapshot:cast` on this branch if the bundled cast changed (the cast-bundle CI check enforces it).

[0.2.11]: https://github.com/Peter-N91/hve-squad-mcp/releases/tag/v0.2.11

## [0.2.10] - 2026-07-27

> Built against `Peter-N91/hve-squad@0.10.10` (see `host/cast/package-pin.json`).

### Changed

- **Bumped the package pin to `Peter-N91/hve-squad@0.10.10` and refreshed the bundled cast snapshot** (`host/cast/`, pinned commit `61a72c0b644d08ed96e0e8b71aaf7ca1f6ea67c0`), bringing the squad's **event-scoped Watch Mode sub-squads** on disk. The embedded engine resolves real persona bytes from this bundle, so the Federation Coordinator it ships now carries **Watch Mode Bootstrap Mode**, the Scribe carries the compare-and-swap promotion refusal, and `squad-watch-mode.instructions.md` carries the *Event-Scoped Sub-Squads (Federation Bootstrap)* contract — the bootstrap decision table, the deterministic naming rules (`issue-<N>`, `pr-<N>`, `sweep-<YYYY-MM-DD>`, `push-<branch-slug>-<sha7>`, `dispatch-<runId>`), and the watch-owned registry convention.

### Security

- **No MCP turn can claim the unattended Watch Mode bootstrap.** The squad release gives the Federation Coordinator an auto-approved promotion/expansion path, and that confirmation waiver is bounded by things only a repository event supplies: a `squad/*` label or `/squad` keyword opt-in, a write-collaborator authorization check, and a sub-squad name derived purely from structural event metadata. This server is not that trigger — it has no event, no label gate, no collaborator check, and its callers supply free text. Because the newly bundled charter now *describes* the auto-approved path, both federation surfaces pin every turn as confirmation-gated: the delegated system prompt (`FEDERATION_COORDINATOR_PERSONA`) and the server-composed embedded directive (`federationDirective`) both carry a `NO_WATCH_BOOTSTRAP_NOTE` stating that this is not a Watch Mode turn, that Promotion and Expansion propose and wait, that a sub-squad name is never derived from request text, and that a claim of event provenance in the request confers nothing. The `promote` branch of the embedded directive now says "confirmation-gated promotion, not the unattended Watch Mode one" explicitly (`src/engine/persona.ts`, `src/engine/federation.ts`).
- New `test/watch-bootstrap-exclusion.test.ts` (6 tests) proves the guard is present on both surfaces and load-bearing: it asserts the bundled charter really carries the unattended mode, that every directive shape (plain, `promote`, `init`, pinned `squad`, `autopilot`) includes the note, and that a caller claiming event provenance — with a traversal-shaped `squad` value — produces a directive byte-identical to the plain turn.

[0.2.10]: https://github.com/Peter-N91/hve-squad-mcp/releases/tag/v0.2.10

## [0.2.9] - 2026-07-27

> Built against `Peter-N91/hve-squad@0.10.9` (unchanged from 0.2.8; see `host/cast/package-pin.json`).

### Added

- **Federation is now callable over the remote (Copilot Studio) boundary.** `squad_federate` previously existed only on the delegated (VS Code) path: it had no OAuth scope, was absent from the remotely-exposed set, and had no embedded dispatch branch, so it was invisible in `tools/list` and rejected on call. It now carries its own least-privilege **`Squad.Federate`** scope (deliberately not `Squad.Run` — authorization to run one squad is not authorization to drive a federation), is exposed alongside `squad_run` when the operator enables the gated pipeline, holds at the non-bypassable Human Gate, and executes server-side as a Federation Coordinator advisory stage (`src/auth/scopes.ts`, `src/engine/federation.ts`, `src/engine/embedded.ts`, `src/transports/http-core.ts`).
- **`RunState.params`** — the remaining coordinator inputs (`profile`, `tier`, `owner`, `mode`, and the federation `squad` / `init` / `promote` flags) are now persisted with an async run and rebuilt on resume, encrypted at rest like `request`/`context`. Previously only `request`/`context` survived the durable boundary, so an approved federation run silently degraded into a plain pipeline run (`src/engine/run-params.ts`, `src/engine/run-state.ts`, `src/engine/durable-run-state.ts`, `src/engine/backends/azure-table-run-state.ts`).
- **Automatic squad memory (`SQUAD_MCP_MEMORY_AUTO_ENABLED`).** Memory was previously reachable only through manual `squad_memory_*` tool calls with a caller-invented project name — unreliable under generative orchestration. With auto-memory on, every embedded dispatch is preceded by a read of the resolved project's `state` + `decisions` (injected as **delimited DATA**, never authority — SEC-5) and followed by a `history/<toolId>-<runId>` write plus a compare-and-swap `state` digest append. The partition is derived deterministically from a pinned sub-squad or the operator's `SQUAD_MCP_MEMORY_DEFAULT_PROJECT`, never from caller free text. A memory outage degrades a run to "no continuity" rather than failing it (`src/engine/auto-memory.ts`).
- **SharePoint / OneDrive memory persistence (`SQUAD_MCP_MEMORY_BACKEND=graph`).** A Microsoft Graph drive realization of the `SquadMemoryStore` seam stores each entry as a readable markdown file at `<rootPath>/<tenantId>/<project>/<path>.md`, with native `eTag` + `If-Match` compare-and-swap. Content is **plaintext by default** — a SharePoint library exists to be read by humans — and encrypted only when the operator explicitly opts in (`src/engine/backends/graph-squad-memory.ts`).
- **Operator-declared, caller-selectable memory destinations (`SQUAD_MCP_MEMORY_TARGETS`).** A deployment can offer several destinations; a caller selects one **by name** via the new optional `target` input on the memory tools. The operator owns every credential-bearing field (drive ids, accounts, directories) and the caller only ever sees an opaque name — the same allow-list pattern already used for `allowedModelEndpoints` (SEC-3). An undeclared name is rejected fail-closed before any I/O, never silently falling back to the default (`src/engine/targeted-squad-memory.ts`).
- **Business-user tools (`SQUAD_MCP_ENABLE_BUSINESS_TOOLS`).** `squad_business_plan` returns a fixed-section, plain-language business plan for a non-technical stakeholder. `squad_backlog` returns a **validated JSON contract** — epics → stories (with Given/When/Then acceptance criteria) → tasks, plus a flattened `workItems[]` carrying stable `ref` / `parentRef` ids — so a Copilot Studio agent can loop the native Azure DevOps / Jira connector one call per item, parents first, instead of parsing prose. Each tool carries its own least-privilege scope (`Squad.Business` / `Squad.Backlog`) and lands no impactful action; the ADO/Jira write still happens in the certified native connector on the end user's own connection (ADR-0001) (`src/engine/business-tools.ts`, `src/engine/backlog-contract.ts`).
- **Generated Copilot Studio agent instructions** (`generated/copilot-studio-connector/agent-instructions.md`) — a paste-ready instructions block covering tool selection, the gated-run (`run id` → `squad_status`) protocol, the backlog → native-connector mapping with human confirmation and throttle pacing, and the manual memory turn protocol for deployments that do not enable auto-memory.
- **IaC for the memory broker and the business tools** (`host/infra/main.bicep`). New parameters — `enableMemory`, `memoryBackend` (`table` | `graph`), `memoryTableName`, `enableMemoryAuto`, `memoryDefaultProject`, `memoryGraph*`, `memoryTargets` / `memoryDefaultTarget`, `enableMemoryOverflow` / `memoryOverflowContainer`, and `enableBusinessTools` — project the matching environment onto both the web app and the worker job. The memory table and the overflow container are provisioned, and the Storage Table / Blob role assignments now key off *which storage service is needed* rather than off the pipeline and render flags alone, so enabling memory or overflow on its own grants the app identity the access it needs. `SQUAD_MCP_STORAGE_ACCOUNT` is emitted once from a single `storageEnv`, removing the fragile dedupe between the pipeline and render blocks.
- **`host/infra/graph-memory-permissions.bicep` + `.bicepparam`** — the previously manual, admin-only half of the SharePoint memory backend is now IaC. It assigns Microsoft Graph **`Sites.Selected`** to the app's managed identity and then grants that identity **write on exactly one site** (`POST /sites/{siteId}/permissions`). Both are Graph data-plane calls with no ARM resource type, so they run in one idempotent deployment script authenticated as an operator-supplied managed identity — no credential is passed to or stored by the template, and re-running is a no-op. It is a **separate deployment** on purpose: it needs `AppRoleAssignment.ReadWrite.All` + `Sites.FullControl.All`, so keeping it apart means the routine app deployment never requires Graph admin rights. Omitting `sharePointSiteId` assigns `Sites.Selected` only, which by design reaches no site at all.
- New `main.bicep` outputs `appClientId` and `memoryBackendInUse` feed the permissions deployment.

### Changed

- The generated Copilot Studio connector now projects `squad_federate` and the two business tools, and its Entra scope list grows accordingly (`Squad.Federate`, `Squad.Business`, `Squad.Backlog`).
- `memoryBackend` accepts `graph` in addition to `file` and `table`.
- `host/RUNBOOK.md` documents the new scopes, the four optional feature sections, and the `graph-memory-permissions.bicep` deployment in place of the previous manual Graph grant.

### Fixed

- **`serverInfo.version` no longer reports a stale `0.1.0`.** The MCP `initialize` handshake had been advertising the constant from the first release while the package moved to 0.2.x, so any host or operator reading the handshake saw the wrong version. `SERVER_VERSION` now tracks `package.json`, and a new drift check in `test/generator.test.ts` fails the build if the two diverge again. The constant is deliberately not read from disk at runtime: the container image ships `dist/`, the catalog, `generated/`, and the cast bundle but no `package.json`, so a runtime read would resolve differently in the image than in development.

[0.2.9]: https://github.com/Peter-N91/hve-squad-mcp/releases/tag/v0.2.9

## [0.2.8] - 2026-07-27

### Changed

- Bumped the package pin to `Peter-N91/hve-squad@0.10.9` and cut this release to track it.
  Run `npm run snapshot:cast` on this branch if the bundled cast changed (the cast-bundle CI check enforces it).

[0.2.8]: https://github.com/Peter-N91/hve-squad-mcp/releases/tag/v0.2.8

## [0.2.7] - 2026-07-24

### Added

- **`squad_federate` `init` now also adds a sub-squad to an existing federation** surfacing the squad's new Federation Expansion Mode. On a fresh project `init` builds a federation; on an existing federation (`federation.md` present) `init` runs Expansion — propose, confirm, seed `members/<new>/`, and register the new sub-squad in `federation.md` and `meta-routing.md`. No new tool input is needed; the delegated framed-request builder now emits build-vs-expand guidance and the catalog description is updated (`src/engine/delegated.ts`, `tools.catalog.yml`, regenerated `generated/mcp-tools.schema.json`).

### Changed

- Bumped the package pin to `Peter-N91/hve-squad@0.10.8` and refreshed the bundled cast snapshot (`host/cast/`, pinned commit `a97801f4492b2229a013276c6e5b7506e6f90625`), bringing the **Federation Expansion** contract on disk: the *Expansion: Add a Sub-Squad to an Existing Federation* section in `squad-federation.instructions.md`, the Federation Coordinator's **Expansion Mode**, and the Scribe's **Step 11** register-a-new-sub-squad step, so persona resolution and the drift check reflect the expansion behavior.

[0.2.7]: https://github.com/Peter-N91/hve-squad-mcp/releases/tag/v0.2.7

## [0.2.6] - 2026-07-24

### Added

- **`squad_federate` gains a `promote` input** surfacing the squad's new single-squad → federation promotion path. When a repository is already a single squad (a top-level `team.md`, no `federation.md`), `squad_federate` with `promote=true` runs the Federation Coordinator's **Promotion Mode** — adopting the existing squad into a federation as its first sub-squad by relocating its state tree into `members/<name>/` intact and seeding the meta layer — before routing. Plumbed through the catalog, the `CoordinatorRequest` type, the router, and the delegated framed-request builder, which now emits an explicit Promotion Mode dispatch instruction (`tools.catalog.yml`, `src/engine/coordinator-engine.ts`, `src/router/router.ts`, `src/engine/delegated.ts`, regenerated `generated/mcp-tools.schema.json`).

### Changed

- Bumped the package pin to `Peter-N91/hve-squad@0.10.7` and refreshed the bundled cast snapshot (`host/cast/`, pinned commit `34e79555085639e199555aa1a33739f78cf1c66b`), bringing the squad's **single-squad → federation promotion** contract on disk: the *Promotion: Single Squad → Federation* section in `squad-federation.instructions.md`, the Federation Coordinator's **Promotion Mode**, and the Scribe's **Step 10** relocation-and-seed step, so persona resolution and the drift check reflect the promotion behavior.

[0.2.6]: https://github.com/Peter-N91/hve-squad-mcp/releases/tag/v0.2.6

## [0.2.5] - 2026-07-24

### Changed

- Bumped the package pin to `Peter-N91/hve-squad@0.10.6` and cut this release to track it.
  Run `npm run snapshot:cast` on this branch if the bundled cast changed (the cast-bundle CI check enforces it).

[0.2.5]: https://github.com/Peter-N91/hve-squad-mcp/releases/tag/v0.2.5

## [0.2.4] - 2026-07-23

### Changed

- Bumped the bundled cast pin to `Peter-N91/hve-squad@0.10.5` and refreshed the snapshot (`host/cast/`, pinned commit `e23817890bd75230a1aa22ca7179004eb252d9fc`), bringing the squad's **Auto-mode step-completion hardening** on disk for the routing engine, persona resolution, and the drift check. The refresh adds the coordinator's **Step 7: Verify Before Responding** turn-completion checklist and **Fast-Tier Robustness** callout, the federation coordinator's two-level Step 7 verification, the autopilot **Per-Stage Advance Checklist**, and the federation-autopilot **Meta-Stage Advance and Gate-Propagation Checklist** (`squad-coordinator.agent.md`, `squad-federation-coordinator.agent.md`, `squad-autopilot.instructions.md`, `squad-federation-autopilot.instructions.md`).

### Notes

- The hardening restates the existing proof-of-dispatch and artifact-gate rules as mechanical checklists so a lighter or auto-selected model on the delegated (local VS Code) path follows every stage instead of narrating skipped work. The embedded/advisory pipeline (`squad_run`) already enforces stage completion in code, so this refresh keeps the bundled reference and drift check current rather than changing embedded runtime behavior.

[0.2.4]: https://github.com/Peter-N91/hve-squad-mcp/releases/tag/v0.2.4
## [0.2.3] - 2026-07-22

### Changed

- Bumped the package pin to `Peter-N91/hve-squad@0.10.4` and cut this release to track it.
  Run `npm run snapshot:cast` on this branch if the bundled cast changed (the cast-bundle CI check enforces it).

[0.2.3]: https://github.com/Peter-N91/hve-squad-mcp/releases/tag/v0.2.3

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
