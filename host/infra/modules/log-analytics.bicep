// Log Analytics workspace that receives the Container Apps environment logs.

@description('Workspace name.')
param name string

@description('Azure region.')
param location string

@description('Retention in days.')
@minValue(30)
@maxValue(730)
param retentionInDays int

@description('Tags applied to the workspace.')
param tags object = {}

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: name
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: retentionInDays
  }
}

@description('Workspace name, for modules that read its shared key through an existing reference.')
output name string = workspace.name
