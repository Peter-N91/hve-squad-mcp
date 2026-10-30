// Roles the PLAN identity holds on the WORKLOAD resource group: enough to run
// what-if, and nothing that can change a resource.
//
// It exists so the what-if job — which runs automatically, including on pull
// requests whose workflow file a collaborator controls — never holds a credential
// that could deploy. Only the deploy identity, federated to the approval-gated
// environment, can change anything.
//
// What-if runs template validation, which performs "linked access checks" on
// resource ids that appear in other resources' properties (Azure/arm-template-
// whatif#135). The join/assign actions below cover the ids main.bicep links;
// neither lets this identity create or modify a resource. If what-if reports
// AuthorizationFailed for another action, add it to planActions and re-run the
// bootstrap.

@description('Plan identity principal id.')
param principalId string

@description('Plan identity resource id. Seeds the role assignment names.')
param identityId string

var planActions = [
  '*/read'
  'Microsoft.Resources/deployments/*'
  'Microsoft.Resources/subscriptions/operationresults/read'
  'Microsoft.ManagedIdentity/userAssignedIdentities/assign/action'
  'Microsoft.App/managedEnvironments/join/action'
]

resource whatIfRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(resourceGroup().id, 'hve-squad-mcp-what-if')
  properties: {
    roleName: 'hve-squad-mcp what-if (${resourceGroup().name})'
    description: 'Read the workload resource group and run ARM what-if against it. Cannot create, modify, or delete resources.'
    type: 'CustomRole'
    assignableScopes: [
      resourceGroup().id
    ]
    permissions: [
      {
        actions: planActions
        notActions: []
      }
    ]
  }
}

resource whatIf 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, identityId, whatIfRole.id)
  properties: {
    roleDefinitionId: whatIfRole.id
    principalId: principalId
    principalType: 'ServicePrincipal'
    description: 'hve-squad-mcp CI/CD: what-if only.'
  }
}
