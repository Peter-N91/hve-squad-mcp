using './main.bicep'

// Replace every <PLACEHOLDER> with your tenant's values before deploying.
// No secret belongs here — the model token comes from managed identity at runtime.
// Keep this committed file placeholder-only. Copy to a private operator workspace
// before replacing values. Do not commit a filled-in parameter file.

param containerImage = '<REGISTRY>.azurecr.io/hve-squad-mcp:latest'
param containerRegistryServer = '<REGISTRY>.azurecr.io'
param authClientId = '<ENTRA_CLIENT_ID>'
param authOpenIdIssuer = 'https://login.microsoftonline.com/<ENTRA_TENANT_ID>/v2.0'

param squad = {
  audience: 'api://<ENTRA_CLIENT_ID>'
  allowedOrigins: 'https://copilotstudio.microsoft.com'
  allowedIssuers: 'https://login.microsoftonline.com/<ENTRA_TENANT_ID>/v2.0'
  allowedTenants: '<ENTRA_TENANT_ID>'
  jwksUri: 'https://login.microsoftonline.com/<ENTRA_TENANT_ID>/discovery/v2.0/keys'
  modelEndpoint: 'https://<AOAI_RESOURCE>.openai.azure.com'
  allowedModelEndpoints: 'https://<AOAI_RESOURCE>.openai.azure.com'
  modelDeployment: '<AOAI_DEPLOYMENT>'
  modelApiVersion: '2024-10-21'
  tenantConcurrency: 4
  tenantCostCeilingUsd: 500
}

param minReplicas = 0
param maxReplicas = 5
param budgetAmountUsd = 500
// The template defaults the budget start to the current month's first day.
param budgetAlertEmails = [
  '<ALERT_EMAIL>'
]

// Optional features. Each is off by default; the server's own config validation
// fails fast at boot when a feature is on but its prerequisites are missing.

// The gated async pipeline (squad_run / squad_federate / squad_status) plus the
// background worker that drives long runs off the request path.
param enableRemotePipeline = false
param enableWorker = false

// Both hosts may share one audience. Add ONLY aliases of the SAME resource app.
// Client IDs must be listed for EVERY accepted aud, even when both hosts use it.
param additionalAudiences = []
param allowedClientsJson = ''
// Example shape (replace privately):
// '{"api://<RESOURCE_APP_ID>":["<STUDIO_CONNECTOR_CLIENT_ID>","<COWORK_CALLING_CLIENT_ID>"]}'

// Per-user mode is opt-in. Prerequisites: copilot + pipeline + worker + table
// memory + auto-memory + artifacts, explicit tenant/issuer/client restrictions,
// separate Key Vault-backed run and credential encryption keys, exact callbacks.
// First production per-user scope: exactly ONE squad.allowedTenants entry,
// matching linkEntraTenantId. Guest users resolve to their resource-tenant oid.
// Any Microsoft 365 Organization auth-config reach does not widen server scope.
// Follow docs/reference/per-user-github.md before enabling any of these.
param enablePerUserGithub = false
param publicBaseUrl = ''
param githubClientId = ''
param githubWebBaseUrl = 'https://github.com'
param githubApiBaseUrl = 'https://api.github.com'
param linkEntraClientId = ''
param linkEntraTenantId = ''
param githubClientSecretUri = ''
param linkEntraClientSecretUri = ''
param githubLinkKeySecretUri = ''
param githubLinkKeyId = 'current'
param githubLinkOldKeysSecretUri = ''
param runEncryptionKeySecretUri = ''
param githubLinkTableName = 'squadgithublinks'
param githubLinkFlowTableName = 'squadgithublinkflows'

// External headless SDK runtimes are NOT deployed by this template. Each is
// authenticated and privately reachable. A single SDK client owns each runtime's
// filesystem, so the template pins the Copilot web app to ONE replica.
param stageExecutor = 'builtin'
param copilotCliUrl = ''
param workerCopilotCliUrl = '' // REQUIRED DISTINCT endpoint when a Copilot worker is enabled
param copilotConnectionTokenSecretUri = ''
param copilotGithubTokenSecretUri = '' // shared-token legacy mode only; NEVER per-user fallback
param copilotModel = ''
param copilotRouting = 'off'
param upstreamRuntimeEnabled = true
param copilotTools = ''
param copilotSubagents = true
param copilotAllowShell = true
param copilotAllowedHosts = ''
param copilotSandboxWorkspace = '/workspace'
param copilotIdentityReverifyMs = 600000
// Register this existing AzureFile binding on <prefix>-env separately. ACA rejects
// a Copilot deployment without that binding. No storage key is handled here.
param copilotSessionStorageName = 'copilot-sessions'
param copilotSessionStateDir = '/mnt/copilot-sessions'
// Must exceed the worker's 45-minute timeout plus cleanup. Never launch overlapping
// scheduled/manual executions against one worker runtime. Retries are off for Copilot.
param copilotWorkerCron = '0 * * * *'
// >=2700s: upstream deadline is 2100s (35min), server lease is 2400s (40min).
param workerReplicaTimeoutSeconds = 2700

// The shared-state squad-memory broker.
//   memoryBackend 'table' — Azure Table Storage on the account this template
//     provisions (cross-replica ETag CAS).
//   memoryBackend 'graph' — a SharePoint document library / OneDrive drive. Set
//     memoryGraphDriveId, then run graph-memory-permissions.bicep to grant the
//     app identity Sites.Selected plus a write grant on that one site.
// Graph uses the application's managed identity, NOT delegated user access.
// It and graph entries in memoryTargets are prohibited in per-user mode.
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
