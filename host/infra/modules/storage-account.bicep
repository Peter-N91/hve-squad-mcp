// WI-06 / WI-03: the storage account plus its table/blob services, tables,
// containers, and the two account-scoped data-plane role assignments for the app
// identity (coordinator decision D3: one combined storage module).
//
// Every `if (...)` condition and every name is byte-identical to the
// pre-modularization template; main.bicep passes each derived flag through.
// Pre-existing gaps carried forward unchanged (tracked Follow-Ups): shared-key
// access is not disabled, and both roles are account-scoped.

@description('Azure region for the storage account.')
param location string

@description('Storage account name, computed once in main.bicep: toLower(take(<namePrefix>st<uniqueString(rg)>, 24)).')
param storageAccountName string

@description('Resource id of the app managed identity (deterministic resourceId() from main.bicep; guid() input).')
param identityId string

@description('Principal (object) id of the app managed identity.')
param principalId string

@description('Deploy the storage account (enableTableStorage || enableBlobStorage).')
param enableStorage bool

@description('Deploy the table service (enableRemotePipeline || enableMemoryTable).')
param enableTableStorage bool

@description('Deploy the blob service (enableRenderPptx || enableMemoryOverflow).')
param enableBlobStorage bool

@description('Deploy the async run table (WI-06).')
param enableRemotePipeline bool

@description('Deploy the memory table (enableMemory && memoryBackend == table).')
param enableMemoryTable bool

@description('Deploy the rendered-deck container.')
param enableRenderPptx bool

@description('Deploy the memory overflow container (WI-03).')
param enableMemoryOverflow bool

@description('Azure Table name that holds async run records.')
param runTableName string

@description('Azure Table name that holds squad memory entries.')
param memoryTableName string

@description('Blob container that holds rendered decks.')
param renderBlobContainer string

@description('Blob container that holds memory overflow payloads.')
param memoryOverflowContainer string

// Storage Table Data Contributor — the app + worker identity reads/writes run records.
var storageTableDataContributorRoleId = '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'
// Storage Blob Data Contributor — the app identity writes rendered decks + mints
// user-delegation SAS (grants generateUserDelegationKey/action).
var storageBlobDataContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'

// WI-06: cross-replica run-state + approval store (Azure Table Storage). ETag
// If-Match gives a true compare-and-swap so exactly one replica drives a run.
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = if (enableStorage) {
  // checkov:skip=CKV_AZURE_35:Pre-existing (no networkAcls, so the default action is Allow; access is RBAC data-plane roles over HTTPS/TLS1_2). Storage network restriction is NOT yet an item in the infra plan bicep-modularization Follow-Up Items (the nearest is "Storage account shared-key access"); it must be added there. Behavior is preserved by design.
  // checkov:skip=CKV_AZURE_206:Pre-existing (Standard_LRS; the run-state, memory, and render data is operational and regenerable, and LRS is the cost-reviewed thin-slice default). Storage replication is NOT yet an item in the infra plan bicep-modularization Follow-Up Items; it must be added there. Behavior is preserved by design.
  // checkov:skip=CKV_AZURE_44:False positive. properties.minimumTlsVersion is 'TLS1_2' (see below). Checkov's Bicep adapter does not unwrap the conditional `= if (enableStorage) { ... }` body, so it never sees the property.
  // checkov:skip=CKV_AZURE_43:False positive. Checkov tests the parameter identifier "storageAccountName", which contains an uppercase letter, against ^[a-z0-9]{3,24}$. The value main.bicep passes is toLower(take('<namePrefix>st<uniqueString(rg)>', 24)): lowercase and at most 24 characters, and alphanumeric for an alphanumeric namePrefix (the default gives squadmcpst4109d5a873cda).
  name: storageAccountName
  location: location
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

resource tableService 'Microsoft.Storage/storageAccounts/tableServices@2023-05-01' = if (enableTableStorage) {
  parent: storage
  name: 'default'
}

resource runTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = if (enableRemotePipeline) {
  parent: tableService
  name: runTableName
}

// Shared-state memory broker table. Separate from the run table: a memory entry is
// not a run (DR-03), and memory outlives the run that produced it.
resource memoryTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = if (enableMemoryTable) {
  parent: tableService
  name: memoryTableName
}

// Let the app + worker identity read/write run + memory records. Account-scoped RBAC.
// guid() inputs byte-identical to the baseline (main.bicep:488).
resource storageTableRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (enableTableStorage) {
  name: guid(storageAccountName, identityId, storageTableDataContributorRoleId)
  scope: storage
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageTableDataContributorRoleId)
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}

// squad_render_pptx: a private Blob container for rendered decks + the Blob Data
// Contributor role so the app identity can PUT decks and mint user-delegation SAS
// (that role grants generateUserDelegationKey/action). Public access is disabled;
// each download link is a short-lived per-blob user-delegation SAS.
resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = if (enableBlobStorage) {
  parent: storage
  name: 'default'
}

resource renderContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = if (enableRenderPptx) {
  parent: blobService
  name: renderBlobContainer
  properties: {
    publicAccess: 'None'
  }
}

// WI-03 overflow: a private container for over-threshold memory payloads. The blob
// carries the same at-rest envelope as the primary store; the pointer entity left
// behind never holds plaintext.
resource memoryOverflowBlobContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = if (enableMemoryOverflow) {
  parent: blobService
  name: memoryOverflowContainer
  properties: {
    publicAccess: 'None'
  }
}

// guid() inputs byte-identical to the baseline (main.bicep:526).
resource storageBlobRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (enableBlobStorage) {
  name: guid(storageAccountName, identityId, storageBlobDataContributorRoleId)
  scope: storage
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataContributorRoleId)
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}
