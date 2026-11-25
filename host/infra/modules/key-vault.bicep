// Key Vault for operator secrets plus the app identity's read access to it.
//
// SEC-10: secrets via managed identity + Key Vault; none in the image.
//
// Behavior-preserving extraction: the vault keeps enableRbacAuthorization /
// enableSoftDelete / 90-day retention / publicNetworkAccess 'Enabled' and still
// sets no enablePurgeProtection. Purge protection and network restriction are
// tracked Follow-Ups, not silently changed here.

@description('Azure region for the vault.')
param location string

@description('Short prefix for resource names.')
param namePrefix string

@description('Resource id of the app managed identity. Deterministic resourceId() value supplied by main.bicep (AC-A9), used only as a guid() input.')
param identityId string

@description('Principal (object) id of the app managed identity.')
param principalId string

var tenantId = subscription().tenantId
var keyVaultSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  // checkov:skip=CKV_AZURE_110:Pre-existing (the vault never set enablePurgeProtection). Tracked in the infra plan bicep-modularization Follow-Up Items as "Key Vault purge protection and public network access". Behavior is preserved by design in this behavior-preserving refactor.
  // checkov:skip=CKV_AZURE_42:Pre-existing. Soft delete (90 days) is on, but the "recoverable" check also requires purge protection. Tracked in the infra plan bicep-modularization Follow-Up Items as "Key Vault purge protection and public network access". Behavior is preserved by design.
  // checkov:skip=CKV_AZURE_189:Pre-existing (publicNetworkAccess Enabled; ACA reaches the vault over the public endpoint with RBAC). Tracked in the infra plan bicep-modularization Follow-Up Items as "Key Vault purge protection and public network access". Behavior is preserved by design.
  // checkov:skip=CKV_AZURE_109:Pre-existing (no networkAcls firewall; access is enforced by RBAC only). Tracked in the infra plan bicep-modularization Follow-Up Items as "Key Vault purge protection and public network access". Behavior is preserved by design.
  // A vault name is capped at 24 characters, so the prefix + uniqueString pair is
  // truncated; without this the default namePrefix already overflows the limit.
  name: take('${namePrefix}-kv-${uniqueString(resourceGroup().id)}', 24)
  location: location
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

// Let the app's managed identity read Key Vault secrets (SEC-10).
// guid() inputs are byte-identical to the pre-modularization template
// (main.bicep:341 at the baseline commit): keyVault.id, identity.id, role id.
resource keyVaultSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, identityId, keyVaultSecretsUserRoleId)
  scope: keyVault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}

@description('The Key Vault name.')
output name string = keyVault.name
