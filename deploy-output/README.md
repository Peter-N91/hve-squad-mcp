# Local MCP Deployment & Compiled Cowork Plugin Output

This directory (`deploy-output/`) is the local, **gitignored** output workspace
for live MCP server deployments and compiled Microsoft 365 Copilot Cowork
plugins.

> **Public repository boundary:** Everything in `deploy-output/` except this
> `README.md`, `.gitkeep`, and `mcp-deployment.example.json` is ignored by Git.
> Never force-add (`git add -f`) live endpoints, tenant/client IDs, auth config
> IDs, tokens, or compiled `.zip` packages.

## Files Written Here After Deployment

| File | Purpose | Tracked in Git? |
| --- | --- | --- |
| `mcp-deployment.example.json` | Placeholder schema showing the local deployment record shape | Yes |
| `mcp-deployment.local.json` | Saved live MCP endpoint, Entra/OAuth registration IDs, Azure deployment metadata, and local credential references | **No (gitignored)** |
| `mcp-credentials.local.env` | Optional local environment/credential file (`0600` permissions on POSIX) for CLI smoke tests or operator approvals | **No (gitignored)** |
| `manifest.json` | Substituted v1.29 Cowork manifest matching the compiled plugin | **No (gitignored)** |
| `hve-squad-cowork.zip` | Uploadable v1.29 dynamic Cowork + Code plugin (`hve-project-manager` + `hve-code-implement` + dynamic `remoteMcpServer`) | **No (gitignored)** |
| `cowork-build-receipt.json` | SHA-256 integrity receipt of the compiled `.zip`, packaged entries, and target MCP server URL | **No (gitignored)** |

## Workflow

1. **Validate the tracked `cowork/` v1.29 plugin sources:**
   ```powershell
   npm run generate:cowork:plugin:check
   ```

2. **Save deployment config locally and compile the Cowork plugin:**
   ```powershell
   npm run cowork:compile -- --save-config `
     --mcp-server-url "https://<your-aca-fqdn>/mcp" `
     --oauth-reference-id "<teams-sso-auth-config-id>" `
     --tenant-id "<entra-tenant-id>" `
     --resource-client-id "<entra-resource-app-client-id>"
   ```

3. **Re-compile later from the saved local config (`deploy-output/mcp-deployment.local.json`):**
   ```powershell
   npm run cowork:compile
   ```
   Or via PowerShell:
   ```powershell
   pwsh -NoProfile -File cowork/pack.ps1
   ```

4. **Upload in Cowork:**
   Open **Cowork → Customize → Plugins → Upload plugin** and select
   `deploy-output/hve-squad-cowork.zip`.
