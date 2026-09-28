@description('Key Vault name.')
param name string

@description('Azure region for the vault.')
param location string

@description('Microsoft Entra tenant id that owns the vault.')
param tenantId string

@description('Soft-delete retention in days.')
@minValue(7)
@maxValue(90)
param softDeleteRetentionInDays int

@description('Enable purge protection.')
param enablePurgeProtection bool

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  // checkov:skip=CKV_AZURE_189:Public access is required until the public ACA environment has private-endpoint networking.
  // checkov:skip=CKV_AZURE_109:Firewall allow-listing is not reliable for the dynamic outbound addresses of the scale-to-zero public ACA environment.
  // checkov:skip=CKV_AZURE_110:Purge protection is a required module parameter and is enabled in main.bicepparam; Checkov cannot resolve the module input.
  // checkov:skip=CKV_AZURE_42:Soft delete is fixed on and purge protection is enabled through the required module input.
  name: name
  location: location
  properties: {
    sku: {
      family: 'A'
      name: 'standard'
    }
    tenantId: tenantId
    enableRbacAuthorization: true
    enableSoftDelete: true
    enablePurgeProtection: enablePurgeProtection
    softDeleteRetentionInDays: softDeleteRetentionInDays
    publicNetworkAccess: 'Enabled'
  }
}

output name string = vault.name
