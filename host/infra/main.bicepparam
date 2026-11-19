using './main.bicep'

// Local / manual-deploy template. Replace every <PLACEHOLDER> with your tenant's
// values before deploying (copy to an uncommitted main.local.bicepparam). CI/CD
// deploys use environments/prod.bicepparam, which reads every value from
// environment variables instead (see environments/README.md).
// No secret belongs here — the model token comes from managed identity at runtime.

param containerImage = '<REGISTRY>.azurecr.io/hve-squad-mcp:latest'
param containerRegistryServer = '<REGISTRY>.azurecr.io'
param authClientId = '<ENTRA_CLIENT_ID>'
param authOpenIdIssuer = 'https://login.microsoftonline.com/<ENTRA_TENANT_ID>/v2.0'

param squad = {
  // v2 access tokens (bootstrap/entra-app.bicep sets requestedAccessTokenVersion 2)
  // carry the app's client id GUID in `aud`, and the server compares `aud` by exact
  // match (src/auth/entra.ts). So the audience is the bare appId GUID — the
  // entra-app `tokenAudience` output. An environment still on a v1-token app
  // registration keeps its own 'api://<ENTRA_CLIENT_ID>' value here.
  audience: '<ENTRA_CLIENT_ID>'
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
// Budget start date. Leave unset for the FIRST deployment (defaults to the first
// day of the current UTC month). Azure rejects any change to an existing budget's
// start date, so after the first deployment pin the date it was created with:
//   az resource show --ids <rg-id>/providers/Microsoft.Consumption/budgets/<namePrefix>-budget \
//     --query properties.timePeriod.startDate -o tsv    # e.g. 2026-07-01T00:00:00Z
// An environment first deployed from an earlier version of this file pins '2026-07-01'.
// param budgetStartDate = '<YYYY-MM>-01'
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

// Role assignments this template can manage for the app identity. Both default
// false so an environment that already granted them by hand sees NO new role
// assignment. A NEW environment sets both true (and sets containerRegistryResourceId
// / openAiAccountName). An EXISTING environment follows the RUNBOOK migration:
// delete the manual grant first, then flip the flag.
param manageAcrPullAssignment = false
param manageOpenAiRoleAssignment = false
// param containerRegistryResourceId = '/subscriptions/<SUB_ID>/resourceGroups/<ACR_RG>/providers/Microsoft.ContainerRegistry/registries/<REGISTRY>'
// param openAiAccountName = '<AOAI_RESOURCE>'
// param openAiResourceGroupName = '<AOAI_RG>'

// Azure OpenAI: 'existing' keeps squad.modelEndpoint / squad.modelDeployment as-is
// (no new resource, no spend). 'create' provisions the account + deployments —
// real per-token spend (K1: indicative default GlobalStandard, capacity 10; the
// $500 budget above may not cover it). See tests/fixtures/create.bicepparam.
param openAiMode = 'existing'

// The run-encryption key is NEVER set here. CI supplies it from a secret, e.g.
//   --parameters runEncryptionKeyBase64="$SQUAD_INFRA_RUN_ENCRYPTION_KEY_B64"
// or an uncommitted *.local.bicepparam uses
//   param runEncryptionKeyBase64 = readEnvironmentVariable('SQUAD_INFRA_RUN_ENCRYPTION_KEY_B64', '')
