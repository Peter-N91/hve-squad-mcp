// Azure Container Apps managed environment, streaming app logs to Log Analytics.

@description('Environment name.')
param name string

@description('Azure region.')
param location string

@description('Name of the Log Analytics workspace (same resource group) that receives app logs.')
param logAnalyticsWorkspaceName string

@description('Tags applied to the environment.')
param tags object = {}

// The shared key is read here rather than passed in, so it never crosses a module
// boundary as an output.
resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: logAnalyticsWorkspaceName
}

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: name
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: workspace.properties.customerId
        sharedKey: workspace.listKeys().primarySharedKey
      }
    }
  }
}

@description('Environment resource id.')
output id string = environment.id
