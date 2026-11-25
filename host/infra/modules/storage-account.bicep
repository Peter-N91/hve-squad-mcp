@description('Storage account name.')
param name string

@description('Azure region for the storage account.')
param location string

@description('Storage account SKU.')
param skuName string

resource account 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  // checkov:skip=CKV_AZURE_35:The public ACA environment has dynamic outbound addresses; data-plane access is still identity-based and HTTPS-only.
  // checkov:skip=CKV_AZURE_206:The operator selects replication in main.bicepparam so regions without ZRS remain deployable.
  name: name
  location: location
  sku: {
    name: skuName
  }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    supportsHttpsTrafficOnly: true
  }
}

output name string = account.name
