// hve-squad MCP server — remote thin-slice hosting (Azure Container Apps).
//
// Resource-group-scoped deployment of the scale-to-zero ACA app that serves the
// Streamable HTTP `/mcp` endpoint with Entra auth and managed-identity secrets.
// Carries the council's host-side conditions:
//   * COST-3 / ARCH-2 — minReplicas 0 with ACA's idle scale-down (~5 min).
//   * SEC-8           — HTTPS-only ingress (allowInsecure: false).
//   * SEC-10          — secrets via managed identity + Key Vault; none in the image.
//   * SEC-1           — ACA built-in Entra auth in front of the app's own
//                       audience-bound validation (defense-in-depth).
//   * COST-2          — a monthly budget with 70 / 90 / 100% alerts.
//
// Per-tenant RATE caps (SEC-9 / COST-1, host side) require an APIM / Front Door
// layer and are documented as a Phase-1 boundary in host/RUNBOOK.md; the engine
// enforces per-tenant concurrency + the hard cost ceiling itself.

@description('Squad MCP application + security configuration (operator-controlled; never caller input).')
type SquadConfig = {
  @description('Token audience this resource server accepts (RFC 8707; SEC-1).')
  audience: string
  @description('Comma-separated strict Origin allow-list (SEC-8). Never "*".')
  allowedOrigins: string
  @description('Comma-separated permitted Entra issuers.')
  allowedIssuers: string
  @description('Comma-separated permitted tenant ids (empty = any validated tenant).')
  allowedTenants: string
  @description('JWKS endpoint used to validate Entra tokens.')
  jwksUri: string
  @description('Azure OpenAI endpoint to call (must be in allowedModelEndpoints; SEC-3).')
  modelEndpoint: string
  @description('Comma-separated Azure OpenAI endpoint allow-list (SEC-3).')
  allowedModelEndpoints: string
  @description('Azure OpenAI deployment name.')
  modelDeployment: string
  @description('Azure OpenAI REST API version.')
  modelApiVersion: string
  @description('Per-tenant concurrency cap (SEC-9 / COST-1).')
  tenantConcurrency: int
  @description('Hard monthly per-tenant cost ceiling in USD (COST-2).')
  tenantCostCeilingUsd: int
}

@description('Azure region for all resources.')
param location string = resourceGroup().location

@description('Short prefix for resource names.')
@minLength(3)
@maxLength(12)
param namePrefix string = 'squadmcp'

@description('Container image reference, e.g. <registry>.azurecr.io/hve-squad-mcp:<tag>.')
param containerImage string

@description('Azure Container Registry login server the image is pulled from.')
param containerRegistryServer string

@description('Entra application (client) id for the ACA built-in auth (SEC-1).')
param authClientId string

@description('Entra OpenID issuer URL for the ACA built-in auth, e.g. https://login.microsoftonline.com/<tenant>/v2.0.')
param authOpenIdIssuer string

@description('Squad MCP application configuration.')
param squad SquadConfig

@description('Minimum replicas. 0 enables scale-to-zero (COST-3 / ARCH-2).')
@minValue(0)
@maxValue(5)
param minReplicas int = 0

@description('Maximum replicas.')
@minValue(1)
@maxValue(30)
param maxReplicas int = 5

@description('Monthly cost budget in USD for this resource group (COST-2).')
param budgetAmountUsd int = 500

@description('First day of the budget month (YYYY-MM-01).')
param budgetStartDate string = '2026-07-01'

@description('Email addresses that receive the 70/90/100% budget alerts (COST-2).')
param budgetAlertEmails array

@description('Log Analytics retention in days.')
@minValue(30)
@maxValue(730)
param logRetentionDays int = 30

@description('Enable the gated async pipeline (squad_run/squad_status) with a durable cross-replica run-state store in Azure Table Storage (WI-06). Off by default (hero-only).')
param enableRemotePipeline bool = false

@description('Deploy the background run-worker ACA Job that drives approved runs off the request path so a run may exceed the 240s ingress ceiling (WI-1b4-WORKER). Requires enableRemotePipeline.')
param enableWorker bool = false

@description('Azure Table name that holds async run records (WI-06).')
param runTableName string = 'squadruns'

@description('Base64-encoded 32-byte key for AES-256-GCM encryption of request/context at rest (MEDIUM-3). Empty = platform-only at-rest encryption.')
@secure()
param runEncryptionKeyBase64 string = ''

@description('Cron schedule for the worker ACA Job drain pass (default every 5 minutes).')
param workerCron string = '*/5 * * * *'

@description('Enable the deterministic squad_render_pptx file-output tool (content YAML -> a .pptx download link via a tenant-scoped Blob container + user-delegation SAS). Off by default.')
param enableRenderPptx bool = false

@description('Blob container that holds rendered decks (squad_render_pptx).')
param renderBlobContainer string = 'renders'

@description('Lifetime in minutes for a rendered-deck download SAS link.')
@minValue(5)
@maxValue(1440)
param renderSasTtlMinutes int = 60

@description('Optional operator brand template path inside the image for branded renders (empty = the skill default look).')
param renderBrandTemplatePath string = ''

var tenantId = subscription().tenantId
var keyVaultSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'
// Storage Table Data Contributor — the app + worker identity reads/writes run records.
var storageTableDataContributorRoleId = '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'
// Storage Blob Data Contributor — the app identity writes rendered decks + mints
// user-delegation SAS (grants generateUserDelegationKey/action).
var storageBlobDataContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
// The Storage account is provisioned for the async pipeline (Table) OR the render
// feature (Blob); either one deploys it.
var enableStorage = enableRemotePipeline || enableRenderPptx
var storageAccountName = toLower(take('${namePrefix}st${uniqueString(resourceGroup().id)}', 24))

// Async-pipeline env (WI-06). Appended to the web app and the worker when enabled.
var pipelineEnv = enableRemotePipeline
  ? [
      { name: 'SQUAD_MCP_REMOTE_PIPELINE_ENABLED', value: 'true' }
      { name: 'SQUAD_MCP_RUN_STATE_BACKEND', value: 'table' }
      { name: 'SQUAD_MCP_STORAGE_ACCOUNT', value: storageAccountName }
      { name: 'SQUAD_MCP_RUN_TABLE_NAME', value: runTableName }
      { name: 'SQUAD_MCP_WORKER_ENABLED', value: string(enableWorker) }
    ]
  : []

// Encryption key passed as an ACA secret (never a plain env value).
var encryptionSecrets = !empty(runEncryptionKeyBase64)
  ? [ { name: 'run-encryption-key', value: runEncryptionKeyBase64 } ]
  : []
var encryptionEnv = (enableRemotePipeline && !empty(runEncryptionKeyBase64))
  ? [ { name: 'SQUAD_MCP_RUN_ENCRYPTION_KEY_B64', secretRef: 'run-encryption-key' } ]
  : []

// Render env (squad_render_pptx). The storage account name is set by pipelineEnv
// when the pipeline is on; add it here only when render is the sole storage user
// (avoids a duplicate env entry).
var renderStorageEnv = (enableRenderPptx && !enableRemotePipeline)
  ? [ { name: 'SQUAD_MCP_STORAGE_ACCOUNT', value: storageAccountName } ]
  : []
var renderEnv = enableRenderPptx
  ? concat([
      { name: 'SQUAD_MCP_ENABLE_RENDER_PPTX', value: 'true' }
      { name: 'SQUAD_MCP_RENDER_BLOB_CONTAINER', value: renderBlobContainer }
      { name: 'SQUAD_MCP_RENDER_SAS_TTL_MINUTES', value: string(renderSasTtlMinutes) }
      { name: 'SQUAD_MCP_RENDER_BRAND_TEMPLATE_PATH', value: renderBrandTemplatePath }
    ], renderStorageEnv)
  : []

// Base web-app env; pipeline + encryption env are concatenated onto it below.
var webBaseEnv = [
  { name: 'PORT', value: '3000' }
  { name: 'SQUAD_MCP_AUDIENCE', value: squad.audience }
  { name: 'SQUAD_MCP_ALLOWED_ORIGINS', value: squad.allowedOrigins }
  { name: 'SQUAD_MCP_ALLOWED_ISSUERS', value: squad.allowedIssuers }
  { name: 'SQUAD_MCP_ALLOWED_TENANTS', value: squad.allowedTenants }
  { name: 'SQUAD_MCP_JWKS_URI', value: squad.jwksUri }
  { name: 'SQUAD_MCP_MODEL_ENDPOINT', value: squad.modelEndpoint }
  { name: 'SQUAD_MCP_ALLOWED_MODEL_ENDPOINTS', value: squad.allowedModelEndpoints }
  { name: 'SQUAD_MCP_MODEL_DEPLOYMENT', value: squad.modelDeployment }
  { name: 'SQUAD_MCP_MODEL_API_VERSION', value: squad.modelApiVersion }
  { name: 'SQUAD_MCP_TENANT_CONCURRENCY', value: string(squad.tenantConcurrency) }
  { name: 'SQUAD_MCP_TENANT_COST_CEILING_USD', value: string(squad.tenantCostCeilingUsd) }
  { name: 'AZURE_CLIENT_ID', value: identity.properties.clientId }
]

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${namePrefix}-logs'
  location: location
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: logRetentionDays
  }
}

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${namePrefix}-id'
  location: location
}

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: '${namePrefix}-kv-${uniqueString(resourceGroup().id)}'
  location: location
  properties: {
    sku: {
      family: 'A'
      name: 'standard'
    }
    tenantId: tenantId
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    publicNetworkAccess: 'Enabled'
  }
}

// Let the app's managed identity read Key Vault secrets (SEC-10).
resource keyVaultSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, identity.id, keyVaultSecretsUserRoleId)
  scope: keyVault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${namePrefix}-env'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
  }
}

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${namePrefix}-app'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: environment.id
    configuration: {
      activeRevisionsMode: 'Single'
      secrets: encryptionSecrets
      ingress: {
        external: true
        targetPort: 3000
        transport: 'auto'
        // SEC-8: HTTPS-only — reject plaintext at the ingress.
        allowInsecure: false
      }
      registries: [
        {
          server: containerRegistryServer
          identity: identity.id
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'hve-squad-mcp'
          image: containerImage
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: concat(webBaseEnv, pipelineEnv, encryptionEnv, renderEnv)
        }
      ]
      scale: {
        // COST-3 / ARCH-2: scale-to-zero with HTTP-driven scale-out.
        minReplicas: minReplicas
        maxReplicas: maxReplicas
        rules: [
          {
            name: 'http-concurrency'
            http: {
              metadata: {
                concurrentRequests: '20'
              }
            }
          }
        ]
      }
    }
  }
}

// SEC-1 (defense-in-depth): require an Entra token at the ingress in addition to
// the app's own audience-bound validation. The original Authorization header is
// forwarded so the app still performs audience + per-tool scope checks.
resource authConfig 'Microsoft.App/containerApps/authConfigs@2024-03-01' = {
  parent: app
  name: 'current'
  properties: {
    platform: {
      enabled: true
    }
    globalValidation: {
      unauthenticatedClientAction: 'Return401'
    }
    identityProviders: {
      azureActiveDirectory: {
        enabled: true
        registration: {
          openIdIssuer: authOpenIdIssuer
          clientId: authClientId
        }
        validation: {
          allowedAudiences: [
            squad.audience
          ]
        }
      }
    }
  }
}

// WI-06: cross-replica run-state + approval store (Azure Table Storage). ETag
// If-Match gives a true compare-and-swap so exactly one replica drives a run.
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = if (enableStorage) {
  name: storageAccountName
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    supportsHttpsTrafficOnly: true
  }
}

resource tableService 'Microsoft.Storage/storageAccounts/tableServices@2023-05-01' = if (enableRemotePipeline) {
  parent: storage
  name: 'default'
}

resource runTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = if (enableRemotePipeline) {
  parent: tableService
  name: runTableName
}

// Let the app + worker identity read/write run records (WI-06). Account-scoped RBAC.
resource storageTableRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (enableRemotePipeline) {
  name: guid(storageAccountName, identity.id, storageTableDataContributorRoleId)
  scope: storage
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageTableDataContributorRoleId)
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// squad_render_pptx: a private Blob container for rendered decks + the Blob Data
// Contributor role so the app identity can PUT decks and mint user-delegation SAS
// (that role grants generateUserDelegationKey/action). Public access is disabled;
// each download link is a short-lived per-blob user-delegation SAS.
resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = if (enableRenderPptx) {
  parent: storage
  name: 'default'
}

resource renderContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = if (enableRenderPptx) {
  parent: blobService
  name: renderBlobContainer
  properties: {
    publicAccess: 'None'
  }
}

resource storageBlobRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (enableRenderPptx) {
  name: guid(storageAccountName, identity.id, storageBlobDataContributorRoleId)
  scope: storage
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataContributorRoleId)
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// WI-1b4-WORKER: a scheduled ACA Job drains approved runs off the request path so
// a run may exceed the 240s HTTP ingress ceiling. It shares the app image + the
// same identity + the same cross-replica store; SQUAD_MCP_WORKER_ONCE makes each
// scheduled run a single drain pass that exits.
resource workerJob 'Microsoft.App/jobs@2024-03-01' = if (enableWorker) {
  name: '${namePrefix}-worker'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
  properties: {
    environmentId: environment.id
    configuration: {
      triggerType: 'Schedule'
      replicaTimeout: 1800
      replicaRetryLimit: 1
      secrets: encryptionSecrets
      scheduleTriggerConfig: {
        cronExpression: workerCron
        parallelism: 1
        replicaCompletionCount: 1
      }
      registries: [
        {
          server: containerRegistryServer
          identity: identity.id
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'hve-squad-mcp-worker'
          image: containerImage
          command: [ 'node', 'dist/src/worker-main.js' ]
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: concat(webBaseEnv, pipelineEnv, encryptionEnv, [
            { name: 'SQUAD_MCP_WORKER_ONCE', value: 'true' }
          ])
        }
      ]
    }
  }
}

// COST-2: monthly budget with 70 / 90 / 100% alerts.
resource budget 'Microsoft.Consumption/budgets@2023-11-01' = {
  name: '${namePrefix}-budget'
  properties: {
    category: 'Cost'
    amount: budgetAmountUsd
    timeGrain: 'Monthly'
    timePeriod: {
      startDate: budgetStartDate
    }
    notifications: {
      alert70: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 70
        thresholdType: 'Actual'
        contactEmails: budgetAlertEmails
      }
      alert90: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 90
        thresholdType: 'Actual'
        contactEmails: budgetAlertEmails
      }
      alert100: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 100
        thresholdType: 'Actual'
        contactEmails: budgetAlertEmails
      }
    }
  }
}

@description('The HTTPS FQDN of the deployed /mcp endpoint.')
output mcpFqdn string = app.properties.configuration.ingress.fqdn

@description('The app managed-identity principal id (grant it Cognitive Services OpenAI User on the AOAI account).')
output appPrincipalId string = identity.properties.principalId

@description('The Key Vault name for operator secrets.')
output keyVaultName string = keyVault.name

@description('The Azure Storage account backing the async run-state store (empty when the pipeline is disabled).')
output runStateStorageAccount string = enableRemotePipeline ? storageAccountName : ''
