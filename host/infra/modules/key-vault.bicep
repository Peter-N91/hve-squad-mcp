// Key Vault for operator secrets (SEC-10), RBAC-authorized, with the app identity
// granted Key Vault Secrets User.

@description('Vault name (max 24 characters).')
@maxLength(24)
param name string

@description('Azure region.')
param location string

@description('Entra tenant id the vault trusts.')
param tenantId string

@description('Principal id granted Key Vault Secrets User.')
param readerPrincipalId string

@description('Resource id of that principal. Seeds the role assignment name so it stays stable across redeploys.')
param readerIdentityId string

@description('Tags applied to the vault.')
param tags object = {}

var keyVaultSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  // checkov:skip=CKV_AZURE_189:The thin slice runs without a VNet; access is gated by RBAC on a managed identity, not by the network.
  // checkov:skip=CKV_AZURE_109:No firewall rules for the same reason; the Container Apps environment has no fixed egress to allow-list.
  // checkov:skip=CKV_AZURE_110:Purge protection is irreversible and would lock the resource-group-derived vault name for 90 days after a teardown; soft delete (90 days) is on and the operator may opt in.
  // checkov:skip=CKV_AZURE_42:Recoverability is soft delete (90 days); purge protection is an operator opt-in (see CKV_AZURE_110).
  name: name
  location: location
  tags: tags
  properties: {
    sku: {
      family: 'A'
      name: 'standard'
    }
    tenantId: tenantId
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    publicNetworkAccess: 'Enabled'
  }
}

resource secretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, readerIdentityId, keyVaultSecretsUserRoleId)
  scope: keyVault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
    principalId: readerPrincipalId
    principalType: 'ServicePrincipal'
  }
}

@description('Vault name.')
output name string = keyVault.name
