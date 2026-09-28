[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string] $GitHubRepository,

    [Parameter(Mandatory)]
    [string] $ResourceGroup,

    [Parameter(Mandatory)]
    [string] $ContainerRegistryName,

    [Parameter(Mandatory)]
    [string] $ProductionApprover,

    [string] $IdentityName = 'hve-squad-mcp-github',

    [string] $ContainerRegistrySku = 'Basic',

    [string] $Location = 'eastus2'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-LastExitCode {
    param([string] $Operation)

    if ($LASTEXITCODE -ne 0) {
        throw "$Operation failed with exit code $LASTEXITCODE."
    }
}

function Ensure-RoleAssignment {
    param(
        [string] $AssigneeObjectId,
        [string] $Role,
        [string] $Scope
    )

    $existing = az role assignment list `
        --assignee-object-id $AssigneeObjectId `
        --role $Role `
        --scope $Scope `
        --query '[0].id' `
        --output tsv
    Assert-LastExitCode "Checking role '$Role'"

    if (-not $existing) {
        az role assignment create `
            --assignee-object-id $AssigneeObjectId `
            --assignee-principal-type ServicePrincipal `
            --role $Role `
            --scope $Scope `
            --output none
        Assert-LastExitCode "Assigning role '$Role'"
    }
}

function Ensure-FederatedCredential {
    param(
        [string] $Name,
        [string] $Subject
    )

    az identity federated-credential show `
        --name $Name `
        --identity-name $IdentityName `
        --resource-group $ResourceGroup `
        --output none 2>$null

    if ($LASTEXITCODE -ne 0) {
        az identity federated-credential create `
            --name $Name `
            --identity-name $IdentityName `
            --resource-group $ResourceGroup `
            --issuer 'https://token.actions.githubusercontent.com' `
            --subject $Subject `
            --audiences 'api://AzureADTokenExchange' `
            --output none
        Assert-LastExitCode "Creating federated credential '$Name'"
    }
}

if ($GitHubRepository -notmatch '^[^/]+/[^/]+$') {
    throw 'GitHubRepository must use the owner/repository format.'
}

az account show --output none
Assert-LastExitCode 'Checking Azure CLI authentication'

gh auth status
Assert-LastExitCode 'Checking GitHub CLI authentication'

$subscriptionId = az account show --query id --output tsv
Assert-LastExitCode 'Reading the Azure subscription'
$tenantId = az account show --query tenantId --output tsv
Assert-LastExitCode 'Reading the Entra tenant'

az group create `
    --name $ResourceGroup `
    --location $Location `
    --output none
Assert-LastExitCode 'Creating the resource group'

$identity = az identity create `
    --name $IdentityName `
    --resource-group $ResourceGroup `
    --location $Location `
    --output json | ConvertFrom-Json
Assert-LastExitCode 'Creating the deployment managed identity'

az acr show `
    --name $ContainerRegistryName `
    --resource-group $ResourceGroup `
    --output none 2>$null

if ($LASTEXITCODE -ne 0) {
    az acr create `
        --name $ContainerRegistryName `
        --resource-group $ResourceGroup `
        --location $Location `
        --sku $ContainerRegistrySku `
        --admin-enabled false `
        --output none
    Assert-LastExitCode 'Creating the Azure Container Registry'
}

$resourceGroupId = az group show `
    --name $ResourceGroup `
    --query id `
    --output tsv
Assert-LastExitCode 'Reading the resource group id'

$registryId = az acr show `
    --name $ContainerRegistryName `
    --resource-group $ResourceGroup `
    --query id `
    --output tsv
Assert-LastExitCode 'Reading the Azure Container Registry id'

Ensure-RoleAssignment `
    -AssigneeObjectId $identity.principalId `
    -Role 'Contributor' `
    -Scope $resourceGroupId
Ensure-RoleAssignment `
    -AssigneeObjectId $identity.principalId `
    -Role 'Role Based Access Control Administrator' `
    -Scope $resourceGroupId
Ensure-RoleAssignment `
    -AssigneeObjectId $identity.principalId `
    -Role 'AcrPush' `
    -Scope $registryId

Ensure-FederatedCredential `
    -Name 'github-preview' `
    -Subject "repo:${GitHubRepository}:environment:preview"
Ensure-FederatedCredential `
    -Name 'github-production' `
    -Subject "repo:${GitHubRepository}:environment:production"

$approverId = gh api "users/$ProductionApprover" --jq '.id'
Assert-LastExitCode 'Resolving the production approver'

'{}' | gh api `
    --method PUT `
    "repos/$GitHubRepository/environments/preview" `
    --input - >$null
Assert-LastExitCode 'Creating the preview environment'

$productionEnvironment = @{
    wait_timer          = 0
    prevent_self_review = $false
    reviewers           = @(
        @{
            type = 'User'
            id   = [long] $approverId
        }
    )
} | ConvertTo-Json -Depth 5

$productionEnvironment | gh api `
    --method PUT `
    "repos/$GitHubRepository/environments/production" `
    --input - >$null
Assert-LastExitCode 'Configuring production approval'

gh variable set AZURE_CLIENT_ID `
    --repo $GitHubRepository `
    --body $identity.clientId
Assert-LastExitCode 'Setting AZURE_CLIENT_ID'
gh variable set AZURE_TENANT_ID `
    --repo $GitHubRepository `
    --body $tenantId
Assert-LastExitCode 'Setting AZURE_TENANT_ID'
gh variable set AZURE_SUBSCRIPTION_ID `
    --repo $GitHubRepository `
    --body $subscriptionId
Assert-LastExitCode 'Setting AZURE_SUBSCRIPTION_ID'
gh variable set AZURE_RESOURCE_GROUP `
    --repo $GitHubRepository `
    --body $ResourceGroup
Assert-LastExitCode 'Setting AZURE_RESOURCE_GROUP'

Write-Host "Configured managed identity '$IdentityName' and GitHub environments for $GitHubRepository."
Write-Host 'The preview environment runs what-if without approval; production requires the configured reviewer.'
