using './main.bicep'

// Keep environment-specific values in this file. The workflow overrides only
// imageTag so every deployment is pinned to the image built for that run.
// No secret belongs here; runtime access uses managed identity.

param location = '<AZURE_REGION>'
param namePrefix = 'squadmcp'

param containerRegistryName = '<REGISTRY>'
param imageRepository = 'hve-squad-mcp'
param imageTag = 'latest'
param containerRegistrySkuName = 'Basic'
param azureOpenAiAccountName = '<AOAI_RESOURCE>'

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
param httpConcurrentRequests = '20'
param containerCpu = '0.5'
param containerMemory = '1Gi'

param budgetAmountUsd = 500
param budgetStartDate = '2026-09-01'
param budgetAlertEmails = [
  '<ALERT_EMAIL>'
]
param budgetAlertThresholds = [
  70
  90
  100
]

param logRetentionDays = 30
param keyVaultSoftDeleteRetentionDays = 90
param keyVaultEnablePurgeProtection = true
param storageSkuName = 'Standard_LRS'

param roleDefinitionIds = {
  acrPull: '7f951dda-4ed3-4680-a7ca-43fe172d538d'
  azureOpenAiUser: '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'
  keyVaultSecretsUser: '4633458b-17de-408a-b874-0445c86b69e6'
  storageBlobDataContributor: 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
  storageTableDataContributor: '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'
}

// Optional features. The server fails fast when an enabled feature is missing a
// prerequisite, so there is no silent fallback to a less secure configuration.
param enableRemotePipeline = false
param enableWorker = false
param runTableName = 'squadruns'
param runEncryptionKeyBase64 = ''
param workerCron = '*/5 * * * *'
param workerReplicaTimeout = 1800
param workerReplicaRetryLimit = 1

param enableRenderPptx = false
param renderBlobContainer = 'renders'
param renderSasTtlMinutes = 60
param renderBrandTemplatePath = ''

param enableMemory = false
param memoryBackend = 'table'
param memoryTableName = 'squadmemory'
param enableMemoryAuto = false
param memoryDefaultProject = 'default'
param enableArtifacts = false
param enableAdvisoryAutopilot = false

param memoryGraphDriveId = ''
param memoryGraphRootPath = 'squad-memory'
param memoryGraphEndpoint = ''
param memoryGraphEncrypt = false
param memoryTargets = ''
param memoryDefaultTarget = ''

param enableMemoryOverflow = false
param memoryOverflowContainer = 'squadmemory'

param enableBusinessTools = false
