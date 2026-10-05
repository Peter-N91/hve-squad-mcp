// AcrPull for the app managed identity on the registry it already pulls from
// (D1: closes the research-identified gap). Deployed by main.bicep ONLY when
// manageAcrPullAssignment is true (U4), always with an explicit module scope
// parsed from containerRegistryResourceId — subscription AND resource group
// (S5 / AC-A14 / security C10) — so the registry may live in another resource
// group or subscription.
//
// Login-server guard (S5 / FR-027, plan option (b)): containerRegistryServer is
// still what ACA pulls from (no wider param rewiring), but this module compares it
// against the registry's authoritative properties.loginServer and fails the
// role assignment with fail() on a mismatch instead of silently granting AcrPull
// on the wrong registry. This check needs a live read, so it fires when the
// module deploys (and is exercised locally by the evaluator's stubbed fixture).

@description('ARM resource id of the Azure Container Registry.')
param containerRegistryResourceId string

@description('Login server the Container App / worker pull from (compared against the registry loginServer).')
param containerRegistryServer string

@description('Principal (object) id of the app managed identity.')
param principalId string

@description('Resource id of the app managed identity (deterministic resourceId(); guid() input only).')
param identityId string

// AcrPull built-in role.
var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: last(split(containerRegistryResourceId, '/'))
}

var loginServerMatches = toLower(registry.properties.loginServer) == toLower(containerRegistryServer)

resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, identityId, acrPullRoleId)
  scope: registry
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
    principalId: loginServerMatches
      ? principalId
      : fail('containerRegistryServer does not match the loginServer of containerRegistryResourceId; refusing to grant AcrPull on a registry the app does not pull from (S5).')
    principalType: 'ServicePrincipal'
  }
}

@description('The AcrPull role assignment resource id.')
output roleAssignmentId string = acrPull.id

@description('The registry authoritative login server.')
output loginServer string = registry.properties.loginServer
