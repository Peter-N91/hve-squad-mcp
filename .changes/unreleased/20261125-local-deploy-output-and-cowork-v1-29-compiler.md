---
bump: minor
type: Added
---

- **Added the v1.29 dynamic Microsoft 365 Copilot Cowork + Code plugin (`cowork/`), local `deploy-output/` workspace, and post-deployment Cowork compiler (`npm run cowork:compile`).** Agents deploying the MCP server now follow `.github/skills/deploy-mcp-cowork/SKILL.md` and `.github/instructions/mcp-deployment.instructions.md` (referenced from `.github/copilot-instructions.md`) to persist live MCP endpoints and credential references locally in gitignored `deploy-output/` (`mcp-deployment.local.json`, `mcp-credentials.local.env`) while refusing tracked repository paths, optionally verify live `initialize` + `tools/list` discovery, and compile an uploadable v1.29 `deploy-output/hve-squad-cowork.zip` (`generators/build-cowork-plugin.ts`, `scripts/compile-cowork-plugin.ts`, `cowork/pack.ps1`).
