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
  @description('Token audience(s) this resource server accepts (RFC 8707; SEC-1). Comma-separate to serve several front doors, for example a Copilot Studio connector and a Cowork Entra SSO auth config.')
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
  @description('Azure OpenAI API surface: responses (recommended) or chat-completions.')
  modelApi: string
  @description('Azure OpenAI REST API version (legacy Chat Completions only).')
  modelApiVersion: string
  @description('Default maximum output tokens per model dispatch.')
  modelMaxOutputTokens: int
  @description('Responses API reasoning effort; leave empty for the model default.')
  modelReasoningEffort: string
  @description('Responses API visible-output verbosity; leave empty for the model default.')
  modelVerbosity: string
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

@description('Enable Microsoft Identity Service Essentials (MISE) 2.4.1+ as a pod-local sidecar for Entra token validation. Local simple-OAuth HS256 tokens remain validated by the application.')
param enableMise bool = false

@description('Immutable MISE sidecar image reference. Required when enableMise is true; prefer an ACR digest or a source-commit-specific tag.')
param miseContainerImage string = ''

@description('Protected-resource Entra application id attributed in MISE telemetry. Empty uses authClientId; set this explicitly when ACA Easy Auth and the protected MCP resource use different app registrations.')
param miseClientId string = ''

@description('Fail-closed application timeout for one pod-local MISE validation request.')
@minValue(100)
@maxValue(60000)
param miseValidationTimeoutMs int = 10000

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

@description('Seconds of idle traffic before the app scales back to zero. The default 300 is tuned for cost; a longer window keeps the app warm across the pauses in an interactive session, which is what a Copilot Studio or Cowork user actually generates. Scale-to-zero still happens once the session ends.')
@minValue(60)
@maxValue(3600)
param scaleCooldownSeconds int = 300

@description('Idle seconds before an MCP session id is forgotten (SEC-8). This must comfortably exceed the think-time between turns of an interactive session: the streamable-HTTP session lives in the replica\'s memory, so once it lapses the next turn is rejected with a 404 and the client reports the connector as unavailable mid-conversation. Keep it aligned with scaleCooldownSeconds, since a session cannot outlive the replica that holds it. Bounded to 1 hour so a leaked id still has a short life.')
@minValue(60)
@maxValue(3600)
param sessionIdleSeconds int = 1800

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

@description('Enable the shared-state squad-memory broker (the squad-memory:// resource surface + the squad_memory_* tools). Off by default.')
param enableMemory bool = false

@description('Where squad memory is persisted. "table" = Azure Table Storage (cross-replica ETag CAS). "graph" = a SharePoint document library / OneDrive drive via Microsoft Graph (one readable .md per entry, If-Match CAS).')
@allowed([
  'table'
  'graph'
])
param memoryBackend string = 'table'

@description('Azure Table name that holds squad memory entries when memoryBackend is "table".')
param memoryTableName string = 'squadmemory'

@description('Read and write squad memory AUTOMATICALLY around every embedded dispatch instead of only on an explicit squad_memory_* tool call. Requires enableMemory.')
param enableMemoryAuto bool = false

@description('Memory project partition used when a turn pins no federation sub-squad. Lower-kebab-case; server-controlled so continuity is reproducible.')
param memoryDefaultProject string = 'default'

@description('Persist the squad ledger (team.md, routing.md, state.json, the append-only logs, and each role\'s deliverable) as a browsable .copilot-tracking tree, and expose squad_history to read it back. Writes through the memory backend selected above, so the destination is chosen once. Requires enableMemory and enableMemoryAuto.')
param enableArtifacts bool = false

@description('Let a run the SERVER has proven advisory-only proceed without an out-of-band operator approval. Needed for Copilot Studio, which cannot reach /admin/approve. A destructive run, and any roster seeding backlog-executor, deployer, iac-author or azure-diagnose, still holds. Requires enableRemotePipeline.')
param enableAdvisoryAutopilot bool = false

@description('SharePoint document library / OneDrive drive id backing the "graph" memory backend. Required when memoryBackend is "graph".')
param memoryGraphDriveId string = ''

@description('Folder within the drive that roots squad memory (empty = the drive root).')
param memoryGraphRootPath string = 'squad-memory'

@description('Override the Microsoft Graph endpoint for a sovereign cloud (empty = the public cloud).')
param memoryGraphEndpoint string = ''

@description('Field-encrypt memory content at rest on the "graph" backend. Default false: a SharePoint library exists to be read by humans, so ciphertext there is an explicit choice.')
param memoryGraphEncrypt bool = false

@description('Optional JSON array of operator-declared, caller-selectable memory destinations. Empty = a single destination and the tools\' "target" input is ignored.')
param memoryTargets string = ''

@description('Destination used when a call names none. Required when memoryTargets is set, and must name one of its entries.')
param memoryDefaultTarget string = ''

@description('Spill over-threshold memory content to a tenant-scoped Blob with a pointer entity left in the primary store (WI-03). Requires enableMemory.')
param enableMemoryOverflow bool = false

@description('Blob container that holds memory overflow payloads.')
param memoryOverflowContainer string = 'squadmemory'

@description('Enable the business-facing tools squad_business_plan and squad_backlog (advisory only; the ADO/Jira write stays in the native certified connector). Off by default.')
param enableBusinessTools bool = false

@description('Enable the server-owned OAuth 2.1 authority (RFC 9728/8414/7591, loopback public clients, PKCE S256, and operator-issued one-time login codes). Off by default; existing Entra auth remains enabled.')
param enableSimpleOAuth bool = false

@description('Optional public HTTPS origin for simple OAuth metadata and endpoints. Empty derives https://<app>.<managed-environment-domain>.')
param simpleOAuthExternalUrl string = ''

@description('Azure Table name for one-time simple OAuth login, authorization, and refresh grants.')
param simpleOAuthTableName string = 'squadoauth'

@description('Comma-separated local OAuth scopes to expose. Empty uses every ordinary Squad.* tool scope except Squad.Operate.')
param simpleOAuthAllowedScopes string = ''

@description('Current base64 32-byte simple OAuth signing key, followed by optional previous keys separated by commas for rotation. Stored in Key Vault and exposed to the app only by managed identity.')
@secure()
param simpleOAuthSigningKeysBase64 string = ''

@description('Simple OAuth access-token lifetime in seconds.')
@minValue(300)
@maxValue(3600)
param simpleOAuthAccessTokenTtlSeconds int = 3600

@description('Simple OAuth authorization-code lifetime in seconds.')
@minValue(60)
@maxValue(600)
param simpleOAuthAuthCodeTtlSeconds int = 300

@description('Simple OAuth refresh-token lifetime in seconds.')
@minValue(3600)
@maxValue(7776000)
param simpleOAuthRefreshTokenTtlSeconds int = 2592000

@description('Maximum lifetime in seconds an operator may assign to a single-use browser login code.')
@minValue(60)
@maxValue(3600)
param simpleOAuthLoginCodeMaxTtlSeconds int = 900

var tenantId = subscription().tenantId
var keyVaultSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'
// Storage Table Data Contributor — the app + worker identity reads/writes run records.
var storageTableDataContributorRoleId = '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'
// Storage Blob Data Contributor — the app identity writes rendered decks + mints
// user-delegation SAS (grants generateUserDelegationKey/action).
var storageBlobDataContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
// Which storage services are needed, and therefore which account/roles deploy.
// Table: async run state (WI-06) and/or the table-backed memory broker.
// Blob:  rendered decks and/or the memory overflow channel (WI-03).
var enableMemoryTable = enableMemory && memoryBackend == 'table'
var enableTableStorage = enableRemotePipeline || enableMemoryTable || enableSimpleOAuth
var enableBlobStorage = enableRenderPptx || enableMemoryOverflow
var enableStorage = enableTableStorage || enableBlobStorage
var storageAccountName = toLower(take('${namePrefix}st${uniqueString(resourceGroup().id)}', 24))

// The storage account name is a single env entry shared by the run-state store,
// the memory broker, the render tool, and the overflow channel — emitted once so
// the container never receives a duplicate variable.
var storageEnv = enableStorage
  ? [ { name: 'SQUAD_MCP_STORAGE_ACCOUNT', value: storageAccountName } ]
  : []

// Async-pipeline env (WI-06). Appended to the web app and the worker when enabled.
var pipelineEnv = enableRemotePipeline
  ? [
      { name: 'SQUAD_MCP_REMOTE_PIPELINE_ENABLED', value: 'true' }
      { name: 'SQUAD_MCP_RUN_STATE_BACKEND', value: 'table' }
      { name: 'SQUAD_MCP_RUN_TABLE_NAME', value: runTableName }
      { name: 'SQUAD_MCP_WORKER_ENABLED', value: string(enableWorker) }
    ]
  : []

// Encryption key passed as an ACA secret (never a plain env value).
var encryptionSecrets = !empty(runEncryptionKeyBase64)
  ? [ { name: 'run-encryption-key', value: runEncryptionKeyBase64 } ]
  : []
var encryptionEnv = (enableRemotePipeline && !empty(runEncryptionKeyBase64))
  // checkov:skip=CKV_SECRET_6:The high-entropy match is the NAME of an environment variable, not a secret. Its value is a secretRef into the Container App secret store, which is the pattern this check exists to encourage.
  ? [ { name: 'SQUAD_MCP_RUN_ENCRYPTION_KEY_B64', secretRef: 'run-encryption-key' } ]
  : []

var simpleOAuthSigningKeySecretName = 'simple-oauth-signing-keys'
var simpleOAuthResolvedExternalUrl = empty(simpleOAuthExternalUrl)
  ? 'https://${namePrefix}-app.${environment.properties.defaultDomain}'
  : simpleOAuthExternalUrl
var simpleOAuthSecrets = enableSimpleOAuth
  ? [
      {
        name: simpleOAuthSigningKeySecretName
        // Versionless reference lets ACA refresh the secret and restart active
        // replicas when the operator rotates the signing-key value.
        keyVaultUrl: simpleOAuthSigningKeySecret!.properties.secretUri
        identity: identity.id
      }
    ]
  : []
var simpleOAuthEnv = enableSimpleOAuth
  ? [
      { name: 'SQUAD_MCP_SIMPLE_OAUTH_ENABLED', value: 'true' }
      { name: 'SQUAD_MCP_SIMPLE_OAUTH_EXTERNAL_URL', value: simpleOAuthResolvedExternalUrl }
      { name: 'SQUAD_MCP_SIMPLE_OAUTH_TABLE_NAME', value: simpleOAuthTableName }
      { name: 'SQUAD_MCP_SIMPLE_OAUTH_ALLOWED_SCOPES', value: simpleOAuthAllowedScopes }
      { name: 'SQUAD_MCP_SIMPLE_OAUTH_SIGNING_KEYS_B64', secretRef: simpleOAuthSigningKeySecretName }
      { name: 'SQUAD_MCP_SIMPLE_OAUTH_ACCESS_TOKEN_TTL_SECONDS', value: string(simpleOAuthAccessTokenTtlSeconds) }
      { name: 'SQUAD_MCP_SIMPLE_OAUTH_AUTH_CODE_TTL_SECONDS', value: string(simpleOAuthAuthCodeTtlSeconds) }
      { name: 'SQUAD_MCP_SIMPLE_OAUTH_REFRESH_TOKEN_TTL_SECONDS', value: string(simpleOAuthRefreshTokenTtlSeconds) }
      { name: 'SQUAD_MCP_SIMPLE_OAUTH_LOGIN_CODE_MAX_TTL_SECONDS', value: string(simpleOAuthLoginCodeMaxTtlSeconds) }
    ]
  : []

// Render env (squad_render_pptx). The storage account name comes from storageEnv.
var renderEnv = enableRenderPptx
  ? [
      { name: 'SQUAD_MCP_ENABLE_RENDER_PPTX', value: 'true' }
      { name: 'SQUAD_MCP_RENDER_BLOB_CONTAINER', value: renderBlobContainer }
      { name: 'SQUAD_MCP_RENDER_SAS_TTL_MINUTES', value: string(renderSasTtlMinutes) }
      { name: 'SQUAD_MCP_RENDER_BRAND_TEMPLATE_PATH', value: renderBrandTemplatePath }
    ]
  : []

// Graph (SharePoint / OneDrive) memory destination. Only emitted for the graph
// backend; the app's own config validation fails fast on a missing drive id.
var memoryGraphEnv = (enableMemory && memoryBackend == 'graph')
  ? [
      { name: 'SQUAD_MCP_MEMORY_GRAPH_DRIVE_ID', value: memoryGraphDriveId }
      { name: 'SQUAD_MCP_MEMORY_GRAPH_ROOT_PATH', value: memoryGraphRootPath }
      { name: 'SQUAD_MCP_MEMORY_GRAPH_ENDPOINT', value: memoryGraphEndpoint }
      { name: 'SQUAD_MCP_MEMORY_GRAPH_ENCRYPT', value: string(memoryGraphEncrypt) }
    ]
  : []

// Operator-declared, caller-selectable destinations. The caller may only select
// among these BY NAME; it never supplies a drive id, account, or path (SEC-3).
var memoryTargetsEnv = (enableMemory && !empty(memoryTargets))
  ? [
      { name: 'SQUAD_MCP_MEMORY_TARGETS', value: memoryTargets }
      { name: 'SQUAD_MCP_MEMORY_DEFAULT_TARGET', value: memoryDefaultTarget }
    ]
  : []

// Blob overflow channel for over-threshold memory entries (WI-03).
var memoryOverflowEnv = enableMemoryOverflow
  ? [
      { name: 'SQUAD_MCP_MEMORY_OVERFLOW_ENABLED', value: 'true' }
      { name: 'SQUAD_MCP_MEMORY_OVERFLOW_CONTAINER', value: memoryOverflowContainer }
    ]
  : []

// Shared-state memory broker env. Auto-memory makes continuity a SERVER behavior
// rather than something the calling agent must remember to do.
var memoryEnv = enableMemory
  ? concat([
      { name: 'SQUAD_MCP_ENABLE_MEMORY', value: 'true' }
      { name: 'SQUAD_MCP_MEMORY_BACKEND', value: memoryBackend }
      { name: 'SQUAD_MCP_MEMORY_TABLE_NAME', value: memoryTableName }
      { name: 'SQUAD_MCP_MEMORY_AUTO_ENABLED', value: string(enableMemoryAuto) }
      { name: 'SQUAD_MCP_MEMORY_DEFAULT_PROJECT', value: memoryDefaultProject }
    ], memoryGraphEnv, memoryTargetsEnv, memoryOverflowEnv)
  : []

// The squad ledger writes through the memory store selected above, so it needs no
// destination of its own; squad_history reads the same tree back.
var artifactsEnv = (enableMemory && enableMemoryAuto && enableArtifacts)
  ? [ { name: 'SQUAD_MCP_ENABLE_ARTIFACTS', value: 'true' } ]
  : []

// Releases the human gate for advisory-only runs. Narrowing, not an override:
// the server still holds every destructive run and every impactful roster.
var advisoryAutopilotEnv = (enableRemotePipeline && enableAdvisoryAutopilot)
  ? [ { name: 'SQUAD_MCP_ADVISORY_AUTOPILOT_ENABLED', value: 'true' } ]
  : []

// The memory broker shares the run-state encryption key: on the table backend it
// encrypts `content` at rest exactly as the run store protects request/context.
var memoryEncryptionEnv = (enableMemory && !enableRemotePipeline && !empty(runEncryptionKeyBase64))
  ? [ { name: 'SQUAD_MCP_RUN_ENCRYPTION_KEY_B64', secretRef: 'run-encryption-key' } ]
  : []

// Business-facing tools (squad_business_plan, squad_backlog). Advisory only — the
// ADO/Jira write stays in the native certified connector on the user's connection.
var businessEnv = enableBusinessTools
  ? [ { name: 'SQUAD_MCP_ENABLE_BUSINESS_TOOLS', value: 'true' } ]
  : []

// SEC-1: the accepted audiences, split from the operator's comma-separated value.
// The app receives the raw string and parses it the same way, so the ingress and
// the app can never disagree about which audiences are accepted.
var squadAudiences = filter(map(split(squad.audience, ','), a => trim(a)), a => !empty(a))
var miseResolvedClientId = empty(miseClientId) ? authClientId : miseClientId
var miseTenantIds = filter(map(split(squad.allowedTenants, ','), tenant => trim(tenant)), tenant => !empty(tenant))
var miseValidTenantIds = length(miseTenantIds) > 0 ? miseTenantIds : [ '*' ]
var miseAuthorityTenant = length(miseTenantIds) == 1 ? first(miseTenantIds) : 'common'
var miseClientEnv = enableMise
  ? [
      { name: 'SQUAD_MCP_MISE_ENABLED', value: 'true' }
      { name: 'SQUAD_MCP_MISE_ENDPOINT', value: 'http://127.0.0.1:5000/ValidateRequest' }
      { name: 'SQUAD_MCP_MISE_TIMEOUT_MS', value: string(miseValidationTimeoutMs) }
    ]
  : []
var miseAudienceEnv = map(squadAudiences, (audience, index) => {
  name: 'MISE_CONTAINER_AzureAd__Audiences__${index}'
  value: audience
})
var miseValidTenantEnv = map(miseValidTenantIds, (tenant, index) => {
  name: 'MISE_CONTAINER_AzureAd__ValidTenantIds__${index}'
  value: tenant
})
var miseSidecarEnv = concat([
  { name: 'MISE_CONTAINER_Container__DeploymentMode', value: 'Sidecar' }
  { name: 'MISE_CONTAINER_AzureAd__ClientId', value: miseResolvedClientId }
  { name: 'MISE_CONTAINER_AzureAd__TenantId', value: miseAuthorityTenant }
  { name: 'MISE_CONTAINER_AzureAd__PrefetchOidcMetadata', value: 'true' }
  { name: 'MISE_CONTAINER_AzureAd__ShowPII', value: 'false' }
  { name: 'MISE_CONTAINER_Logging__LogLevel__Default', value: 'Warning' }
  { name: 'MISE_CONTAINER_Logging__LogLevel__Microsoft', value: 'Warning' }
], miseAudienceEnv, miseValidTenantEnv)
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
  { name: 'SQUAD_MCP_MODEL_API', value: squad.modelApi }
  { name: 'SQUAD_MCP_MODEL_API_VERSION', value: squad.modelApiVersion }
  { name: 'SQUAD_MCP_MODEL_MAX_OUTPUT_TOKENS', value: string(squad.modelMaxOutputTokens) }
  { name: 'SQUAD_MCP_MODEL_REASONING_EFFORT', value: squad.modelReasoningEffort }
  { name: 'SQUAD_MCP_MODEL_VERBOSITY', value: squad.modelVerbosity }
  { name: 'SQUAD_MCP_TENANT_CONCURRENCY', value: string(squad.tenantConcurrency) }
  { name: 'SQUAD_MCP_TENANT_COST_CEILING_USD', value: string(squad.tenantCostCeilingUsd) }
  { name: 'SQUAD_MCP_SESSION_IDLE_MS', value: string(sessionIdleSeconds * 1000) }
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
  // A vault name is capped at 24 characters, so the prefix + uniqueString pair is
  // truncated; without this the default namePrefix already overflows the limit.
  name: take('${namePrefix}-kv-${uniqueString(resourceGroup().id)}', 24)
  location: location
  properties: {
    sku: {
      family: 'A'
      name: 'standard'
    }
    tenantId: tenantId
    enableRbacAuthorization: true
    enableSoftDelete: true
    enablePurgeProtection: true
    softDeleteRetentionInDays: 90
    publicNetworkAccess: 'Enabled'
  }
}

resource simpleOAuthSigningKeySecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (enableSimpleOAuth) {
  parent: keyVault
  name: simpleOAuthSigningKeySecretName
  properties: {
    value: simpleOAuthSigningKeysBase64
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

resource app 'Microsoft.App/containerApps@2025-01-01' = {
  name: '${namePrefix}-app'
  location: location
  dependsOn: [
    // Key Vault references are resolved while the revision is created. Make the
    // role assignment complete before ACA attempts to read the signing-key secret.
    keyVaultSecretsUser
  ]
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
      secrets: concat(encryptionSecrets, simpleOAuthSecrets)
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
      containers: concat([
        {
          name: 'hve-squad-mcp'
          image: containerImage
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: concat(webBaseEnv, storageEnv, pipelineEnv, encryptionEnv, memoryEncryptionEnv, renderEnv, memoryEnv, businessEnv, artifactsEnv, advisoryAutopilotEnv, simpleOAuthEnv, miseClientEnv)
        }
      ], enableMise
        ? [
            {
              name: 'mise'
              image: miseContainerImage
              resources: {
                cpu: json('0.5')
                memory: '1Gi'
              }
              env: miseSidecarEnv
              probes: [
                {
                  type: 'Startup'
                  httpGet: {
                    path: '/readyz'
                    port: 5000
                  }
                  initialDelaySeconds: 2
                  periodSeconds: 2
                  timeoutSeconds: 2
                  failureThreshold: 60
                }
                {
                  type: 'Liveness'
                  httpGet: {
                    path: '/healthz'
                    port: 5000
                  }
                  initialDelaySeconds: 10
                  periodSeconds: 30
                  timeoutSeconds: 2
                  failureThreshold: 3
                }
                {
                  type: 'Readiness'
                  httpGet: {
                    path: '/readyz'
                    port: 5000
                  }
                  initialDelaySeconds: 2
                  periodSeconds: 5
                  timeoutSeconds: 2
                  failureThreshold: 12
                }
              ]
            }
          ]
        : [])
      scale: {
        // COST-3 / ARCH-2: scale-to-zero with HTTP-driven scale-out.
        minReplicas: minReplicas
        maxReplicas: maxReplicas
        // An interactive caller pauses between turns to read the previous
        // artifact. With the platform default (300s) the app sleeps inside those
        // pauses and the next turn hits a cold start, which surfaces to the
        // caller as an unreachable connector rather than as latency.
        cooldownPeriod: scaleCooldownSeconds
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
      // The app validates both Entra and local OAuth bearer tokens. Exclude only
      // resource/OAuth paths so MCP clients receive the RFC 9728 challenge;
      // /admin/approve remains protected by ACA Easy Auth plus its own app role.
      excludedPaths: enableSimpleOAuth
        ? [
            '/mcp'
            '/.well-known/oauth-protected-resource'
            '/.well-known/oauth-protected-resource/mcp'
            '/.well-known/oauth-authorization-server'
            '/oauth/register'
            '/oauth/authorize'
            '/oauth/token'
          ]
        : []
    }
    identityProviders: {
      azureActiveDirectory: {
        enabled: true
        registration: {
          openIdIssuer: authOpenIdIssuer
          clientId: authClientId
        }
        validation: {
          allowedAudiences: squadAudiences
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

resource tableService 'Microsoft.Storage/storageAccounts/tableServices@2023-05-01' = if (enableTableStorage) {
  parent: storage
  name: 'default'
}

resource runTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = if (enableRemotePipeline) {
  parent: tableService
  name: runTableName
}

// Shared-state memory broker table. Separate from the run table: a memory entry is
// not a run (DR-03), and memory outlives the run that produced it.
resource memoryTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = if (enableMemoryTable) {
  parent: tableService
  name: memoryTableName
}

resource simpleOAuthTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = if (enableSimpleOAuth) {
  parent: tableService
  name: simpleOAuthTableName
}

// Let the app + worker identity read/write run + memory records. Account-scoped RBAC.
resource storageTableRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (enableTableStorage) {
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
resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = if (enableBlobStorage) {
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

// WI-03 overflow: a private container for over-threshold memory payloads. The blob
// carries the same at-rest envelope as the primary store; the pointer entity left
// behind never holds plaintext.
resource memoryOverflowBlobContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = if (enableMemoryOverflow) {
  parent: blobService
  name: memoryOverflowContainer
  properties: {
    publicAccess: 'None'
  }
}

resource storageBlobRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (enableBlobStorage) {
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
          env: concat(webBaseEnv, storageEnv, pipelineEnv, encryptionEnv, memoryEncryptionEnv, memoryEnv, artifactsEnv, advisoryAutopilotEnv, [
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

@description('The app managed-identity CLIENT id. Pass it to graph-memory-permissions.bicep, which grants that identity access to the SharePoint library backing the graph memory backend.')
output appClientId string = identity.properties.clientId

@description('Where squad memory is persisted, or empty when the memory broker is disabled.')
output memoryBackendInUse string = enableMemory ? memoryBackend : ''

@description('The simple OAuth issuer URL, or empty when the feature is disabled.')
output simpleOAuthIssuer string = enableSimpleOAuth ? simpleOAuthResolvedExternalUrl : ''
