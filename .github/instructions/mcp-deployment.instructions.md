---
description: "Mandatory post-deployment local credential persistence and Cowork v1.29 plugin compilation rules when deploying or configuring the HVE Squad MCP server"
applyTo: "{host/**,cowork/**,deploy-output/**,generators/build-cowork-*.ts,scripts/compile-cowork-plugin.ts}"
---

# MCP Server Deployment & Cowork Plugin Compilation Instructions

When deploying, updating, or configuring a live HVE Squad MCP server instance:

1. **Use gitignored local parameter and output files only:**
   - Author live Bicep parameters in `host/infra/*.local.bicepparam` (gitignored), leaving `host/infra/main.bicepparam` placeholder-only.
   - Persist the deployed HTTPS MCP endpoint (`https://<fqdn>/mcp`), Entra tenant/client IDs, Teams Developer Portal SSO `oauthReferenceId`, Azure deployment metadata, and any local CLI smoke-test tokens in `deploy-output/` (`deploy-output/mcp-deployment.local.json` and `deploy-output/mcp-credentials.local.env`).

2. **Always compile the Cowork v1.29 plugin after deployment:**
   - Validate the tracked `cowork/` skill and manifest sources first with `npm run generate:cowork:plugin:check`.
   - Run `npm run cowork:compile -- --save-config ...` (or `npm run cowork:compile` / `pwsh -NoProfile -File cowork/pack.ps1` when `deploy-output/mcp-deployment.local.json` is already populated) to generate `deploy-output/hve-squad-cowork.zip` and `deploy-output/cowork-build-receipt.json`.
   - When a delegated Entra access token is available for the deployed resource app, pass `--verify-live --bearer-token "$token"` so live `initialize` and dynamic `tools/list` discovery are recorded in `cowork-build-receipt.json`.

3. **Preserve both Cowork package tracks cleanly:**
   - `cowork/` is the primary **manifest v1.29 dynamic MCP plugin** (`hve-project-manager` + `hve-code-implement`, `mcpToolDescription` omitted so Cowork calls `tools/list` dynamically against the deployed server). Keep `<CONTAINER_APP_FQDN>` and `<OAUTH_CLIENT_REGISTRATION_ID>` placeholders intact in `cowork/manifest.json`.
   - `generated/cowork-package/` is the separate **manifest v1.28 static compatibility inventory** checked by `npm run generate:cowork:check`. Do not write live operator values into `generated/cowork-package/`.

4. **Verify Git cleanliness before finishing:**
   - Confirm `deploy-output/cowork-build-receipt.json` has `manifestVersion: "1.29"` and valid SHA-256 hashes, and verify `git status` never lists `mcp-deployment.local.json`, `mcp-credentials.local.env`, or `deploy-output/hve-squad-cowork.zip` as tracked/unignored files.
