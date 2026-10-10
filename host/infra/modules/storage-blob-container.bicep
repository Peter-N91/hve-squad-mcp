@description('Existing storage account name.')
param storageAccountName string

@description('Private blob container name.')
param containerName string

resource account 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
}

resource service 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' existing = {
  parent: account
  name: 'default'
}

resource container 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: service
  name: containerName
  properties: {
    publicAccess: 'None'
  }
}
