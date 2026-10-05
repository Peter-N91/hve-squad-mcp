// hve-squad MCP — ONE-TIME CI/CD bootstrap (subscription scope).
//
// Run once by an operator who can create resource groups, register resource
// providers, create a custom role, and assign roles (Owner, or Contributor + User
// Access Administrator). After it, every infrastructure change ships through
// .github/workflows/azure-infra.yml. Prefer host/infra/bootstrap/Initialize-AzureCicd.ps1,
// which deploys this template and then performs the Entra and GitHub steps a
// template cannot.
//
// It creates:
//   * the WORKLOAD resource group that main.bicep deploys into;
//   * a separate CI/CD resource group holding the two CI identities, so tearing
//     the workload down never deletes the identities that redeploy it;
//   * a PLAN identity, federated ONLY to the what-if environment, holding a custom
//     read + what-if role that cannot change any resource;
//   * a DEPLOY identity, federated ONLY to the approval-gated deploy environment,
//     holding Contributor plus Role Based Access Control Administrator CONSTRAINED
//     to the five data-plane roles main.bicep assigns to the app identity.
// Both roles are scoped to the workload resource group; nothing is granted at
// subscription scope.

targetScope = 'subscription'

@description('Azure region for both resource groups and the CI identities.')
param location string

@description('Resource group main.bicep deploys the workload into.')
param workloadResourceGroupName string

@description('Resource group that holds the CI identities (kept apart from the workload).')
param cicdResourceGroupName string

@description('Name of the plan (what-if) user-assigned managed identity.')
param planIdentityName string

@description('Name of the deploy user-assigned managed identity.')
param deployIdentityName string

@description('GitHub repository allowed to federate, as owner/name.')
param githubRepository string

@description('GitHub environment of the what-if job (no reviewers). Only it may federate into the plan identity.')
param planEnvironment string

@description('GitHub environment of the deploy job (required reviewers). Only it may federate into the deploy identity.')
param deployEnvironment string

@description('Tags applied to both resource groups and the identities.')
param tags object = {}

resource workloadRg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: workloadResourceGroupName
  location: location
  tags: tags
}

resource cicdRg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: cicdResourceGroupName
  location: location
  tags: tags
}

module planIdentity 'modules/github-identity.bicep' = {
  name: 'hve-squad-mcp-plan-identity'
  scope: cicdRg
  params: {
    name: planIdentityName
    location: location
    githubRepository: githubRepository
    githubEnvironment: planEnvironment
    tags: tags
  }
}

module deployIdentity 'modules/github-identity.bicep' = {
  name: 'hve-squad-mcp-deploy-identity'
  scope: cicdRg
  params: {
    name: deployIdentityName
    location: location
    githubRepository: githubRepository
    githubEnvironment: deployEnvironment
    tags: tags
  }
}

module planRbac 'modules/plan-rbac.bicep' = {
  name: 'hve-squad-mcp-plan-rbac'
  scope: workloadRg
  params: {
    principalId: planIdentity.outputs.principalId
    identityId: planIdentity.outputs.id
  }
}

module deployRbac 'modules/deploy-rbac.bicep' = {
  name: 'hve-squad-mcp-deploy-rbac'
  scope: workloadRg
  params: {
    principalId: deployIdentity.outputs.principalId
    identityId: deployIdentity.outputs.id
  }
}

@description('AZURE_PLAN_CLIENT_ID for the workflow (the plan identity client id).')
output planClientId string = planIdentity.outputs.clientId

@description('AZURE_CLIENT_ID for the workflow (the deploy identity client id).')
output deployClientId string = deployIdentity.outputs.clientId

@description('AZURE_TENANT_ID for the workflow.')
output tenantId string = tenant().tenantId

@description('AZURE_SUBSCRIPTION_ID for the workflow.')
output subscriptionId string = subscription().subscriptionId

@description('AZURE_RESOURCE_GROUP for the workflow (the workload resource group).')
output workloadResourceGroup string = workloadRg.name