using './main.bicep'

// Every deployment detail lives here. The CI/CD workflow
// (.github/workflows/azure-infra.yml) deploys this file as-is and passes nothing on
// the command line; the only values it injects arrive through the environment
// variables read below (the image tag it built, the deployment phase, and the
// optional encryption key from a GitHub secret).
//
// Replace every <PLACEHOLDER> before the first deployment. The workflow refuses to
// run what-if or deploy while a placeholder remains. None of these values is a
// secret; the model token comes from managed identity at runtime (SEC-10).

// ─── Tenant + resource-server identity (RUNBOOK Step 2) ──────────────────────
// The Entra app registration created by host/infra/bootstrap/Initialize-AzureCicd.ps1
// (its apiClientId output).
var entraTenantId = '<ENTRA_TENANT_ID>'
var apiClientId = '<ENTRA_CLIENT_ID>'
var entraIssuer = 'https://login.microsoftonline.com/${entraTenantId}/v2.0'

param namePrefix = 'squadmcp'
param tags = {
  workload: 'hve-squad-mcp'
  managedBy: 'bicep'
}

// ─── Image (RUNBOOK Step 5) ──────────────────────────────────────────────────
// The registry is provisioned by this template. CI builds the image into it and
// sets CONTAINER_IMAGE_TAG to the commit SHA; a manual run falls back to 'latest'.
param imageRepository = 'hve-squad-mcp'
param containerImageTag = readEnvironmentVariable('CONTAINER_IMAGE_TAG', 'latest')
param containerRegistrySku = 'Basic'

// Phase 1 (DEPLOY_APPLICATION=false) deploys the foundation so the image can be
// built before the Container App references it; phase 2 deploys everything.
param deployApplication = bool(readEnvironmentVariable('DEPLOY_APPLICATION', 'true'))

// ─── Entra auth (SEC-1 / SEC-2) ──────────────────────────────────────────────
param authClientId = apiClientId
param authOpenIdIssuer = entraIssuer

param squad = {
  audience: 'api://${apiClientId}'
  allowedOrigins: 'https://copilotstudio.microsoft.com' // SEC-8: strict, never '*'
  allowedIssuers: entraIssuer
  allowedTenants: entraTenantId
  jwksUri: 'https://login.microsoftonline.com/${entraTenantId}/discovery/v2.0/keys'
  tenantConcurrency: 4 // SEC-9 / COST-1
  tenantCostCeilingUsd: 500 // COST-2 (hard per-tenant monthly ceiling)
}

// ─── Azure OpenAI (RUNBOOK Steps 3 + 7) ──────────────────────────────────────
// create: true provisions the account (key auth disabled) and the deployment;
// create: false reuses an account of that name in the same resource group. Either
// way the app identity is granted Cognitive Services OpenAI User on it, and the
// endpoint + allow-list (SEC-3) are derived from it.
param openAi = {
  create: true
  name: 'squadmcp-aoai' // globally unique custom subdomain -> https://<name>.openai.azure.com
  // location: 'swedencentral' // uncomment when the model is not offered in the resource group region
  deploymentName: 'gpt-4o'
  modelName: 'gpt-4o'
  modelVersion: '2024-11-20'
  skuName: 'GlobalStandard'
  capacity: 10
  apiVersion: '2024-10-21'
}

// ─── Scale + cost (COST-2 / COST-3) ──────────────────────────────────────────
param minReplicas = 0
param maxReplicas = 5
param budgetAmountUsd = 500
// A NEW budget must start in the current month or up to 12 months ahead, and the
// start date of an existing budget should not be changed afterwards.
param budgetStartDate = '2026-10-01'
param budgetAlertEmails = [
  '<ALERT_EMAIL>'
]

// Optional features. Each is off by default; the server's own config validation
// fails fast at boot when a feature is on but its prerequisites are missing.

// The gated async pipeline (squad_run / squad_federate / squad_status) plus the
// background worker that drives long runs off the request path.
param enableRemotePipeline = false
param enableWorker = false

// AES-256-GCM key for request/context (and table memory) at rest. Never commit it:
// CI reads it from the SQUAD_MCP_RUN_ENCRYPTION_KEY_B64 GitHub secret. Empty keeps
// platform-only at-rest encryption.
param runEncryptionKeyBase64 = readEnvironmentVariable('SQUAD_MCP_RUN_ENCRYPTION_KEY_B64', '')

// The shared-state squad-memory broker.
//   memoryBackend 'table' — Azure Table Storage on the account this template
//     provisions (cross-replica ETag CAS).
//   memoryBackend 'graph' — a SharePoint document library / OneDrive drive. Set
//     memoryGraphDriveId, then run graph-memory-permissions.bicep to grant the
//     app identity Sites.Selected plus a write grant on that one site.
param enableMemory = false
param memoryBackend = 'table'
param memoryGraphDriveId = ''
param memoryGraphRootPath = 'squad-memory'

// Read and write memory automatically around every dispatch, so continuity does
// not depend on the calling agent remembering to call the memory tools.
param enableMemoryAuto = false
param memoryDefaultProject = 'default'

// Offer several destinations and let the caller pick one BY NAME. You own every
// credential-bearing field; the caller only ever sees the name.
// param memoryTargets = '[{"name":"azure","backend":"table"},{"name":"sharepoint","backend":"graph","driveId":"<DRIVE_ID>","rootPath":"squad-memory"}]'
// param memoryDefaultTarget = 'azure'

// The business-facing tools (squad_business_plan, squad_backlog).
param enableBusinessTools = false