<#
.SYNOPSIS
  One-time bootstrap for the hve-squad MCP CI/CD pipeline.

.DESCRIPTION
  Everything the GitHub Actions workflow (.github/workflows/azure-infra.yml) cannot
  do for itself, because it has no identity until this script gives it one:

    1. Registers the resource providers main.bicep uses (the CI identities hold
       resource-group roles only, so they cannot), then deploys
       host/infra/bootstrap/main.bicep (subscription scope): the workload and CI/CD
       resource groups, a read-only PLAN identity federated to the what-if
       environment, a DEPLOY identity federated only to the approval-gated
       environment, and their resource-group-scoped roles.
    2. Creates or updates the Entra app registration for the MCP resource server
       (RUNBOOK Step 2): Application ID URI api://<appId>, v2 access tokens, one
       delegated scope per tool, and the Squad.Operate app role.
    3. Writes the tenant id and the app's client id into host/infra/main.bicepparam
       when they are still placeholders.
    4. Creates the GitHub environments (azure-plan; azure-production with required
       reviewers, restricted to main) and sets the AZURE_* repository variables the
       workflow reads.

  Idempotent: re-running it converges rather than duplicating. Nothing it stores
  is a secret — the workflow authenticates with OIDC federation.

.PARAMETER SubscriptionId
  Target subscription. Defaults to the current `az account show` subscription.

.PARAMETER Reviewers
  GitHub user logins who must approve a production deployment. Defaults to the
  authenticated `gh` user.

.EXAMPLE
  ./host/infra/bootstrap/Initialize-AzureCicd.ps1 -SubscriptionId 00000000-0000-0000-0000-000000000000

.NOTES
  Requires: Azure CLI (logged in as a principal that can create resource groups,
  register resource providers, assign roles, create custom roles, and register an
  Entra application) and GitHub CLI (logged in with
  admin rights on the repository).
#>
[CmdletBinding(SupportsShouldProcess)]
param(
  [string] $SubscriptionId,
  [string] $ParameterFile = (Join-Path $PSScriptRoot 'main.bicepparam'),
  [string] $ApiAppDisplayName = 'hve-squad MCP',
  [string[]] $Reviewers,
  [string] $DeployBranch = 'main',
  [switch] $SkipEntraApp,
  [switch] $SkipGitHub
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

$infraRoot = Split-Path $PSScriptRoot -Parent
$workloadParamFile = Join-Path $infraRoot 'main.bicepparam'
$deployClientId = $null
$planClientId = $null
$resourceGroup = $null

function Invoke-AzJson {
  param([Parameter(Mandatory, ValueFromRemainingArguments)] [string[]] $Arguments)
  $raw = & az @Arguments --only-show-errors --output json
  if ($LASTEXITCODE -ne 0) { throw "az $($Arguments -join ' ') failed." }
  if ([string]::IsNullOrWhiteSpace(($raw -join ''))) { return $null }
  return ($raw -join "`n") | ConvertFrom-Json -Depth 50
}

# Graph PATCH bodies go through a temp file: quoting JSON on a Windows command
# line is not reliable.
function Invoke-GraphPatch {
  param([string] $Url, [object] $Body)
  $file = New-TemporaryFile
  try {
    $Body | ConvertTo-Json -Depth 20 | Set-Content -Path $file -Encoding utf8
    & az rest --method PATCH --url $Url --headers 'Content-Type=application/json' --body "@$file" --only-show-errors | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "PATCH $Url failed." }
  }
  finally { Remove-Item $file -ErrorAction SilentlyContinue }
}

# ─── 0. Context ──────────────────────────────────────────────────────────────
if ($SubscriptionId) { az account set --subscription $SubscriptionId --only-show-errors | Out-Null }
$account = Invoke-AzJson account show
$SubscriptionId = $account.id
$tenantId = $account.tenantId
Write-Host "Subscription $($account.name) ($SubscriptionId), tenant $tenantId"

$bootstrapParams = (Invoke-AzJson bicep build-params --file $ParameterFile --stdout).parametersJson | ConvertFrom-Json -Depth 20
$location = $bootstrapParams.parameters.location.value
$repository = $bootstrapParams.parameters.githubRepository.value
$PlanEnvironment = $bootstrapParams.parameters.planEnvironment.value
$DeployEnvironment = $bootstrapParams.parameters.deployEnvironment.value

# The CI identities hold resource-group roles only, so ARM cannot auto-register a
# provider on their behalf; register every namespace main.bicep uses now.
$providers = @(
  'Microsoft.App', 'Microsoft.CognitiveServices', 'Microsoft.Consumption',
  'Microsoft.ContainerRegistry', 'Microsoft.KeyVault', 'Microsoft.ManagedIdentity',
  'Microsoft.OperationalInsights', 'Microsoft.Storage'
)
if ($PSCmdlet.ShouldProcess(($providers -join ', '), 'register resource providers')) {
  foreach ($ns in $providers) {
    $state = (Invoke-AzJson provider show --namespace $ns --query registrationState)
    if ($state -ne 'Registered') {
      Write-Host "Registering $ns ..."
      az provider register --namespace $ns --wait --only-show-errors
    }
  }
}

# ─── 1. CI identities, federation, RBAC ──────────────────────────────────────
$deploymentName = 'hve-squad-mcp-bootstrap'
if ($PSCmdlet.ShouldProcess("subscription $SubscriptionId", 'deploy bootstrap/main.bicep')) {
  Write-Host "Deploying $deploymentName to $location ..."
  $bootstrap = Invoke-AzJson deployment sub create `
    --name $deploymentName `
    --location $location `
    --template-file (Join-Path $PSScriptRoot 'main.bicep') `
    --parameters $ParameterFile
  $outputs = $bootstrap.properties.outputs
  $deployClientId = $outputs.deployClientId.value
  $planClientId = $outputs.planClientId.value
  $resourceGroup = $outputs.workloadResourceGroup.value
  Write-Host "Plan identity client id: $planClientId; deploy identity client id: $deployClientId"
}

# ─── 2. Entra app registration for the MCP resource server ───────────────────
$scopeNames = [ordered]@{
  'Squad.Research'    = 'Run squad research'
  'Squad.Plan'        = 'Run squad planning'
  'Squad.Review'      = 'Run squad reviews'
  'Squad.Architect'   = 'Run squad architecture'
  'Squad.Run'         = 'Start and poll gated squad runs'
  'Squad.Federate'    = 'Drive a squad federation'
  'Squad.Render'      = 'Render PowerPoint decks'
  'Squad.Memory'      = 'Read squad memory and history'
  'Squad.MemoryWrite' = 'Write squad memory'
  'Squad.Business'    = 'Run the business plan tool'
  'Squad.Backlog'     = 'Produce a structured backlog'
}

$apiClientId = $null
if (-not $SkipEntraApp -and $PSCmdlet.ShouldProcess($ApiAppDisplayName, 'create or update the Entra app registration')) {
  $existing = @(Invoke-AzJson ad app list --display-name $ApiAppDisplayName --query '[].{appId:appId,id:id}')
  if ($existing.Count -gt 1) { throw "More than one app registration is named '$ApiAppDisplayName'; pass -ApiAppDisplayName to pick one." }
  if ($existing.Count -eq 1) {
    $app = $existing[0]
    Write-Host "Updating app registration $($app.appId)"
  }
  else {
    $app = Invoke-AzJson ad app create --display-name $ApiAppDisplayName --sign-in-audience AzureADMyOrg --query '{appId:appId,id:id}'
    Write-Host "Created app registration $($app.appId)"
  }
  $apiClientId = $app.appId
  $graphUrl = "https://graph.microsoft.com/v1.0/applications/$($app.id)"
  $current = Invoke-AzJson rest --method GET --url $graphUrl

  # Keep every existing scope and role id: Entra refuses to drop or re-key an
  # enabled scope, and consent grants reference the id.
  $scopes = [System.Collections.Generic.List[object]]::new()
  foreach ($s in @($current.api.oauth2PermissionScopes)) { if ($s) { $scopes.Add($s) } }
  foreach ($name in $scopeNames.Keys) {
    if (-not ($scopes | Where-Object value -EQ $name)) {
      $scopes.Add([ordered]@{
          id                      = [guid]::NewGuid().ToString()
          value                   = $name
          type                    = 'User'
          isEnabled               = $true
          adminConsentDisplayName = $scopeNames[$name]
          adminConsentDescription = "Allows the app to $($scopeNames[$name].ToLower()) on the hve-squad MCP server on behalf of the signed-in user."
          userConsentDisplayName  = $scopeNames[$name]
          userConsentDescription  = "Allows the app to $($scopeNames[$name].ToLower()) on your behalf."
        })
    }
  }

  $roles = [System.Collections.Generic.List[object]]::new()
  foreach ($r in @($current.appRoles)) { if ($r) { $roles.Add($r) } }
  if (-not ($roles | Where-Object value -EQ 'Squad.Operate')) {
    $roles.Add([ordered]@{
        id                 = [guid]::NewGuid().ToString()
        value              = 'Squad.Operate'
        displayName        = 'Squad operator'
        description        = 'Release held squad runs through POST /admin/approve.'
        allowedMemberTypes = @('User', 'Application')
        isEnabled          = $true
      })
  }

  Invoke-GraphPatch -Url $graphUrl -Body ([ordered]@{
      identifierUris = @("api://$apiClientId")
      api            = [ordered]@{
        # The server trusts the v2 issuer, so tokens must be v2.
        requestedAccessTokenVersion = 2
        oauth2PermissionScopes      = $scopes
      }
      appRoles       = $roles
    })

  $sp = @(Invoke-AzJson ad sp list --filter "appId eq '$apiClientId'" --query '[].id')
  if ($sp.Count -eq 0) { az ad sp create --id $apiClientId --only-show-errors | Out-Null }
  Write-Host "App registration ready: audience api://$apiClientId"
}

# ─── 3. Fill main.bicepparam placeholders ────────────────────────────────────
$param = Get-Content $workloadParamFile -Raw
$updated = $param.Replace("'<ENTRA_TENANT_ID>'", "'$tenantId'")
if ($apiClientId) { $updated = $updated.Replace("'<ENTRA_CLIENT_ID>'", "'$apiClientId'") }
if ($updated -ne $param -and $PSCmdlet.ShouldProcess($workloadParamFile, 'fill tenant and client id')) {
  [System.IO.File]::WriteAllText($workloadParamFile, $updated)
  Write-Host "Updated $workloadParamFile — review and commit it."
}

# ─── 4. GitHub environments + variables ──────────────────────────────────────
if (-not $SkipGitHub -and $PSCmdlet.ShouldProcess($repository, 'configure GitHub environments and variables')) {
  if (-not $Reviewers) { $Reviewers = @(gh api user --jq .login) }
  $reviewerIds = foreach ($login in $Reviewers) { [int](gh api "users/$login" --jq .id) }

  gh api --method PUT "repos/$repository/environments/$PlanEnvironment" --silent

  $body = [ordered]@{
    prevent_self_review      = $false
    reviewers                = @($reviewerIds | ForEach-Object { [ordered]@{ type = 'User'; id = $_ } })
    deployment_branch_policy = [ordered]@{ protected_branches = $false; custom_branch_policies = $true }
  } | ConvertTo-Json -Depth 5
  $body | gh api --method PUT "repos/$repository/environments/$DeployEnvironment" --input - --silent

  $policies = gh api "repos/$repository/environments/$DeployEnvironment/deployment-branch-policies" --jq '.branch_policies[].name'
  if (@($policies) -notcontains $DeployBranch) {
    gh api --method POST "repos/$repository/environments/$DeployEnvironment/deployment-branch-policies" -f name=$DeployBranch -f type=branch --silent
  }

  $variables = [ordered]@{
    AZURE_PLAN_CLIENT_ID  = $planClientId
    AZURE_CLIENT_ID       = $deployClientId
    AZURE_TENANT_ID       = $tenantId
    AZURE_SUBSCRIPTION_ID = $SubscriptionId
    AZURE_RESOURCE_GROUP  = $resourceGroup
  }
  foreach ($name in $variables.Keys) {
    if (-not $variables[$name]) { throw "No value for $name — did the bootstrap deployment run?" }
    gh variable set $name --repo $repository --body $variables[$name]
  }
  Write-Host "GitHub: '$PlanEnvironment' and '$DeployEnvironment' (reviewers: $($Reviewers -join ', ')) configured; AZURE_* variables set."
}

Write-Host @"

Next:
  1. Replace the remaining <PLACEHOLDER> values in host/infra/main.bicepparam
     (budgetAlertEmails, and the Azure OpenAI name/model if the defaults do not fit).
  2. Optional: gh secret set SQUAD_MCP_RUN_ENCRYPTION_KEY_B64 --repo $repository
     (a base64 32-byte key) when enableRemotePipeline or table memory is on.
  3. Commit and push to $DeployBranch. The workflow lints, runs what-if, then waits
     for approval in '$DeployEnvironment' before it deploys.
"@
