// ciDeployIdentity / ciPlanIdentity RBAC for the container registry (S5 / S11 /
// security C2 / C3 / S12). Deployed by bootstrap.bicep with an explicit scope on
// the registry's own subscription + resource group, parsed from its resource id
// (C10 / AC-A14).
//
//   * Always: squad-ci-acr-build at the REGISTRY RESOURCE for ciDeployIdentity
//     (az acr build: registries/read, listBuildSourceUploadUrl, scheduleRun,
//     runs/read, runs/listLogSasUrl — replaces AcrPush, S11 / C3).
//   * Only when the registry is NOT in the app resource group (the app-RG grant
//     already covers AcrPull otherwise):
//       - RBAC Administrator at the REGISTRY RESOURCE, ABAC-restricted to the
//         single AcrPull GUID (C2), ServicePrincipal only, never a CI identity;
//       - squad-ci-cross-rg-deploy at the registry RG for ciDeployIdentity (the
//         nested container-registry-access deployment, S5);
//       - squad-ci-plan-reader at the registry RG for ciPlanIdentity (what-if, S6).

import { rbacAdminCondition, builtInRoles } from 'abac.bicep'

@description('Registry name in this module\'s resource group.')
param registryName string

@description('True when the registry is in a different subscription/resource group than the app.')
param crossResourceGroup bool

@description('ciDeployIdentity principal id.')
param deployPrincipalId string

@description('ciPlanIdentity principal id.')
param planPrincipalId string

@description('ciDeployIdentity resource id (deterministic; guid() input only).')
param deployIdentityResourceId string

@description('ciPlanIdentity resource id (deterministic; guid() input only).')
param planIdentityResourceId string

@description('GUID (name) of the squad-ci-acr-build custom role definition.')
param acrBuildRoleGuid string

@description('GUID (name) of the squad-ci-cross-rg-deploy custom role definition (ignored when crossResourceGroup is false).')
param crossRgDeployRoleGuid string

@description('GUID (name) of the squad-ci-plan-reader custom role definition.')
param planReaderRoleGuid string

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: registryName
}

resource deployAcrBuild 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, deployIdentityResourceId, acrBuildRoleGuid)
  scope: registry
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrBuildRoleGuid)
    principalId: deployPrincipalId
    principalType: 'ServicePrincipal'
    description: 'squad CI deploy: az acr build on this registry only (S11).'
  }
}

resource deployRegistryRbacAdmin 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (crossResourceGroup) {
  name: guid(registry.id, deployIdentityResourceId, builtInRoles.rbacAdministrator)
  scope: registry
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', builtInRoles.rbacAdministrator)
    principalId: deployPrincipalId
    principalType: 'ServicePrincipal'
    description: 'squad CI deploy: RBAC Administrator on this registry limited by ABAC to AcrPull only (C2).'
    conditionVersion: '2.0'
    condition: rbacAdminCondition([
      builtInRoles.acrPull
    ], [
      deployPrincipalId
      planPrincipalId
    ])
  }
}

resource deployCrossRg 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (crossResourceGroup) {
  name: guid(resourceGroup().id, deployIdentityResourceId, crossRgDeployRoleGuid)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', crossRgDeployRoleGuid)
    principalId: deployPrincipalId
    principalType: 'ServicePrincipal'
    description: 'squad CI deploy: nested deployments only in the registry resource group (S5).'
  }
}

resource planReaderCrossRg 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (crossResourceGroup) {
  name: guid(resourceGroup().id, planIdentityResourceId, planReaderRoleGuid)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', planReaderRoleGuid)
    principalId: planPrincipalId
    principalType: 'ServicePrincipal'
    description: 'squad CI plan: read + deployment validate/what-if in the registry resource group (S6).'
  }
}
