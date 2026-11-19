// RUNBOOK Step 7 as IaC: Cognitive Services OpenAI User for the app managed
// identity on the Azure OpenAI account (both openAiMode values).
//
// A5: this is ALWAYS its own module, deployed by main.bicep with an explicit
// `scope: resourceGroup(openAiResourceGroupName)`, and only when
// manageOpenAiRoleAssignment is true (U4 — an existing environment gets no new
// role assignment until its operator opts in and follows the migration).

@description('Azure OpenAI account name in this module\'s resource group.')
param openAiAccountName string

@description('Principal (object) id of the app managed identity.')
param principalId string

@description('Resource id of the app managed identity (deterministic resourceId(); guid() input only).')
param identityId string

// Cognitive Services OpenAI User built-in role.
var openAiUserRoleId = '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'

resource account 'Microsoft.CognitiveServices/accounts@2024-10-01' existing = {
  name: openAiAccountName
}

resource openAiUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(account.id, identityId, openAiUserRoleId)
  scope: account
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', openAiUserRoleId)
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}

@description('The role assignment resource id.')
output roleAssignmentId string = openAiUser.id
