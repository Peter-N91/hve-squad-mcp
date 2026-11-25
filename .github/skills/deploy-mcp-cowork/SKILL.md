---
name: deploy-mcp-cowork
description: "Deploy or update the HVE Squad MCP server, persist its live MCP endpoint and deployment credentials locally under deploy-output/, verify live MCP connectivity, and compile an uploadable v1.29 Microsoft 365 Copilot Cowork + Code plugin zip. USE WHEN: deploying this MCP server to Azure Container Apps or another HTTPS host, rotating or updating Entra/SSO registration IDs, saving local MCP endpoint/credential state, or compiling/packaging the Cowork plugin from the deployed server."
license: MIT
---

# Deploy MCP Server & Compile Cowork Plugin

Follow this end-to-end procedure whenever an operator asks you to deploy this MCP server, update its live deployment settings, or build a Microsoft 365 Copilot Cowork plugin for a deployed endpoint.

## Non-Negotiable Security Rules

1. **Public repository boundary:** Never write live tenant IDs, subscription IDs, app/client IDs, auth config IDs, endpoints, tokens, or `.zip` packages into tracked repository files (`host/infra/main.bicepparam`, `cowork/manifest.json`, `generated/**`, `README.md`, or commit messages).
2. **Gitignored local workspace only:** Persist all live deployment state, credential files, and compiled Cowork packages exclusively inside `deploy-output/` (which is gitignored) or a private path outside the repository.
3. **Managed identity & Key Vault in Azure:** Never bake credentials into container images or pass raw secrets as plain Bicep parameters; store secrets in Key Vault and reference them via `keyVaultSecretUris`.
4. **No secrets in plugin archives:** `manifest.json` and `hve-squad-cowork.zip` carry only the public HTTPS `/mcp` endpoint and the Teams Developer Portal `OAuthPluginVault.referenceId` (Entra SSO registration ID)—never client secrets, bearer tokens, or GitHub OAuth keys.

## Step 1 — Pre-Flight Build & Contract Validation

Before deploying or packaging, verify the server and Cowork v1.29 skill sources cleanly build and pass contract checks:

```powershell
npm run lint
npm run build
npm run generate:cowork:plugin:check
```

## Step 2 — Deploy the MCP Server (or Collect Existing Deployment Outputs)

If deploying to Azure Container Apps, follow `host/RUNBOOK.md` using a **local gitignored** `host/infra/main.local.bicepparam` (never edit tracked `host/infra/main.bicepparam` with live values):

1. Build and push the image in ACR (`az acr build --registry <ACR_NAME> --image hve-squad-mcp:<tag> --file host/Containerfile .`).
2. Deploy `host/infra/main.bicep` with `host/infra/main.local.bicepparam` (ensure `SQUAD_MCP_REMOTE_PIPELINE_ENABLED=true`, `SQUAD_MCP_ENABLE_MEMORY=true`, and `SQUAD_MCP_ENABLE_ARTIFACTS=true` are enabled when targeting Cowork project management).
3. Query the deployment outputs:
   ```powershell
   az deployment group show `
     --resource-group "<RESOURCE_GROUP>" `
     --name main `
     --query "properties.outputs.{fqdn:mcpFqdn.value, principal:appPrincipalId.value, kv:keyVaultName.value}" `
     -o json
   ```
4. Ensure the Microsoft Enterprise Token Store (`ab3be6b7-f5df-413d-ac2d-abf1e3fd9c0b`) is pre-authorized on the Entra resource app (`Squad.Run`, `Squad.Memory`, etc.), the consent redirect URI `https://teams.microsoft.com/api/platform/v1.0/oAuthConsentRedirect` is registered, and the Teams Developer Portal **Microsoft Entra SSO client ID registration** has been created (`cowork/SETUP.md` Steps 1–4) to obtain `<OAUTH_CLIENT_REGISTRATION_ID>`.
   - If `<OAUTH_CLIENT_REGISTRATION_ID>` has not been registered yet in Teams Developer Portal, ask the operator for it before compiling a live Cowork plugin.

## Step 3 — Save MCP Endpoint & Credentials Locally and Compile the Cowork Plugin

Run `npm run cowork:compile` with `--save-config` (and `--verify-live` when the server is reachable and a test bearer token is available). This atomically:
- Saves `deploy-output/mcp-deployment.local.json` with the HTTPS `/mcp` URL, `oauthReferenceId`, Entra `tenantId` / `resourceClientId`, and Azure resource metadata;
- Writes `deploy-output/mcp-credentials.local.env` (`0600` mode) if `--bearer-token` or `--operator-token` is provided for local CLI testing;
- Substitutes the live endpoint and `OAuthPluginVault.referenceId` into the v1.29 dynamic manifest (`hve-project-manager` + `hve-code-implement`, dynamic `tools/list` with `mcpToolDescription` omitted);
- Validates the manifest and all companion skill files against Cowork v1.29 limits;
- Emits `deploy-output/manifest.json`, `deploy-output/hve-squad-cowork.zip`, and `deploy-output/cowork-build-receipt.json`.

```powershell
npm run cowork:compile -- --save-config `
  --fqdn "<CONTAINER_APP_FQDN>" `
  --oauth-reference-id "<OAUTH_CLIENT_REGISTRATION_ID>" `
  --tenant-id "<ENTRA_TENANT_ID>" `
  --resource-client-id "<SQUAD_RESOURCE_CLIENT_ID>" `
  --subscription-id "<SUBSCRIPTION_ID>" `
  --resource-group "<RESOURCE_GROUP>" `
  --container-app-name "<CONTAINER_APP_NAME>" `
  --key-vault-name "<KEY_VAULT_NAME>" `
  --managed-identity-principal-id "<MANAGED_IDENTITY_PRINCIPAL_ID>"
```

To also verify live `initialize` + `tools/list` discovery against the deployed server during compilation:

```powershell
$token = az account get-access-token --resource "api://<SQUAD_RESOURCE_CLIENT_ID>" --query accessToken -o tsv
npm run cowork:compile -- --verify-live --bearer-token "$token"
```

On subsequent rebuilds (after updating skills or bumping `packageVersion`), recompile directly from the saved local config without re-entering flags:

```powershell
npm run cowork:compile
# or:
pwsh -NoProfile -File cowork/pack.ps1
```

## Step 4 — Post-Compile Verification & Operator Handoff

1. Confirm `deploy-output/cowork-build-receipt.json` exists, `manifestVersion` is `"1.29"`, no `<PLACEHOLDER>` tokens remain, and `git status --short` shows **no** live deployment files staged or untracked.
2. Report to the operator:
   - Saved local config path: `deploy-output/mcp-deployment.local.json`
   - Compiled Cowork plugin archive: `deploy-output/hve-squad-cowork.zip` (with byte size and `zipSha256`)
   - Live MCP verification status (whether `initialize` + `tools/list` was verified or needs interactive Entra consent)
   - Upload step: **Microsoft 365 Copilot Cowork → Customize → Plugins → Upload plugin** → select `deploy-output/hve-squad-cowork.zip`.
