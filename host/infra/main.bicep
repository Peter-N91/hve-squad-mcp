// hve-squad MCP server — remote thin-slice hosting (Azure Container Apps).
//
// Resource-group-scoped ORCHESTRATOR. Every resource lives in its own module under
// ./modules; this file only composes configuration and wires module outputs into
// module inputs. Every value is set in main.bicepparam — the CI/CD workflow
// (.github/workflows/azure-infra.yml) passes nothing on the command line except,
// through environment variables the parameter file reads, the image tag, the
// deployment phase, and the optional run-encryption key.
//
// Carries the council's host-side conditions:
//   * COST-3 / ARCH-2 — minReplicas 0 with ACA's idle scale-down (~5 min).
//   * SEC-8           — HTTPS-only ingress (allowInsecure: false).
//   * SEC-10          — secrets via managed identity + Key Vault; none in the image.
//                       Azure OpenAI key auth is disabled; ACR admin user is off.
//   * SEC-1           — ACA built-in Entra auth in front of the app's own
//                       audience-bound validation (defense-in-depth).
//   * SEC-3           — the model endpoint and its allow-list derive from the one
//                       Azure OpenAI account this template provisions or reuses.
//   * COST-2          — a monthly budget with 70 / 90 / 100% alerts.
//
// Two-phase deployment. deployApplication = false deploys the FOUNDATION (identity,
// logs, Key Vault, registry + AcrPull, Azure OpenAI + its grant, storage, the ACA
// environment, budget) so the image can be built into a registry the app identity
// can already pull from; deployApplication = true adds the Container App and the
// worker job. Both phases are idempotent and incremental.
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
  @description('Per-tenant concurrency cap (SEC-9 / COST-1).')
  tenantConcurrency: int
  @description('Hard monthly per-tenant cost ceiling in USD (COST-2).')
  tenantCostCeilingUsd: int
}

@description('Azure OpenAI account + model deployment the embedded engine calls (SEC-3).')
type OpenAiConfig = {
  @description('true = create the account and model deployment; false = reuse an existing account in this resource group.')
  create: bool
  @description('Account name. Omit to generate one. Also the custom subdomain unless customSubDomainName is set.')
  name: string?
  @description('Custom subdomain of an EXISTING account when it differs from its name.')
  customSubDomainName: string?
  @description('Region of a created account. Omit to use the resource group region.')
  location: string?
  @description('Model deployment name.')
  deploymentName: string
  @description('Model name, e.g. gpt-4o.')
  modelName: string
  @description('Model version, e.g. 2024-11-20.')
  modelVersion: string
  @description('Deployment SKU, e.g. Standard or GlobalStandard.')
  skuName: string
  @description('Deployment capacity in thousands of tokens per minute.')
  capacity: int
  @description('Azure OpenAI REST API version the server calls.')
  apiVersion: string
}

@description('Azure region for all resources.')
param location string = resourceGroup().location

@description('Short prefix for resource names.')
@minLength(3)
@maxLength(12)
param namePrefix string = 'squadmcp'

@description('Tags applied to every resource that supports them.')
param tags object = {}

@description('false = deploy the foundation only (phase 1, before the image exists); true = also deploy the Container App and worker job (phase 2).')
param deployApplication bool = true

@description('Image repository inside the registry this template provisions.')
param imageRepository string = 'hve-squad-mcp'

@description('Image tag to run. CI sets it to the commit SHA it built.')
param containerImageTag string = 'latest'

@description('Container registry SKU.')
@allowed([
  'Basic'
  'Standard'
  'Premium'
])
param containerRegistrySku string = 'Basic'

@description('Entra application (client) id for the ACA built-in auth (SEC-1).')
param authClientId string

@description('Entra OpenID issuer URL for the ACA built-in auth, e.g. https://login.microsoftonline.com/<tenant>/v2.0.')
param authOpenIdIssuer string

@description('Squad MCP application configuration.')
param squad SquadConfig

@description('Azure OpenAI account + model deployment.')
param openAi OpenAiConfig

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

@description('First day of the budget month (YYYY-MM-01). A NEW budget must start in the current month or up to 12 months ahead.')
param budgetStartDate string

@description('Email addresses that receive the 70/90/100% budget alerts (COST-2).')
param budgetAlertEmails string[]

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

var tenantId = subscription().tenantId
var enableMemoryTable = enableMemory && memoryBackend == 'table'
var enableTableStorage = enableRemotePipeline || enableMemoryTable
var enableBlobStorage = enableRenderPptx || enableMemoryOverflow
var enableStorage = enableTableStorage || enableBlobStorage
var storageAccountName = toLower(take('${namePrefix}st${uniqueString(resourceGroup().id)}', 24))
var registryName = take(toLower(replace('${namePrefix}acr${uniqueString(resourceGroup().id)}', '-', '')), 50)
var openAiName = openAi.?name ?? toLower('${namePrefix}-aoai-${uniqueString(resourceGroup().id)}')
var modulePrefix = take(deployment().name, 40)

var tableNames = concat(enableRemotePipeline ? [runTableName] : [], enableMemoryTable ? [memoryTableName] : [])
var blobContainerNames = concat(enableRenderPptx ? [renderBlobContainer] : [], enableMemoryOverflow ? [memoryOverflowContainer] : [])

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

// The run-encryption key itself is an ACA secret created inside the app / worker
// modules (never a plain env value); env entries only reference it.
var encryptionEnv = (enableRemotePipeline && !empty(runEncryptionKeyBase64))
  // checkov:skip=CKV_SECRET_6:The high-entropy match is the NAME of an environment variable, not a secret. Its value is a secretRef into the Container App secret store, which is the pattern this check exists to encourage.
  ? [ { name: 'SQUAD_MCP_RUN_ENCRYPTION_KEY_B64', secretRef: 'run-encryption-key' } ]
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

// Base web-app env; pipeline + encryption env are concatenated onto it below.
var webBaseEnv = [
  { name: 'PORT', value: '3000' }
  { name: 'SQUAD_MCP_AUDIENCE', value: squad.audience }
  { name: 'SQUAD_MCP_ALLOWED_ORIGINS', value: squad.allowedOrigins }
  { name: 'SQUAD_MCP_ALLOWED_ISSUERS', value: squad.allowedIssuers }
  { name: 'SQUAD_MCP_ALLOWED_TENANTS', value: squad.allowedTenants }
  { name: 'SQUAD_MCP_JWKS_URI', value: squad.jwksUri }
  { name: 'SQUAD_MCP_MODEL_ENDPOINT', value: openAiAccount.outputs.endpoint }
  { name: 'SQUAD_MCP_ALLOWED_MODEL_ENDPOINTS', value: openAiAccount.outputs.endpoint }
  { name: 'SQUAD_MCP_MODEL_DEPLOYMENT', value: openAiAccount.outputs.deploymentName }
  { name: 'SQUAD_MCP_MODEL_API_VERSION', value: openAi.apiVersion }
  { name: 'SQUAD_MCP_TENANT_CONCURRENCY', value: string(squad.tenantConcurrency) }
  { name: 'SQUAD_MCP_TENANT_COST_CEILING_USD', value: string(squad.tenantCostCeilingUsd) }
  { name: 'AZURE_CLIENT_ID', value: identity.outputs.clientId }
]

// ─── Foundation (phase 1 and 2) ──────────────────────────────────────────────

module identity 'modules/managed-identity.bicep' = {
  name: '${modulePrefix}-identity'
  params: {
    name: '${namePrefix}-id'
    location: location
    tags: tags
  }
}

module logAnalytics 'modules/log-analytics.bicep' = {
  name: '${modulePrefix}-logs'
  params: {
    name: '${namePrefix}-logs'
    location: location
    retentionInDays: logRetentionDays
    tags: tags
  }
}

module keyVault 'modules/key-vault.bicep' = {
  name: '${modulePrefix}-keyvault'
  params: {
    // A vault name is capped at 24 characters, so the prefix + uniqueString pair
    // is truncated; without this the default namePrefix already overflows.
    name: take('${namePrefix}-kv-${uniqueString(resourceGroup().id)}', 24)
    location: location
    tenantId: tenantId
    readerPrincipalId: identity.outputs.principalId
    readerIdentityId: identity.outputs.id
    tags: tags
  }
}

module registry 'modules/container-registry.bicep' = {
  name: '${modulePrefix}-registry'
  params: {
    // namePrefix (>= 3) + 'acr' + a 13-character hash is always >= 5 characters.
    #disable-next-line BCP334
    name: registryName
    location: location
    sku: containerRegistrySku
    pullPrincipalId: identity.outputs.principalId
    pullIdentityId: identity.outputs.id
    tags: tags
  }
}

module openAiAccount 'modules/openai.bicep' = {
  name: '${modulePrefix}-openai'
  params: {
    create: openAi.create
    name: openAiName
    customSubDomainName: openAi.?customSubDomainName ?? openAiName
    location: openAi.?location ?? location
    deploymentName: openAi.deploymentName
    modelName: openAi.modelName
    modelVersion: openAi.modelVersion
    skuName: openAi.skuName
    capacity: openAi.capacity
    userPrincipalId: identity.outputs.principalId
    userIdentityId: identity.outputs.id
    tags: tags
  }
}

module storage 'modules/storage.bicep' = if (enableStorage) {
  name: '${modulePrefix}-storage'
  params: {
    name: storageAccountName
    location: location
    tableNames: tableNames
    blobContainerNames: blobContainerNames
    dataPrincipalId: identity.outputs.principalId
    dataIdentityId: identity.outputs.id
    tags: tags
  }
}

module environment 'modules/container-apps-environment.bicep' = {
  name: '${modulePrefix}-environment'
  params: {
    name: '${namePrefix}-env'
    location: location
    logAnalyticsWorkspaceName: logAnalytics.outputs.name
    tags: tags
  }
}

module budget 'modules/budget.bicep' = {
  name: '${modulePrefix}-budget'
  params: {
    name: '${namePrefix}-budget'
    amount: budgetAmountUsd
    startDate: budgetStartDate
    contactEmails: budgetAlertEmails
  }
}

// ─── Application (phase 2) ───────────────────────────────────────────────────

var containerImage = '${registry.outputs.loginServer}/${imageRepository}:${containerImageTag}'

module app 'modules/container-app.bicep' = if (deployApplication) {
  name: '${modulePrefix}-app'
  params: {
    name: '${namePrefix}-app'
    location: location
    environmentId: environment.outputs.id
    identityId: identity.outputs.id
    registryServer: registry.outputs.loginServer
    image: containerImage
    env: concat(webBaseEnv, storageEnv, pipelineEnv, encryptionEnv, memoryEncryptionEnv, renderEnv, memoryEnv, businessEnv, artifactsEnv, advisoryAutopilotEnv)
    runEncryptionKeyBase64: runEncryptionKeyBase64
    minReplicas: minReplicas
    maxReplicas: maxReplicas
    authClientId: authClientId
    authOpenIdIssuer: authOpenIdIssuer
    audience: squad.audience
    tags: tags
  }
  dependsOn: [
    // Secrets and storage grants must exist before the first revision starts. The
    // AcrPull and Azure OpenAI grants are already implied by the outputs used above.
    keyVault
    storage
  ]
}

module workerJob 'modules/worker-job.bicep' = if (deployApplication && enableWorker) {
  name: '${modulePrefix}-worker'
  params: {
    name: '${namePrefix}-worker'
    location: location
    environmentId: environment.outputs.id
    identityId: identity.outputs.id
    registryServer: registry.outputs.loginServer
    image: containerImage
    env: concat(webBaseEnv, storageEnv, pipelineEnv, encryptionEnv, memoryEncryptionEnv, memoryEnv, artifactsEnv, advisoryAutopilotEnv)
    runEncryptionKeyBase64: runEncryptionKeyBase64
    cronExpression: workerCron
    tags: tags
  }
  dependsOn: [
    keyVault
    storage
  ]
}

@description('The HTTPS FQDN of the deployed /mcp endpoint (empty in the foundation phase).')
output mcpFqdn string = app.?outputs.fqdn ?? ''

@description('The container registry name (the target of az acr build).')
output containerRegistryName string = registry.outputs.name

@description('The container registry login server.')
output containerRegistryLoginServer string = registry.outputs.loginServer

@description('The image reference the app runs.')
output containerImage string = containerImage

@description('The Azure OpenAI endpoint the server calls.')
output modelEndpoint string = openAiAccount.outputs.endpoint

@description('The app managed-identity principal id (already granted Cognitive Services OpenAI User on the AOAI account).')
output appPrincipalId string = identity.outputs.principalId

@description('The Key Vault name for operator secrets.')
output keyVaultName string = keyVault.outputs.name

@description('The Azure Storage account backing the async run-state store (empty when the pipeline is disabled).')
output runStateStorageAccount string = enableRemotePipeline ? storageAccountName : ''

@description('The app managed-identity CLIENT id. Pass it to graph-memory-permissions.bicep, which grants that identity access to the SharePoint library backing the graph memory backend.')
output appClientId string = identity.outputs.clientId

@description('Where squad memory is persisted, or empty when the memory broker is disabled.')
output memoryBackendInUse string = enableMemory ? memoryBackend : ''
