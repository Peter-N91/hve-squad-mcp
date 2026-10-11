// ciDeployIdentity / ciPlanIdentity RBAC for an Azure OpenAI account that lives
// OUTSIDE the app resource group (S5 / security C2 / S12). Deployed by
// bootstrap.bicep only in that case, with an explicit scope on the account's own
// subscription + resource group parsed from openAiAccountResourceId (C10). When
// the account is in the app resource group the app-RG grants already cover the
// Cognitive Services OpenAI User assignment, so no extra grant is made.
//
//   * RBAC Administrator at the ACCOUNT RESOURCE, ABAC-restricted to the single
//     Cognitive Services OpenAI User GUID (C2), ServicePrincipal only, never a CI
//     identity.
//   * squad-ci-cross-rg-deploy at the account RG for ciDeployIdentity (the nested
//     openai-role-assignment deployment).
//   * squad-ci-plan-reader at the account RG for ciPlanIdentity (what-if).
//
// Cross-RG support covers openAiMode 'existing' (the account must already exist
// when bootstrap runs). A cross-RG 'create' needs account-write rights in that RG,
// which this bootstrap deliberately does not grant.

import { rbacAdminCondition, builtInRoles } from 'abac.bicep'

@description('Azure OpenAI account name in this module\'s resource group.')
param openAiAccountName string

@description('ciDeployIdentity principal id.')
param deployPrincipalId string

@description('ciPlanIdentity principal id.')
param planPrincipalId string

@description('ciDeployIdentity resource id (deterministic; guid() input only).')
param deployIdentityResourceId string

@description('ciPlanIdentity resource id (deterministic; guid() input only).')
param planIdentityResourceId string

@description('GUID (name) of the squad-ci-cross-rg-deploy custom role definition.')
param crossRgDeployRoleGuid string

@description('GUID (name) of the squad-ci-plan-reader custom role definition.')
param planReaderRoleGuid string

resource account 'Microsoft.CognitiveServices/accounts@2024-10-01' existing = {
  name: openAiAccountName
}

resource deployAccountRbacAdmin 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(account.id, deployIdentityResourceId, builtInRoles.rbacAdministrator)
  scope: account
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', builtInRoles.rbacAdministrator)
    principalId: deployPrincipalId
    principalType: 'ServicePrincipal'
    description: 'squad CI deploy: RBAC Administrator on this AOAI account limited by ABAC to Cognitive Services OpenAI User only (C2).'
    conditionVersion: '2.0'
    condition: rbacAdminCondition([
      builtInRoles.cognitiveServicesOpenAiUser
    ], [
      deployPrincipalId
      planPrincipalId
    ])
  }
}

resource deployCrossRg 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, deployIdentityResourceId, crossRgDeployRoleGuid)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', crossRgDeployRoleGuid)
    principalId: deployPrincipalId
    principalType: 'ServicePrincipal'
    description: 'squad CI deploy: nested deployments only in the AOAI resource group (S5).'
  }
}

resource planReaderCrossRg 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, planIdentityResourceId, planReaderRoleGuid)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', planReaderRoleGuid)
    principalId: planPrincipalId
    principalType: 'ServicePrincipal'
    description: 'squad CI plan: read + deployment validate/what-if in the AOAI resource group (S6).'
  }
}
