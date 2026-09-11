---
bump: minor
type: Added
---

- **Cowork previously routed through eleven static Agent Skills and a pinned tool
  description, so server changes required a new plugin package and two copies of
  the routing truth could drift.** `cowork/manifest.json` now uses app manifest
  v1.29 as a connector-only plugin: it omits both `agentSkills` and
  `mcpToolDescription`, causing Cowork to call the server's `initialize` and
  `tools/list` methods at runtime. Optional tools now appear or disappear with the
  deployed server without regenerating or republishing the plugin.
- **Removing the pinned Cowork description would otherwise have exposed delegated
  stdio wording and dropped safety hints.** The HTTP MCP surface now projects
  truthful embedded descriptions and MCP annotations in its live `tools/list`:
  advisory and deterministic reads carry `readOnlyHint`, memory writes and batch
  sync carry `destructiveHint`, and gated runs plus rendering remain unclassified.
  `generators/build-cowork-plugin.ts`, `cowork/pack.ps1`, and CI validate that the
  package cannot regress to static skills or pinned tools.
