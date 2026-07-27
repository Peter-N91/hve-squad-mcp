using './main.bicep'

// Replace every <PLACEHOLDER> with your tenant's values before deploying.
// No secret belongs here — the model token comes from managed identity at runtime.

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
param budgetStartDate = '2026-07-01'
param budgetAlertEmails = [
  '<ALERT_EMAIL>'
]

// Optional features. Each is off by default; the server's own config validation
// fails fast at boot when a feature is on but its prerequisites are missing.

// The gated async pipeline (squad_run / squad_federate / squad_status) plus the
// background worker that drives long runs off the request path.
param enableRemotePipeline = false
param enableWorker = false

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
