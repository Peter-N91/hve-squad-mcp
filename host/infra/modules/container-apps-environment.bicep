// ACA managed environment wired to the Log Analytics workspace.
//
// S2 / A8: the workspace shared key never crosses a module boundary. This module
// takes the workspace's deterministic NAME (not a resource id or a module
// output), declares its own `existing` reference, and calls listKeys() locally.
// Neither the key nor the customer id is output.

@description('Azure region for the environment.')
param location string

@description('Short prefix for resource names.')
param namePrefix string

@description('Deterministic name of the Log Analytics workspace (<namePrefix>-logs) in this resource group.')
param logAnalyticsWorkspaceName string

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: logAnalyticsWorkspaceName
}

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${namePrefix}-env'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
  }
}

@description('The managed environment resource id.')
output id string = environment.id
