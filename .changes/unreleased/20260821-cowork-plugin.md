---
bump: minor
type: Added
---

- **Nothing targeted Microsoft Copilot Cowork, and the multi-agent Copilot Studio
  package could not be ported to it.** `cowork/` is a new, uploadable Cowork
  plugin: one dispatcher skill (`hve-squad-orchestrator`) plus ten stage skills
  that hand off to each other in prose, backed by the server as a single
  `remoteMcpServer` connector describing all fourteen tools. Cowork has no
  sub-agents (`agents/` is unsupported in the M365 manifest), so the parent/child
  topology of `copilot-studio/` is projected as skill-to-skill handoff — routing
  becomes advisory rather than enforced, and `cowork/README.md` records exactly
  what that costs.
- **A Cowork package that breaks a packaging rule fails at upload with an opaque
  HTTP 400.** `npm run generate:cowork` emits the required `mcpToolDescription`
  file from `tools.catalog.yml` and validates every authored skill against the
  ASKILL rules — folder/`name` match, kebab-case, description length, body size,
  companion-file limits, and manifest references — so the failure surfaces at
  build time instead. `generate:cowork:check` runs in CI
  (`generators/build-cowork-plugin.ts`, `.github/workflows/ci.yml`).
- **Tool descriptors now carry MCP annotations.** Advisory and deterministic-read
  tools are marked `readOnlyHint`; the memory writers are marked
  `destructiveHint`; the gated catch-alls `squad_run` and `squad_federate` are
  marked as neither, because they allocate durable run state and can hold at the
  Human Gate. This is forward-compatible with Cowork's annotation-driven
  confirmation rollout for non-Microsoft MCP servers.
