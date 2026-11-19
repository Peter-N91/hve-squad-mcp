using '../../main.bicep'

// Build-params fixture (A9). Dummy, non-secret values only: every id below is a
// documentation placeholder, never a real tenant, subscription, or principal.

param containerImage = 'squadfixture.azurecr.io/hve-squad-mcp:fixture'
param containerRegistryServer = 'squadfixture.azurecr.io'
param authClientId = '11111111-1111-1111-1111-111111111111'
param authOpenIdIssuer = 'https://login.microsoftonline.com/22222222-2222-2222-2222-222222222222/v2.0'

param squad = {
  audience: 'api://11111111-1111-1111-1111-111111111111'
  allowedOrigins: 'https://copilotstudio.microsoft.com'
  allowedIssuers: 'https://login.microsoftonline.com/22222222-2222-2222-2222-222222222222/v2.0'
  allowedTenants: '22222222-2222-2222-2222-222222222222'
  jwksUri: 'https://login.microsoftonline.com/22222222-2222-2222-2222-222222222222/discovery/v2.0/keys'
  modelEndpoint: 'https://squadfixture-aoai.openai.azure.com'
  allowedModelEndpoints: 'https://squadfixture-aoai.openai.azure.com'
  modelDeployment: 'gpt-4o'
  modelApiVersion: '2024-10-21'
  tenantConcurrency: 4
  tenantCostCeilingUsd: 500
}

param minReplicas = 0
param maxReplicas = 5
param budgetAmountUsd = 500
param budgetStartDate = '2026-07-01'
param budgetAlertEmails = [
  'alerts@example.com'
]
// Every enable* flag on, both manage* flags on. The encryption key is read from
// the environment only (security C8); the validation harness sets a dummy,
// well-formed, non-secret value.
param enableRemotePipeline = true
param enableWorker = true
param enableRenderPptx = true
param enableMemory = true
param memoryBackend = 'table'
param enableMemoryAuto = true
param enableArtifacts = true
param enableAdvisoryAutopilot = true
param enableMemoryOverflow = true
param enableBusinessTools = true
param runEncryptionKeyBase64 = readEnvironmentVariable('SQUAD_INFRA_RUN_ENCRYPTION_KEY_B64', '')
param openAiMode = 'existing'
param openAiAccountName = 'squadfixture-aoai'
param containerRegistryResourceId = '/subscriptions/33333333-3333-3333-3333-333333333333/resourceGroups/rg-squadmcp-fixture/providers/Microsoft.ContainerRegistry/registries/squadfixture'
param manageAcrPullAssignment = true
param manageOpenAiRoleAssignment = true