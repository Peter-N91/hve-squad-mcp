// Log Analytics workspace for the ACA managed environment's app logs.
//
// S2: this module outputs only the non-secret customerId. The shared key is never
// a module output; container-apps-environment.bicep reads it itself through an
// `existing` reference to this workspace's deterministic name.

@description('Azure region for the workspace.')
param location string

@description('Short prefix for resource names.')
param namePrefix string

@description('Log Analytics retention in days.')
@minValue(30)
@maxValue(730)
param logRetentionDays int

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${namePrefix}-logs'
  location: location
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: logRetentionDays
  }
}

@description('The workspace name (deterministic: <namePrefix>-logs).')
output name string = logAnalytics.name

@description('The workspace customer id (non-secret).')
output customerId string = logAnalytics.properties.customerId
