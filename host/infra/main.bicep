// hve-squad MCP server — remote thin-slice hosting (Azure Container Apps).
//
// Resource-group-scoped orchestrator for the scale-to-zero ACA app that serves the
// Streamable HTTP `/mcp` endpoint with Entra auth and managed-identity secrets.
// Every resource lives in one module under ./modules; see modules/*.bicep for the
// resource-level council conditions (COST-2, COST-3 / ARCH-2, SEC-1, SEC-8,
// SEC-10, S1, S2, S5, S10, A5-A7). This file keeps every parameter, the
// SquadConfig type, the env-var assembly (research D2), and the six outputs.
//
// DEPLOYMENT MODE (A11): deploy this template with `--mode Incremental` (ARM's own
// default when --mode is omitted). NEVER use `--mode Complete` against a resource
// group this template shares with any manually-created resource: Complete mode
// deletes every resource the template does not declare.
//
// Behavior preservation (U4): with no parameter changes, this template declares
// exactly the resources, names, role-assignment guid() inputs, env vars, and
// outputs of the pre-modularization template. The new AcrPull and Azure OpenAI
// role assignments are off (manageAcrPullAssignment / manageOpenAiRoleAssignment
// default false) and openAiMode defaults to 'existing' (no new resource, no spend).
//
// Per-tenant RATE caps (SEC-9 / COST-1, host side) require an APIM / Front Door
// layer and are documented as a Phase-1 boundary in host/RUNBOOK.md; the engine
// enforces per-tenant concurrency + the hard cost ceiling itself.

import { OpenAiDeployment } from 'modules/types.bicep'

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

@description('First day of the budget month (YYYY-MM-01; a full ISO timestamp is truncated to its date). Empty (the default) = the first day of the CURRENT UTC month at deploy time — valid only for the budget\'s FIRST deployment. Azure rejects any change to an existing budget\'s start date, so every later deployment must pin the date the budget was created with (host/infra/environments/README.md, "Budget start date").')
param budgetStartDate string = ''

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

// ---------------------------------------------------------------------------
// Parameters added by the modularization (all default to today's behavior).
// ---------------------------------------------------------------------------

@description('ARM resource id of the Azure Container Registry the image is pulled from. Required only when manageAcrPullAssignment is true (AC-A11); its subscription and resource group are parsed from the id (S5 / C10).')
param containerRegistryResourceId string = ''

@description('Create the AcrPull role assignment for the app identity on containerRegistryResourceId. Default false so an already-deployed environment gets no new (possibly conflicting) role assignment (U4). New environments set true; existing ones follow the RUNBOOK migration (delete the manual grant, then flip).')
param manageAcrPullAssignment bool = false

@description('Create the Cognitive Services OpenAI User role assignment for the app identity on the Azure OpenAI account (RUNBOOK Step 7). Default false (U4); same migration as manageAcrPullAssignment.')
param manageOpenAiRoleAssignment bool = false

@description('existing = use squad.modelEndpoint / squad.modelDeployment unchanged (no new resource, no spend). create = provision the Azure OpenAI account + deployments (real spend; K1).')
@allowed([
  'existing'
  'create'
])
param openAiMode string = 'existing'

@description('Azure OpenAI account name (also its custom subdomain). Required only when openAiMode is create or manageOpenAiRoleAssignment is true (AC-A11).')
param openAiAccountName string = ''

@description('Resource group of the Azure OpenAI account (same subscription). Empty or omitted = this deployment\'s resource group.')
param openAiResourceGroupName string = resourceGroup().name

@description('Azure region for a create-mode Azure OpenAI account. Empty or omitted = location.')
param openAiLocation string = location

@description('Create-mode Azure OpenAI account SKU.')
param openAiSkuName string = 'S0'

@description('Create-mode Azure OpenAI public network access, always set explicitly (S10).')
@allowed([
  'Enabled'
  'Disabled'
])
param openAiPublicNetworkAccess string = 'Enabled'

@description('Create-mode model deployments. Required (non-empty) in create mode; the first entry becomes the effective model deployment. skuName/capacity default to GlobalStandard / 10 (K1).')
param openAiDeployments OpenAiDeployment[] = []

// Deterministic resource ids / names (AC-A9, A8): module inputs that feed a
// guid() name, a registries[].identity, or an `existing` reference are computed
// here with resourceId()/name expressions, never taken from a module output.
var identityId = resourceId('Microsoft.ManagedIdentity/userAssignedIdentities', '${namePrefix}-id')
var logAnalyticsWorkspaceName = '${namePrefix}-logs'
var managedEnvironmentId = resourceId('Microsoft.App/managedEnvironments', '${namePrefix}-env')

// A parameter file cannot conditionally omit a value, so an environment file that
// reads an unset optional env var passes ''. Treat '' exactly like "omitted".
var effectiveOpenAiResourceGroupName = empty(openAiResourceGroupName) ? resourceGroup().name : openAiResourceGroupName
var effectiveOpenAiLocation = empty(openAiLocation) ? location : openAiLocation

// Budget start date: '' = first day of the current UTC month (computed inside
// modules/budget.bicep, where utcNow() is allowed as a parameter default). A value
// must be YYYY-MM-01 (a full ISO timestamp, e.g. from `az resource show`, is
// truncated to its date). The message never echoes more than the format rule.
var normalizedBudgetStartDate = take(budgetStartDate, 10)
var validatedBudgetStartDate = empty(budgetStartDate) || (length(normalizedBudgetStartDate) == 10 && endsWith(normalizedBudgetStartDate, '-01') && substring(normalizedBudgetStartDate, 4, 1) == '-')
  ? normalizedBudgetStartDate
  : fail('budgetStartDate must be empty (= first day of the current UTC month, first deployment only) or YYYY-MM-01. Azure rejects changing an existing budget\'s start date, so pin the date it was created with.')

// ---------------------------------------------------------------------------
// Fail-fast guards (AC-A10 / AC-A11 / A6 / security C8). Bicep's GA fail()
// function inside a ternary: ARM evaluates only the chosen branch, so a guard
// fires only when its feature is actually requested. Each guarded value is
// consumed by the module that needs it, so the failure happens before that
// module is deployed (module scopes and deterministic module inputs are
// evaluated before any nested resource is created).
// ---------------------------------------------------------------------------

// A6: the app compares SQUAD_MCP_MODEL_ENDPOINT against the comma-split, trimmed
// SQUAD_MCP_ALLOWED_MODEL_ENDPOINTS with an exact match
// (src/config/operator-config.ts splitList + includes). Mirror that here.
var allowedModelEndpointList = map(split(squad.allowedModelEndpoints, ','), endpoint => trim(endpoint))
// Deterministic create-mode endpoint, NO trailing slash (A6).
var createModeEndpoint = 'https://${openAiAccountName}.openai.azure.com'
// Every guard below is SELF-GATING on its own feature flag, so it is safe whether
// ARM evaluates a variable eagerly or only when referenced.
var createModeAccountName = openAiMode != 'create'
  ? openAiAccountName
  : empty(openAiAccountName)
      ? fail('openAiAccountName is required when openAiMode is "create".')
      : !contains(allowedModelEndpointList, createModeEndpoint)
          ? fail('openAiMode "create": the endpoint https://<openAiAccountName>.openai.azure.com (no trailing slash) must be listed in squad.allowedModelEndpoints (SEC-3 / A6).')
          : empty(openAiDeployments)
              ? fail('openAiMode "create" requires at least one entry in openAiDeployments.')
              : openAiAccountName
var roleAssignmentOpenAiAccountName = !manageOpenAiRoleAssignment
  ? openAiAccountName
  : empty(openAiAccountName)
      ? fail('openAiAccountName is required when manageOpenAiRoleAssignment is true.')
      : openAiAccountName

// Effective model endpoint / deployment. existing mode = the squad config values,
// unchanged. create mode = the deterministic values, routed through
// createModeAccountName so that EVERY create-mode consumer runs the guards above
// first (createModeAccountName is never empty once it returns).
var effectiveModelEndpoint = openAiMode == 'create' ? 'https://${createModeAccountName}.openai.azure.com' : squad.modelEndpoint
var effectiveModelDeployment = openAiMode == 'create'
  ? (empty(createModeAccountName) ? '' : openAiDeployments[0].name)
  : squad.modelDeployment

// AC-A14 / S5 / C10: the registry's subscription AND resource group are parsed
// from its resource id (never assumed to be this deployment's subscription).
var acrIdSegments = split(containerRegistryResourceId, '/')
var validatedContainerRegistryResourceId = !manageAcrPullAssignment
  ? containerRegistryResourceId
  : length(acrIdSegments) != 9
      ? fail('containerRegistryResourceId must be /subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.ContainerRegistry/registries/<name> when manageAcrPullAssignment is true.')
      : toLower('${acrIdSegments[6]}/${acrIdSegments[7]}') != 'microsoft.containerregistry/registries'
          ? fail('containerRegistryResourceId must be a Microsoft.ContainerRegistry/registries resource id.')
          : containerRegistryResourceId
var acrSubscriptionId = manageAcrPullAssignment ? split(validatedContainerRegistryResourceId, '/')[2] : subscription().subscriptionId
var acrResourceGroupName = manageAcrPullAssignment ? split(validatedContainerRegistryResourceId, '/')[4] : resourceGroup().name

// Security C8: the run-encryption key is supplied only by CI (a GitHub secret
// passed as `--parameters runEncryptionKeyBase64=...` or read through
// readEnvironmentVariable() in an uncommitted .bicepparam), never committed.
// Fail gate: a non-empty value must be the base64 encoding of exactly 32 bytes
// (44 characters, one '=' pad), the AES-256-GCM key the app expects. The message
// never echoes the value.
var validatedRunEncryptionKeyBase64 = empty(runEncryptionKeyBase64) || (length(runEncryptionKeyBase64) == 44 && endsWith(runEncryptionKeyBase64, '=') && !endsWith(runEncryptionKeyBase64, '=='))
  ? runEncryptionKeyBase64
  : fail('runEncryptionKeyBase64 must be empty or the base64 encoding of exactly 32 bytes (44 characters). Supply it from a CI secret, never a committed .bicepparam (security C8).')

// Which storage services are needed, and therefore which account/roles deploy.
// Table: async run state (WI-06) and/or the table-backed memory broker.
// Blob:  rendered decks and/or the memory overflow channel (WI-03).
var enableMemoryTable = enableMemory && memoryBackend == 'table'
var enableTableStorage = enableRemotePipeline || enableMemoryTable
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

// Encryption key passed as an ACA secret (never a plain env value). The secrets
// array itself is built inside container-app.bicep / worker-job.bicep from the
// @secure() string (S1); only the secretRef env entries are assembled here.
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
  { name: 'SQUAD_MCP_MODEL_ENDPOINT', value: effectiveModelEndpoint }
  { name: 'SQUAD_MCP_ALLOWED_MODEL_ENDPOINTS', value: squad.allowedModelEndpoints }
  { name: 'SQUAD_MCP_MODEL_DEPLOYMENT', value: effectiveModelDeployment }
  { name: 'SQUAD_MCP_MODEL_API_VERSION', value: squad.modelApiVersion }
  { name: 'SQUAD_MCP_TENANT_CONCURRENCY', value: string(squad.tenantConcurrency) }
  { name: 'SQUAD_MCP_TENANT_COST_CEILING_USD', value: string(squad.tenantCostCeilingUsd) }
  { name: 'AZURE_CLIENT_ID', value: managedIdentity.outputs.clientId }
]

// ---------------------------------------------------------------------------
// Modules — one per resource (storage combined, D3). Module deployment names are
// derived from this deployment's name so concurrent environments in one resource
// group do not overwrite each other's nested-deployment history.
// ---------------------------------------------------------------------------

module logAnalytics 'modules/log-analytics.bicep' = {
  name: take('${deployment().name}-log-analytics', 64)
  params: {
    location: location
    namePrefix: namePrefix
    logRetentionDays: logRetentionDays
  }
}

module managedIdentity 'modules/managed-identity.bicep' = {
  name: take('${deployment().name}-managed-identity', 64)
  params: {
    location: location
    namePrefix: namePrefix
  }
}

module keyVault 'modules/key-vault.bicep' = {
  name: take('${deployment().name}-key-vault', 64)
  params: {
    location: location
    namePrefix: namePrefix
    identityId: identityId
    principalId: managedIdentity.outputs.principalId
  }
}

module environment 'modules/container-apps-environment.bicep' = {
  name: take('${deployment().name}-aca-environment', 64)
  params: {
    location: location
    namePrefix: namePrefix
    logAnalyticsWorkspaceName: logAnalyticsWorkspaceName
  }
  // The workspace is addressed by its deterministic name (A8), so the ordering
  // dependency is explicit rather than inferred from an output.
  dependsOn: [
    logAnalytics
  ]
}

// D1 / U4: AcrPull for the app identity, only when the operator opts in. Scoped to
// the registry's own subscription + resource group, parsed from its id (S5 / C10).
module containerRegistryAccess 'modules/container-registry-access.bicep' = if (manageAcrPullAssignment) {
  name: take('${deployment().name}-acr-pull', 64)
  scope: resourceGroup(acrSubscriptionId, acrResourceGroupName)
  params: {
    containerRegistryResourceId: validatedContainerRegistryResourceId
    containerRegistryServer: containerRegistryServer
    principalId: managedIdentity.outputs.principalId
    identityId: identityId
  }
}

module app 'modules/container-app.bicep' = {
  name: take('${deployment().name}-container-app', 64)
  params: {
    location: location
    namePrefix: namePrefix
    managedEnvironmentId: managedEnvironmentId
    identityId: identityId
    containerImage: containerImage
    containerRegistryServer: containerRegistryServer
    runEncryptionKeyBase64: validatedRunEncryptionKeyBase64
    env: concat(webBaseEnv, storageEnv, pipelineEnv, encryptionEnv, memoryEncryptionEnv, renderEnv, memoryEnv, businessEnv, artifactsEnv, advisoryAutopilotEnv)
    minReplicas: minReplicas
    maxReplicas: maxReplicas
    authClientId: authClientId
    authOpenIdIssuer: authOpenIdIssuer
    audience: squad.audience
  }
  // A7: the first image pull must not race the AcrPull grant (when managed here).
  // RBAC propagation can still lag on a brand-new tenant; RUNBOOK documents a
  // single retry for a first-deploy pull failure.
  dependsOn: [
    environment
    containerRegistryAccess
  ]
}

module storage 'modules/storage-account.bicep' = if (enableStorage) {
  name: take('${deployment().name}-storage', 64)
  params: {
    location: location
    storageAccountName: storageAccountName
    identityId: identityId
    principalId: managedIdentity.outputs.principalId
    enableStorage: enableStorage
    enableTableStorage: enableTableStorage
    enableBlobStorage: enableBlobStorage
    enableRemotePipeline: enableRemotePipeline
    enableMemoryTable: enableMemoryTable
    enableRenderPptx: enableRenderPptx
    enableMemoryOverflow: enableMemoryOverflow
    runTableName: runTableName
    memoryTableName: memoryTableName
    renderBlobContainer: renderBlobContainer
    memoryOverflowContainer: memoryOverflowContainer
  }
}

module workerJob 'modules/worker-job.bicep' = if (enableWorker) {
  name: take('${deployment().name}-worker-job', 64)
  params: {
    location: location
    namePrefix: namePrefix
    managedEnvironmentId: managedEnvironmentId
    identityId: identityId
    containerImage: containerImage
    containerRegistryServer: containerRegistryServer
    runEncryptionKeyBase64: validatedRunEncryptionKeyBase64
    workerCron: workerCron
    env: concat(webBaseEnv, storageEnv, pipelineEnv, encryptionEnv, memoryEncryptionEnv, memoryEnv, artifactsEnv, advisoryAutopilotEnv, [
      { name: 'SQUAD_MCP_WORKER_ONCE', value: 'true' }
    ])
  }
  // A7: the worker pulls the image independently of the web app.
  dependsOn: [
    environment
    containerRegistryAccess
  ]
}

module budget 'modules/budget.bicep' = {
  name: take('${deployment().name}-budget', 64)
  params: {
    namePrefix: namePrefix
    budgetAmountUsd: budgetAmountUsd
    budgetStartDate: validatedBudgetStartDate
    budgetAlertEmails: budgetAlertEmails
  }
}

// D8 / A5 / AC-A8: create-mode Azure OpenAI, always at the account's own resource
// group. Not deployed at all in 'existing' mode (no write, no spend).
module openai 'modules/openai.bicep' = if (openAiMode == 'create') {
  name: take('${deployment().name}-openai', 64)
  scope: resourceGroup(effectiveOpenAiResourceGroupName)
  params: {
    openAiMode: openAiMode
    openAiAccountName: createModeAccountName
    location: effectiveOpenAiLocation
    openAiSkuName: openAiSkuName
    openAiPublicNetworkAccess: openAiPublicNetworkAccess
    openAiDeployments: openAiDeployments
  }
}

// RUNBOOK Step 7 / A5 / U4: the OpenAI User grant, always an explicit-scope
// module, only when the operator opts in; waits for a create-mode account.
module openAiRoleAssignment 'modules/openai-role-assignment.bicep' = if (manageOpenAiRoleAssignment) {
  name: take('${deployment().name}-openai-rbac', 64)
  scope: resourceGroup(effectiveOpenAiResourceGroupName)
  params: {
    openAiAccountName: roleAssignmentOpenAiAccountName
    principalId: managedIdentity.outputs.principalId
    identityId: identityId
  }
  dependsOn: [
    openai
  ]
}

@description('The HTTPS FQDN of the deployed /mcp endpoint.')
output mcpFqdn string = app.outputs.fqdn

@description('The app managed-identity principal id (grant it Cognitive Services OpenAI User on the AOAI account).')
output appPrincipalId string = managedIdentity.outputs.principalId

@description('The Key Vault name for operator secrets.')
output keyVaultName string = keyVault.outputs.name

@description('The Azure Storage account backing the async run-state store (empty when the pipeline is disabled).')
output runStateStorageAccount string = enableRemotePipeline ? storageAccountName : ''

@description('The app managed-identity CLIENT id. Pass it to graph-memory-permissions.bicep, which grants that identity access to the SharePoint library backing the graph memory backend.')
output appClientId string = managedIdentity.outputs.clientId

@description('Where squad memory is persisted, or empty when the memory broker is disabled.')
output memoryBackendInUse string = enableMemory ? memoryBackend : ''

