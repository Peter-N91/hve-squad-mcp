// Storage account backing the optional features: Table storage for the async
// run-state store (WI-06) and the table memory broker, Blob storage for rendered
// decks and memory overflow (WI-03). The app identity gets data-plane roles only
// for the services in use — no connection string or key is ever issued (SEC-10).

@description('Storage account name (3-24 lowercase alphanumerics).')
@minLength(3)
@maxLength(24)
param name string

@description('Azure region.')
param location string

@description('Tables to create. Non-empty enables the table service and the Table Data Contributor grant.')
param tableNames string[]

@description('Private blob containers to create. Non-empty enables the blob service and the Blob Data Contributor grant (which also allows minting user-delegation SAS).')
param blobContainerNames string[]

@description('Principal id granted the data-plane roles.')
param dataPrincipalId string

@description('Resource id of that principal. Seeds the role assignment names.')
param dataIdentityId string

@description('Tags applied to the account.')
param tags object = {}

var storageTableDataContributorRoleId = '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'
var storageBlobDataContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
var enableTable = !empty(tableNames)
var enableBlob = !empty(blobContainerNames)

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: name
  location: location
  tags: tags
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    supportsHttpsTrafficOnly: true
  }
}

resource tableService 'Microsoft.Storage/storageAccounts/tableServices@2023-05-01' = if (enableTable) {
  parent: storage
  name: 'default'
}

resource tables 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = [
  for tableName in tableNames: {
    parent: tableService
    name: tableName
  }
]

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = if (enableBlob) {
  parent: storage
  name: 'default'
}

resource containers 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = [
  for containerName in blobContainerNames: {
    parent: blobService
    name: containerName
    properties: {
      publicAccess: 'None'
    }
  }
]

// Role assignment names are seeded exactly as the single-file template seeded
// them, so an existing deployment re-applies instead of conflicting.
resource tableRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (enableTable) {
  name: guid(name, dataIdentityId, storageTableDataContributorRoleId)
  scope: storage
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageTableDataContributorRoleId)
    principalId: dataPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource blobRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (enableBlob) {
  name: guid(name, dataIdentityId, storageBlobDataContributorRoleId)
  scope: storage
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataContributorRoleId)
    principalId: dataPrincipalId
    principalType: 'ServicePrincipal'
  }
}

@description('Storage account name.')
output name string = storage.name
