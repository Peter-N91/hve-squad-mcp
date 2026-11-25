@description('Existing storage account name.')
param storageAccountName string

@description('Table name.')
param tableName string

resource account 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
}

resource service 'Microsoft.Storage/storageAccounts/tableServices@2023-05-01' existing = {
  parent: account
  name: 'default'
}

resource table 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: service
  name: tableName
}
