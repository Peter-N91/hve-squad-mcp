// ciDeployIdentity / ciPlanIdentity RBAC at the APP resource group (S4 / U3 / S6 /
// S12). Deployed by bootstrap.bicep with an explicit scope on the app RG.
//
//   * ciDeployIdentity: Contributor (U3: accepted + tracked residual risk — see the
//     header of bootstrap.bicep) and RBAC Administrator restricted by the ABAC
//     condition to exactly the five role GUIDs main.bicep's modules assign,
//     ServicePrincipal principals only, never either CI identity (S4 / C1).
//   * ciPlanIdentity: the squad-ci-plan-reader custom role only (S6) — never
//     Reader, Contributor, or any listKeys/sharedKey-capable role.

import { rbacAdminCondition, builtInRoles, appRoleGuids } from 'abac.bicep'

@description('ciDeployIdentity principal id.')
param deployPrincipalId string

@description('ciPlanIdentity principal id.')
param planPrincipalId string

@description('ciDeployIdentity resource id (deterministic resourceId(); guid() input only).')
param deployIdentityResourceId string

@description('ciPlanIdentity resource id (deterministic resourceId(); guid() input only).')
param planIdentityResourceId string

@description('GUID (name) of the squad-ci-plan-reader custom role definition.')
param planReaderRoleGuid string

resource deployContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, deployIdentityResourceId, builtInRoles.contributor)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', builtInRoles.contributor)
    principalId: deployPrincipalId
    principalType: 'ServicePrincipal'
    description: 'squad CI deploy: Contributor on the app resource group (U3 accepted residual risk).'
  }
}

resource deployRbacAdmin 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, deployIdentityResourceId, builtInRoles.rbacAdministrator)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', builtInRoles.rbacAdministrator)
    principalId: deployPrincipalId
    principalType: 'ServicePrincipal'
    description: 'squad CI deploy: RBAC Administrator limited by ABAC to the 5 app role GUIDs, ServicePrincipal only, never a CI identity (S4).'
    conditionVersion: '2.0'
    condition: rbacAdminCondition(appRoleGuids, [
      deployPrincipalId
      planPrincipalId
    ])
  }
}

resource planReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, planIdentityResourceId, planReaderRoleGuid)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', planReaderRoleGuid)
    principalId: planPrincipalId
    principalType: 'ServicePrincipal'
    description: 'squad CI plan: read + deployment validate/what-if only (S6).'
  }
}
