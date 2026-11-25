using '../main.bicep'

// Production environment parameters for CI/CD. EVERY value comes from an
// environment variable (prefix SQUAD_INFRA_), so no tenant-specific value and no
// secret is ever committed. The full contract (name, param, required, default,
// secret) is in ./README.md; cicd maps GitHub variables/secrets to exactly those
// names. main.bicepparam stays the documented template for local/manual deploys.
//
// Conventions (README "Conventions"):
//   * Every env var is a SCALAR string. Lists are comma-separated; items are
//     trimmed and empty items dropped (split + trim + filter).
//   * Booleans are true/false (case-insensitive); anything else fails the build.
//     Integers must parse with int(); anything else fails the build.
//   * A required var with no default fails `az bicep build-params` / the deploy
//     with BCP427 "Environment variable ... does not exist"; a conditionally
//     required var fails with a named fail() message.
//   * An optional var that is unset passes the same default main.bicep declares
//     ('' where main.bicep treats empty as "use the default").
//   * `location` is deliberately NOT set: it follows the target resource group.
//
// The run-encryption key is read with a '' default and is @secure() in
// main.bicep. `az bicep build-params` writes resolved values in clear text, so a
// preflight build must run WITHOUT SQUAD_INFRA_RUN_ENCRYPTION_KEY_B64 set, and a
// built parameters file must never be uploaded as an artifact (README "Secrets").

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

var entraClientId = readEnvironmentVariable('SQUAD_INFRA_ENTRA_CLIENT_ID')
var entraTenantId = readEnvironmentVariable('SQUAD_INFRA_ENTRA_TENANT_ID')
var entraAuthorityHost = readEnvironmentVariable('SQUAD_INFRA_ENTRA_AUTHORITY_HOST', 'https://login.microsoftonline.com')
var entraV2Issuer = '${entraAuthorityHost}/${entraTenantId}/v2.0'

var openAiModeValue = toLower(readEnvironmentVariable('SQUAD_INFRA_OPENAI_MODE', 'existing'))
var openAiAccountNameValue = readEnvironmentVariable('SQUAD_INFRA_OPENAI_ACCOUNT_NAME', '')
var openAiDeploymentName = readEnvironmentVariable('SQUAD_INFRA_OPENAI_DEPLOYMENT_NAME', '')
var openAiModelName = readEnvironmentVariable('SQUAD_INFRA_OPENAI_MODEL_NAME', '')
var openAiModelVersion = readEnvironmentVariable('SQUAD_INFRA_OPENAI_MODEL_VERSION', '')
var openAiDeploymentList = empty(openAiDeploymentName)
  ? []
  : [
      {
        name: openAiDeploymentName
        modelName: openAiModelName
        modelVersion: openAiModelVersion
        modelFormat: readEnvironmentVariable('SQUAD_INFRA_OPENAI_MODEL_FORMAT', 'OpenAI')
        skuName: readEnvironmentVariable('SQUAD_INFRA_OPENAI_DEPLOYMENT_SKU', 'GlobalStandard') // K1 indicative default
        capacity: int(readEnvironmentVariable('SQUAD_INFRA_OPENAI_DEPLOYMENT_CAPACITY', '10')) // K1 indicative default
      }
    ]

// Model endpoint / deployment: required in 'existing' mode. In 'create' mode
// main.bicep derives both from the account it creates, so they default to the
// deterministic create-mode values (and the allow-list defaults to match, A6).
// NOTE: every fail() in this file sits in a PARAM expression, not a var — a
// fail() inside a .bicepparam var still fails the build but loses its message.
var modelEndpointInput = readEnvironmentVariable('SQUAD_INFRA_MODEL_ENDPOINT', '')
var modelEndpointValue = !empty(modelEndpointInput)
  ? modelEndpointInput
  : openAiModeValue == 'create' ? 'https://${openAiAccountNameValue}.openai.azure.com' : ''
var modelDeploymentInput = readEnvironmentVariable('SQUAD_INFRA_MODEL_DEPLOYMENT', '')
var modelDeploymentValue = !empty(modelDeploymentInput)
  ? modelDeploymentInput
  : openAiModeValue == 'create' ? openAiDeploymentName : ''
var allowedModelEndpointsInput = readEnvironmentVariable('SQUAD_INFRA_ALLOWED_MODEL_ENDPOINTS', '')

var allowedOriginsValue = readEnvironmentVariable('SQUAD_INFRA_ALLOWED_ORIGINS', 'https://copilotstudio.microsoft.com')

var budgetAlertEmailList = filter(map(split(readEnvironmentVariable('SQUAD_INFRA_BUDGET_ALERT_EMAILS'), ','), email => trim(email)), email => !empty(email))

// ---------------------------------------------------------------------------
// Parameters (every main.bicep parameter except `location`)
// ---------------------------------------------------------------------------

param namePrefix = readEnvironmentVariable('SQUAD_INFRA_NAME_PREFIX', 'squadmcp')
param containerImage = readEnvironmentVariable('SQUAD_INFRA_CONTAINER_IMAGE')
param containerRegistryServer = readEnvironmentVariable('SQUAD_INFRA_CONTAINER_REGISTRY_SERVER')
param authClientId = entraClientId
param authOpenIdIssuer = readEnvironmentVariable('SQUAD_INFRA_AUTH_OPENID_ISSUER', entraV2Issuer)

param squad = {
  // v2 tokens: `aud` is the appId GUID (entra-app `tokenAudience` output). A
  // legacy v1-token environment sets SQUAD_INFRA_AUDIENCE='api://<client id>'.
  audience: readEnvironmentVariable('SQUAD_INFRA_AUDIENCE', entraClientId)
  allowedOrigins: contains(map(split(allowedOriginsValue, ','), origin => trim(origin)), '*')
    ? fail('SQUAD_INFRA_ALLOWED_ORIGINS must not contain "*" (SEC-8: strict Origin allow-list).')
    : allowedOriginsValue
  allowedIssuers: readEnvironmentVariable('SQUAD_INFRA_ALLOWED_ISSUERS', entraV2Issuer)
  allowedTenants: readEnvironmentVariable('SQUAD_INFRA_ALLOWED_TENANTS', entraTenantId)
  jwksUri: readEnvironmentVariable('SQUAD_INFRA_JWKS_URI', '${entraAuthorityHost}/${entraTenantId}/discovery/v2.0/keys')
  modelEndpoint: empty(modelEndpointValue)
    ? fail('SQUAD_INFRA_MODEL_ENDPOINT is required when SQUAD_INFRA_OPENAI_MODE is "existing" (https://<aoai>.openai.azure.com, no trailing slash).')
    : modelEndpointValue
  allowedModelEndpoints: empty(allowedModelEndpointsInput) ? modelEndpointValue : allowedModelEndpointsInput
  modelDeployment: empty(modelDeploymentValue)
    ? fail('SQUAD_INFRA_MODEL_DEPLOYMENT is required when SQUAD_INFRA_OPENAI_MODE is "existing".')
    : modelDeploymentValue
  modelApiVersion: readEnvironmentVariable('SQUAD_INFRA_MODEL_API_VERSION', '2024-10-21')
  tenantConcurrency: int(readEnvironmentVariable('SQUAD_INFRA_TENANT_CONCURRENCY', '4'))
  tenantCostCeilingUsd: int(readEnvironmentVariable('SQUAD_INFRA_TENANT_COST_CEILING_USD', '500'))
}

param minReplicas = int(readEnvironmentVariable('SQUAD_INFRA_MIN_REPLICAS', '0'))
param maxReplicas = int(readEnvironmentVariable('SQUAD_INFRA_MAX_REPLICAS', '5'))
param logRetentionDays = int(readEnvironmentVariable('SQUAD_INFRA_LOG_RETENTION_DAYS', '30'))

param budgetAmountUsd = int(readEnvironmentVariable('SQUAD_INFRA_BUDGET_AMOUNT_USD', '500'))
// '' = first day of the current UTC month: FIRST deployment only. Every later
// deployment must pin the created date (README "Budget start date").
param budgetStartDate = readEnvironmentVariable('SQUAD_INFRA_BUDGET_START_DATE', '')
param budgetAlertEmails = empty(budgetAlertEmailList)
  ? fail('SQUAD_INFRA_BUDGET_ALERT_EMAILS must list at least one address (comma-separated).')
  : budgetAlertEmailList

// Optional features (all default off, exactly as main.bicep).
param enableRemotePipeline = bool(toLower(readEnvironmentVariable('SQUAD_INFRA_ENABLE_REMOTE_PIPELINE', 'false')))
param enableWorker = bool(toLower(readEnvironmentVariable('SQUAD_INFRA_ENABLE_WORKER', 'false')))
param runTableName = readEnvironmentVariable('SQUAD_INFRA_RUN_TABLE_NAME', 'squadruns')
param runEncryptionKeyBase64 = readEnvironmentVariable('SQUAD_INFRA_RUN_ENCRYPTION_KEY_B64', '')
param workerCron = readEnvironmentVariable('SQUAD_INFRA_WORKER_CRON', '*/5 * * * *')
param enableRenderPptx = bool(toLower(readEnvironmentVariable('SQUAD_INFRA_ENABLE_RENDER_PPTX', 'false')))
param renderBlobContainer = readEnvironmentVariable('SQUAD_INFRA_RENDER_BLOB_CONTAINER', 'renders')
param renderSasTtlMinutes = int(readEnvironmentVariable('SQUAD_INFRA_RENDER_SAS_TTL_MINUTES', '60'))
param renderBrandTemplatePath = readEnvironmentVariable('SQUAD_INFRA_RENDER_BRAND_TEMPLATE_PATH', '')
param enableMemory = bool(toLower(readEnvironmentVariable('SQUAD_INFRA_ENABLE_MEMORY', 'false')))
param memoryBackend = readEnvironmentVariable('SQUAD_INFRA_MEMORY_BACKEND', 'table')
param memoryTableName = readEnvironmentVariable('SQUAD_INFRA_MEMORY_TABLE_NAME', 'squadmemory')
param enableMemoryAuto = bool(toLower(readEnvironmentVariable('SQUAD_INFRA_ENABLE_MEMORY_AUTO', 'false')))
param memoryDefaultProject = readEnvironmentVariable('SQUAD_INFRA_MEMORY_DEFAULT_PROJECT', 'default')
param enableArtifacts = bool(toLower(readEnvironmentVariable('SQUAD_INFRA_ENABLE_ARTIFACTS', 'false')))
param enableAdvisoryAutopilot = bool(toLower(readEnvironmentVariable('SQUAD_INFRA_ENABLE_ADVISORY_AUTOPILOT', 'false')))
param memoryGraphDriveId = readEnvironmentVariable('SQUAD_INFRA_MEMORY_GRAPH_DRIVE_ID', '')
param memoryGraphRootPath = readEnvironmentVariable('SQUAD_INFRA_MEMORY_GRAPH_ROOT_PATH', 'squad-memory')
param memoryGraphEndpoint = readEnvironmentVariable('SQUAD_INFRA_MEMORY_GRAPH_ENDPOINT', '')
param memoryGraphEncrypt = bool(toLower(readEnvironmentVariable('SQUAD_INFRA_MEMORY_GRAPH_ENCRYPT', 'false')))
param memoryTargets = readEnvironmentVariable('SQUAD_INFRA_MEMORY_TARGETS', '')
param memoryDefaultTarget = readEnvironmentVariable('SQUAD_INFRA_MEMORY_DEFAULT_TARGET', '')
param enableMemoryOverflow = bool(toLower(readEnvironmentVariable('SQUAD_INFRA_ENABLE_MEMORY_OVERFLOW', 'false')))
param memoryOverflowContainer = readEnvironmentVariable('SQUAD_INFRA_MEMORY_OVERFLOW_CONTAINER', 'squadmemory')
param enableBusinessTools = bool(toLower(readEnvironmentVariable('SQUAD_INFRA_ENABLE_BUSINESS_TOOLS', 'false')))

// Role assignments this template can manage (U4: default false; follow the RUNBOOK
// migration before flipping either on an existing environment).
param containerRegistryResourceId = readEnvironmentVariable('SQUAD_INFRA_CONTAINER_REGISTRY_RESOURCE_ID', '')
param manageAcrPullAssignment = bool(toLower(readEnvironmentVariable('SQUAD_INFRA_MANAGE_ACR_PULL_ASSIGNMENT', 'false')))
param manageOpenAiRoleAssignment = bool(toLower(readEnvironmentVariable('SQUAD_INFRA_MANAGE_OPENAI_ROLE_ASSIGNMENT', 'false')))

// Azure OpenAI (D8: 'existing' by default — no new resource, no spend).
param openAiMode = openAiModeValue
param openAiAccountName = openAiAccountNameValue
param openAiResourceGroupName = readEnvironmentVariable('SQUAD_INFRA_OPENAI_RESOURCE_GROUP', '')
param openAiLocation = readEnvironmentVariable('SQUAD_INFRA_OPENAI_LOCATION', '')
param openAiSkuName = readEnvironmentVariable('SQUAD_INFRA_OPENAI_SKU', 'S0')
param openAiPublicNetworkAccess = readEnvironmentVariable('SQUAD_INFRA_OPENAI_PUBLIC_NETWORK_ACCESS', 'Enabled')
param openAiDeployments = !empty(openAiDeploymentName) && (empty(openAiModelName) || empty(openAiModelVersion))
  ? fail('SQUAD_INFRA_OPENAI_MODEL_NAME and SQUAD_INFRA_OPENAI_MODEL_VERSION are required when SQUAD_INFRA_OPENAI_DEPLOYMENT_NAME is set.')
  : openAiDeploymentList
