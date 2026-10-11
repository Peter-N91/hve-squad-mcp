// Azure Container Registry the image is built in (ACR Tasks) and pulled from. The
// app identity pulls with AcrPull; the admin user stays disabled.

@description('Registry name (5-50 alphanumerics, globally unique).')
@minLength(5)
@maxLength(50)
param name string

@description('Azure region.')
param location string

@description('Registry SKU.')
@allowed([
  'Basic'
  'Standard'
  'Premium'
])
param sku string = 'Basic'

@description('Principal id granted AcrPull.')
param pullPrincipalId string

@description('Resource id of that principal. Seeds the role assignment name.')
param pullIdentityId string

@description('Tags applied to the registry.')
param tags object = {}

var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  // checkov:skip=CKV_AZURE_139:ACR Tasks builds from a GitHub-hosted runner, which needs the public endpoint; pulls are identity-authorized (AcrPull).
  // checkov:skip=CKV_AZURE_163:Image vulnerability scanning is Defender for Containers, a subscription-level plan rather than a registry property.
  // checkov:skip=CKV_AZURE_166:Quarantine requires the Premium SKU; the only image source is ACR Tasks building this repository.
  name: name
  location: location
  tags: tags
  sku: {
    name: sku
  }
  properties: {
    adminUserEnabled: false
    // ACR Tasks builds from a GitHub-hosted runner, which needs the public
    // endpoint; every pull is identity-authorized (AcrPull), never anonymous.
    publicNetworkAccess: 'Enabled'
  }
}

resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, pullIdentityId, acrPullRoleId)
  scope: registry
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
    principalId: pullPrincipalId
    principalType: 'ServicePrincipal'
  }
}

@description('Registry name (for az acr build).')
output name string = registry.name

@description('Registry login server.')
output loginServer string = registry.properties.loginServer
