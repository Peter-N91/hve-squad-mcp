// The app's user-assigned managed identity. The Container App, the worker job,
// and every data-plane role assignment (Key Vault, Storage, AcrPull, Azure
// OpenAI) use this one identity (SEC-10: no key or secret in code or image).

@description('Azure region for the identity.')
param location string

@description('Short prefix for resource names.')
param namePrefix string

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${namePrefix}-id'
  location: location
}

@description('The identity resource id. Callers that need a deterministic value (guid() names, registries[].identity) compute resourceId() themselves; this output is informational.')
output id string = identity.id

@description('The identity principal (object) id.')
output principalId string = identity.properties.principalId

@description('The identity client (application) id.')
output clientId string = identity.properties.clientId
