// Roles the deploy identity holds on the WORKLOAD resource group — nothing at
// subscription scope.
//
//   * Contributor — create and update every resource main.bicep declares, and
//     queue ACR Tasks builds.
//   * Role Based Access Control Administrator, constrained by an ABAC condition to
//     the five roles main.bicep assigns to the APP identity. main.bicep needs to
//     write role assignments; the condition makes sure that is all it can write.

@description('Deploy identity principal id.')
param principalId string

@description('Deploy identity resource id. Seeds the role assignment names.')
param identityId string

var contributorRoleId = 'b24988ac-6180-42a0-ab88-20f7382dd24c'
var rbacAdministratorRoleId = 'f58310d9-a9f6-439a-9e8d-f62e7b41a168'

// Keep in step with the roles main.bicep's modules assign.
var delegableRoleIds = [
  '4633458b-17de-408a-b874-0445c86b69e6' // Key Vault Secrets User
  '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3' // Storage Table Data Contributor
  'ba92f5b4-2d11-453d-a403-e96b0029c9fe' // Storage Blob Data Contributor
  '7f951dda-4ed3-4680-a7ca-43fe172d538d' // AcrPull
  '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd' // Cognitive Services OpenAI User
]
var delegableRoleList = join(delegableRoleIds, ', ')
var rbacCondition = '((!(ActionMatches{\'Microsoft.Authorization/roleAssignments/write\'})) OR (@Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${delegableRoleList}})) AND ((!(ActionMatches{\'Microsoft.Authorization/roleAssignments/delete\'})) OR (@Resource[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${delegableRoleList}}))'

resource contributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, identityId, contributorRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', contributorRoleId)
    principalId: principalId
    principalType: 'ServicePrincipal'
    description: 'hve-squad-mcp CI/CD: deploy host/infra/main.bicep.'
  }
}

resource rbacAdministrator 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, identityId, rbacAdministratorRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', rbacAdministratorRoleId)
    principalId: principalId
    principalType: 'ServicePrincipal'
    description: 'hve-squad-mcp CI/CD: assign only the app identity data-plane roles main.bicep declares.'
    conditionVersion: '2.0'
    condition: rbacCondition
  }
}
