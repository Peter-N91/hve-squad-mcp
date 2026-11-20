// User-assigned managed identity the app and worker run as. Every data-plane
// grant (Key Vault, Storage, ACR pull, Azure OpenAI) targets this one principal.

@description('Identity name.')
param name string

@description('Azure region.')
param location string

@description('Tags applied to the identity.')
param tags object = {}

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: name
  location: location
  tags: tags
}

@description('Identity resource id.')
output id string = identity.id

@description('Identity principal (object) id.')
output principalId string = identity.properties.principalId

@description('Identity client (application) id.')
output clientId string = identity.properties.clientId
