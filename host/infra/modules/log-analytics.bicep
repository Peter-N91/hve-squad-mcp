@description('Log Analytics workspace name.')
param name string

@description('Azure region for the workspace.')
param location string

@description('Workspace data retention in days.')
@minValue(30)
@maxValue(730)
param retentionInDays int

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: name
  location: location
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: retentionInDays
  }
}

output name string = workspace.name
