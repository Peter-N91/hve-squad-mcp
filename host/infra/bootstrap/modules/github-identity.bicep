// A user-assigned managed identity GitHub Actions federates into. No secret
// exists: the federated credential trusts exactly one GitHub environment of one
// repository.

@description('Identity name.')
param name string

@description('Azure region.')
param location string

@description('GitHub repository, as owner/name.')
param githubRepository string

@description('The one GitHub environment trusted to federate into this identity.')
param githubEnvironment string

@description('Tags applied to the identity.')
param tags object = {}

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: name
  location: location
  tags: tags
}

resource federatedCredential 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: identity
  name: 'github-${toLower(githubEnvironment)}'
  properties: {
    issuer: 'https://token.actions.githubusercontent.com'
    subject: 'repo:${githubRepository}:environment:${githubEnvironment}'
    audiences: [
      'api://AzureADTokenExchange'
    ]
  }
}

@description('Identity resource id.')
output id string = identity.id

@description('Identity principal (object) id.')
output principalId string = identity.properties.principalId

@description('Identity client id.')
output clientId string = identity.properties.clientId