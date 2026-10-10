@description('Azure Container Registry name.')
param name string

@description('Azure region for the registry.')
param location string

@description('Azure Container Registry SKU.')
param skuName string

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  // checkov:skip=CKV_AZURE_139:GitHub-hosted ACR Tasks and the public ACA environment require the registry data endpoint.
  // checkov:skip=CKV_AZURE_163:Image scanning is enabled through subscription-level Defender for Containers, not a registry ARM property.
  // checkov:skip=CKV_AZURE_166:Quarantine is a Premium-only preview control; production promotion is instead gated by what-if and environment approval.
  name: name
  location: location
  sku: {
    name: skuName
  }
  properties: {
    adminUserEnabled: false
    dataEndpointEnabled: false
    publicNetworkAccess: 'Enabled'
  }
}

output name string = registry.name
