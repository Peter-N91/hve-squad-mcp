// hve-squad MCP server — Azure Container Apps orchestration template.
//
// Environment-specific values live in main.bicepparam. Every deployed resource
// is implemented by a module under modules/ so this file only composes the graph.

@description('Squad MCP application and security configuration.')
type SquadConfig = {
  audience: string
  allowedOrigins: string
  allowedIssuers: string
  allowedTenants: string
  jwksUri: string
  modelEndpoint: string
  allowedModelEndpoints: string
  modelDeployment: string
  modelApiVersion: string
  tenantConcurrency: int
  tenantCostCeilingUsd: int
}

@description('Azure RBAC role definition ids used by the deployment.')
type RoleDefinitionIds = {
  acrPull: string
  azureOpenAiUser: string
  keyVaultSecretsUser: string
  storageBlobDataContributor: string
  storageTableDataContributor: string
}

@description('Azure region for all resources.')
param location string

@description('Short prefix for resource names.')
@minLength(3)
@maxLength(12)
param namePrefix string

@description('Existing Azure Container Registry name.')
param containerRegistryName string

@description('Container image repository within Azure Container Registry.')
param imageRepository string

@description('Container image tag.')
param imageTag string

@description('Azure Container Registry SKU.')
param containerRegistrySkuName string

@description('Existing Azure OpenAI account name.')
param azureOpenAiAccountName string

@description('Entra application client id for Container Apps authentication.')
param authClientId string

@description('Entra OpenID issuer URL for Container Apps authentication.')
param authOpenIdIssuer string

@description('Squad MCP application configuration.')
param squad SquadConfig

@description('Minimum Container App replicas.')
@minValue(0)
@maxValue(5)
param minReplicas int

@description('Maximum Container App replicas.')
@minValue(1)
@maxValue(30)
param maxReplicas int

@description('Maximum concurrent HTTP requests per replica.')
param httpConcurrentRequests string

@description('Container CPU allocation.')
param containerCpu string

@description('Container memory allocation.')
param containerMemory string

@description('Monthly resource-group budget in USD.')
param budgetAmountUsd int

@description('First day of the budget month.')
param budgetStartDate string

@description('Budget alert email recipients.')
param budgetAlertEmails array

@description('Budget notification thresholds.')
@minLength(3)
@maxLength(3)
param budgetAlertThresholds array

@description('Log Analytics retention in days.')
@minValue(30)
@maxValue(730)
param logRetentionDays int

@description('Key Vault soft-delete retention in days.')
@minValue(7)
@maxValue(90)
param keyVaultSoftDeleteRetentionDays int

@description('Enable Key Vault purge protection.')
param keyVaultEnablePurgeProtection bool

@description('Azure RBAC role definition ids.')
param roleDefinitionIds RoleDefinitionIds

@description('Enable the gated asynchronous pipeline.')
param enableRemotePipeline bool

@description('Deploy the scheduled background worker.')
param enableWorker bool

@description('Azure Table name for asynchronous run records.')
param runTableName string

@description('Base64-encoded 32-byte AES-256-GCM key. Empty uses platform encryption only.')
@secure()
param runEncryptionKeyBase64 string

@description('Worker cron schedule.')
param workerCron string

@description('Maximum worker execution time in seconds.')
param workerReplicaTimeout int

@description('Maximum worker retry count.')
param workerReplicaRetryLimit int

@description('Enable deterministic PowerPoint rendering.')
param enableRenderPptx bool

@description('Private Blob container for rendered decks.')
param renderBlobContainer string

@description('Rendered-deck SAS lifetime in minutes.')
@minValue(5)
@maxValue(1440)
param renderSasTtlMinutes int

@description('Optional brand template path inside the image.')
param renderBrandTemplatePath string

@description('Enable the shared-state memory broker.')
param enableMemory bool

@description('Memory persistence backend.')
@allowed([
  'table'
  'graph'
])
param memoryBackend string

@description('Azure Table name for memory entries.')
param memoryTableName string

@description('Automatically read and write memory around each dispatch.')
param enableMemoryAuto bool

@description('Default memory project partition.')
param memoryDefaultProject string

@description('Persist the squad ledger through the selected memory backend.')
param enableArtifacts bool

@description('Allow server-proven advisory runs to pass the human gate.')
param enableAdvisoryAutopilot bool

@description('SharePoint or OneDrive drive id for graph memory.')
param memoryGraphDriveId string

@description('Root folder for graph memory.')
param memoryGraphRootPath string

@description('Optional Microsoft Graph endpoint override.')
param memoryGraphEndpoint string

@description('Encrypt memory content on the graph backend.')
param memoryGraphEncrypt bool

@description('JSON array of operator-declared memory destinations.')
param memoryTargets string

@description('Default named memory destination.')
param memoryDefaultTarget string

@description('Enable Blob overflow for large memory entries.')
param enableMemoryOverflow bool

@description('Private Blob container for memory overflow.')
param memoryOverflowContainer string

@description('Enable advisory business-facing tools.')
param enableBusinessTools bool

@description('Storage account SKU.')
param storageSkuName string

var containerRegistryServer = '${containerRegistryName}.azurecr.io'
var containerImage = '${containerRegistryServer}/${imageRepository}:${imageTag}'
var storageAccountName = toLower(take('${namePrefix}st${uniqueString(resourceGroup().id)}', 24))
var enableMemoryTable = enableMemory && memoryBackend == 'table'
var enableTableStorage = enableRemotePipeline || enableMemoryTable
var enableBlobStorage = enableRenderPptx || enableMemoryOverflow
var enableStorage = enableTableStorage || enableBlobStorage
var runEncryptionEnvironmentVariable = format('{0}_{1}', 'SQUAD_MCP_RUN_ENCRYPTION_KEY', 'B64')

var storageEnv = enableStorage ? [
      {
        name: 'SQUAD_MCP_STORAGE_ACCOUNT'
        value: storageAccountName
      }
    ] : []

var pipelineEnv = enableRemotePipeline ? [
      {
        name: 'SQUAD_MCP_REMOTE_PIPELINE_ENABLED'
        value: 'true'
      }
      {
        name: 'SQUAD_MCP_RUN_STATE_BACKEND'
        value: 'table'
      }
      {
        name: 'SQUAD_MCP_RUN_TABLE_NAME'
        value: runTableName
      }
      {
        name: 'SQUAD_MCP_WORKER_ENABLED'
        value: string(enableWorker)
      }
    ] : []

var encryptionSecrets = !empty(runEncryptionKeyBase64) ? [
      {
        name: 'run-key'
        value: runEncryptionKeyBase64
      }
    ] : []

var encryptionEnv = (enableRemotePipeline && !empty(runEncryptionKeyBase64)) ? [
      {
        name: runEncryptionEnvironmentVariable
        secretRef: 'run-key'
      }
    ] : []

var renderEnv = enableRenderPptx ? [
      {
        name: 'SQUAD_MCP_ENABLE_RENDER_PPTX'
        value: 'true'
      }
      {
        name: 'SQUAD_MCP_RENDER_BLOB_CONTAINER'
        value: renderBlobContainer
      }
      {
        name: 'SQUAD_MCP_RENDER_SAS_TTL_MINUTES'
        value: string(renderSasTtlMinutes)
      }
      {
        name: 'SQUAD_MCP_RENDER_BRAND_TEMPLATE_PATH'
        value: renderBrandTemplatePath
      }
    ] : []

var memoryGraphEnv = (enableMemory && memoryBackend == 'graph') ? [
      {
        name: 'SQUAD_MCP_MEMORY_GRAPH_DRIVE_ID'
        value: memoryGraphDriveId
      }
      {
        name: 'SQUAD_MCP_MEMORY_GRAPH_ROOT_PATH'
        value: memoryGraphRootPath
      }
      {
        name: 'SQUAD_MCP_MEMORY_GRAPH_ENDPOINT'
        value: memoryGraphEndpoint
      }
      {
        name: 'SQUAD_MCP_MEMORY_GRAPH_ENCRYPT'
        value: string(memoryGraphEncrypt)
      }
    ] : []

var memoryTargetsEnv = (enableMemory && !empty(memoryTargets)) ? [
      {
        name: 'SQUAD_MCP_MEMORY_TARGETS'
        value: memoryTargets
      }
      {
        name: 'SQUAD_MCP_MEMORY_DEFAULT_TARGET'
        value: memoryDefaultTarget
      }
    ] : []

var memoryOverflowEnv = enableMemoryOverflow ? [
      {
        name: 'SQUAD_MCP_MEMORY_OVERFLOW_ENABLED'
        value: 'true'
      }
      {
        name: 'SQUAD_MCP_MEMORY_OVERFLOW_CONTAINER'
        value: memoryOverflowContainer
      }
    ] : []

var memoryEnv = enableMemory ? concat([
        {
          name: 'SQUAD_MCP_ENABLE_MEMORY'
          value: 'true'
        }
        {
          name: 'SQUAD_MCP_MEMORY_BACKEND'
          value: memoryBackend
        }
        {
          name: 'SQUAD_MCP_MEMORY_TABLE_NAME'
          value: memoryTableName
        }
        {
          name: 'SQUAD_MCP_MEMORY_AUTO_ENABLED'
          value: string(enableMemoryAuto)
        }
        {
          name: 'SQUAD_MCP_MEMORY_DEFAULT_PROJECT'
          value: memoryDefaultProject
        }
    ], memoryGraphEnv, memoryTargetsEnv, memoryOverflowEnv) : []

var artifactsEnv = (enableMemory && enableMemoryAuto && enableArtifacts) ? [
      {
        name: 'SQUAD_MCP_ENABLE_ARTIFACTS'
        value: 'true'
      }
    ] : []

var advisoryAutopilotEnv = (enableRemotePipeline && enableAdvisoryAutopilot) ? [
      {
        name: 'SQUAD_MCP_ADVISORY_AUTOPILOT_ENABLED'
        value: 'true'
      }
    ] : []

var memoryEncryptionEnv = (enableMemory && !enableRemotePipeline && !empty(runEncryptionKeyBase64)) ? [
      {
        name: runEncryptionEnvironmentVariable
        secretRef: 'run-key'
      }
    ] : []

var businessEnv = enableBusinessTools ? [
      {
        name: 'SQUAD_MCP_ENABLE_BUSINESS_TOOLS'
        value: 'true'
      }
    ] : []

var webBaseEnv = [
  {
    name: 'PORT'
    value: '3000'
  }
  {
    name: 'SQUAD_MCP_AUDIENCE'
    value: squad.audience
  }
  {
    name: 'SQUAD_MCP_ALLOWED_ORIGINS'
    value: squad.allowedOrigins
  }
  {
    name: 'SQUAD_MCP_ALLOWED_ISSUERS'
    value: squad.allowedIssuers
  }
  {
    name: 'SQUAD_MCP_ALLOWED_TENANTS'
    value: squad.allowedTenants
  }
  {
    name: 'SQUAD_MCP_JWKS_URI'
    value: squad.jwksUri
  }
  {
    name: 'SQUAD_MCP_MODEL_ENDPOINT'
    value: squad.modelEndpoint
  }
  {
    name: 'SQUAD_MCP_ALLOWED_MODEL_ENDPOINTS'
    value: squad.allowedModelEndpoints
  }
  {
    name: 'SQUAD_MCP_MODEL_DEPLOYMENT'
    value: squad.modelDeployment
  }
  {
    name: 'SQUAD_MCP_MODEL_API_VERSION'
    value: squad.modelApiVersion
  }
  {
    name: 'SQUAD_MCP_TENANT_CONCURRENCY'
    value: string(squad.tenantConcurrency)
  }
  {
    name: 'SQUAD_MCP_TENANT_COST_CEILING_USD'
    value: string(squad.tenantCostCeilingUsd)
  }
]

module logAnalytics './modules/log-analytics.bicep' = {
  name: 'log-analytics'
  params: {
    name: '${namePrefix}-logs'
    location: location
    retentionInDays: logRetentionDays
  }
}

module identity './modules/managed-identity.bicep' = {
  name: 'managed-identity'
  params: {
    name: '${namePrefix}-id'
    location: location
  }
}

module registry './modules/container-registry.bicep' = {
  name: 'container-registry'
  params: {
    name: containerRegistryName
    location: location
    skuName: containerRegistrySkuName
  }
}

module keyVault './modules/key-vault.bicep' = {
  name: 'key-vault'
  params: {
    name: take('${namePrefix}-kv-${uniqueString(resourceGroup().id)}', 24)
    location: location
    tenantId: subscription().tenantId
    softDeleteRetentionInDays: keyVaultSoftDeleteRetentionDays
    enablePurgeProtection: keyVaultEnablePurgeProtection
  }
}

module keyVaultSecretsUser './modules/key-vault-role-assignment.bicep' = {
  name: 'key-vault-secrets-user'
  params: {
    keyVaultName: keyVault.outputs.name
    principalId: identity.outputs.principalId
    roleDefinitionId: roleDefinitionIds.keyVaultSecretsUser
  }
}

module acrPull './modules/container-registry-role-assignment.bicep' = {
  name: 'container-registry-pull'
  params: {
    registryName: containerRegistryName
    principalId: identity.outputs.principalId
    roleDefinitionId: roleDefinitionIds.acrPull
  }
  dependsOn: [
    registry
  ]
}

module azureOpenAiUser './modules/azure-openai-role-assignment.bicep' = {
  name: 'azure-openai-user'
  params: {
    accountName: azureOpenAiAccountName
    principalId: identity.outputs.principalId
    roleDefinitionId: roleDefinitionIds.azureOpenAiUser
  }
}

module environment './modules/container-app-environment.bicep' = {
  name: 'container-app-environment'
  params: {
    name: '${namePrefix}-env'
    location: location
    logAnalyticsWorkspaceName: logAnalytics.outputs.name
  }
}

module storage './modules/storage-account.bicep' = if (enableStorage) {
  name: 'storage-account'
  params: {
    name: storageAccountName
    location: location
    skuName: storageSkuName
  }
}

module tableService './modules/storage-table-service.bicep' = if (enableTableStorage) {
  name: 'storage-table-service'
  params: {
    storageAccountName: storageAccountName
  }
  dependsOn: [
    storage
  ]
}

module runTable './modules/storage-table.bicep' = if (enableRemotePipeline) {
  name: 'run-state-table'
  params: {
    storageAccountName: storageAccountName
    tableName: runTableName
  }
  dependsOn: [
    tableService
  ]
}

module memoryTable './modules/storage-table.bicep' = if (enableMemoryTable) {
  name: 'memory-table'
  params: {
    storageAccountName: storageAccountName
    tableName: memoryTableName
  }
  dependsOn: [
    tableService
  ]
}

module storageTableRole './modules/storage-role-assignment.bicep' = if (enableTableStorage) {
  name: 'storage-table-data-contributor'
  params: {
    storageAccountName: storageAccountName
    principalId: identity.outputs.principalId
    roleDefinitionId: roleDefinitionIds.storageTableDataContributor
  }
  dependsOn: [
    storage
  ]
}

module blobService './modules/storage-blob-service.bicep' = if (enableBlobStorage) {
  name: 'storage-blob-service'
  params: {
    storageAccountName: storageAccountName
  }
  dependsOn: [
    storage
  ]
}

module renderContainer './modules/storage-blob-container.bicep' = if (enableRenderPptx) {
  name: 'render-blob-container'
  params: {
    storageAccountName: storageAccountName
    containerName: renderBlobContainer
  }
  dependsOn: [
    blobService
  ]
}

module memoryOverflowContainerModule './modules/storage-blob-container.bicep' = if (enableMemoryOverflow) {
  name: 'memory-overflow-blob-container'
  params: {
    storageAccountName: storageAccountName
    containerName: memoryOverflowContainer
  }
  dependsOn: [
    blobService
  ]
}

module storageBlobRole './modules/storage-role-assignment.bicep' = if (enableBlobStorage) {
  name: 'storage-blob-data-contributor'
  params: {
    storageAccountName: storageAccountName
    principalId: identity.outputs.principalId
    roleDefinitionId: roleDefinitionIds.storageBlobDataContributor
  }
  dependsOn: [
    storage
  ]
}

var appEnvironmentVariables = concat(webBaseEnv, [
    {
      name: 'AZURE_CLIENT_ID'
      value: identity.outputs.clientId
    }
  ],
  storageEnv,
  pipelineEnv,
  encryptionEnv,
  memoryEncryptionEnv,
  renderEnv,
  memoryEnv,
  businessEnv,
  artifactsEnv,
  advisoryAutopilotEnv)

module app './modules/container-app.bicep' = {
  name: 'container-app'
  params: {
    name: '${namePrefix}-app'
    location: location
    environmentId: environment.outputs.id
    identityId: identity.outputs.id
    containerImage: containerImage
    containerRegistryServer: containerRegistryServer
    secrets: {
      items: encryptionSecrets
    }
    environmentVariables: appEnvironmentVariables
    minReplicas: minReplicas
    maxReplicas: maxReplicas
    concurrentRequests: httpConcurrentRequests
    cpu: containerCpu
    memory: containerMemory
  }
  dependsOn: [
    acrPull
    azureOpenAiUser
    keyVaultSecretsUser
    runTable
    memoryTable
    renderContainer
    memoryOverflowContainerModule
    storageTableRole
    storageBlobRole
  ]
}

module auth './modules/container-app-auth.bicep' = {
  name: 'container-app-auth'
  params: {
    containerAppName: '${namePrefix}-app'
    clientId: authClientId
    openIdIssuer: authOpenIdIssuer
    audience: squad.audience
  }
  dependsOn: [
    app
  ]
}

module worker './modules/container-app-job.bicep' = if (enableWorker) {
  name: 'container-app-worker'
  params: {
    name: '${namePrefix}-worker'
    location: location
    environmentId: environment.outputs.id
    identityId: identity.outputs.id
    containerImage: containerImage
    containerRegistryServer: containerRegistryServer
    secrets: {
      items: encryptionSecrets
    }
    environmentVariables: concat(webBaseEnv, [
        {
          name: 'AZURE_CLIENT_ID'
          value: identity.outputs.clientId
        }
      ],
      storageEnv,
      pipelineEnv,
      encryptionEnv,
      memoryEncryptionEnv,
      memoryEnv,
      artifactsEnv,
      advisoryAutopilotEnv, [
        {
          name: 'SQUAD_MCP_WORKER_ONCE'
          value: 'true'
        }
      ])
    cronExpression: workerCron
    replicaTimeout: workerReplicaTimeout
    replicaRetryLimit: workerReplicaRetryLimit
    cpu: containerCpu
    memory: containerMemory
  }
  dependsOn: [
    acrPull
    azureOpenAiUser
    runTable
    memoryTable
    storageTableRole
  ]
}

module budget './modules/budget.bicep' = {
  name: 'resource-group-budget'
  params: {
    name: '${namePrefix}-budget'
    amount: budgetAmountUsd
    startDate: budgetStartDate
    contactEmails: budgetAlertEmails
    thresholds: budgetAlertThresholds
  }
}

@description('HTTPS FQDN of the deployed MCP endpoint.')
output mcpFqdn string = app.outputs.fqdn

@description('Application managed-identity principal id.')
output appPrincipalId string = identity.outputs.principalId

@description('Application managed-identity client id.')
output appClientId string = identity.outputs.clientId

@description('Key Vault name.')
output keyVaultName string = keyVault.outputs.name

@description('Storage account for asynchronous run state, or empty when disabled.')
output runStateStorageAccount string = enableRemotePipeline ? storageAccountName : ''

@description('Configured memory backend, or empty when disabled.')
output memoryBackendInUse string = enableMemory ? memoryBackend : ''
