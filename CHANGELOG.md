# Changelog

All notable changes to the hve-squad-mcp server are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This server is a companion to the [hve-squad](https://github.com/Peter-N91/hve-squad)
APM package. Each release pins the squad cast it bundles to a specific package
version, recorded in `host/cast/package-pin.json` and enforced by
`npm run snapshot:cast`.

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
