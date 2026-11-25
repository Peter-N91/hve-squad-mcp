@description('Container Apps Job name.')
param name string

@description('Azure region for the job.')
param location string

@description('Container Apps managed environment resource id.')
param environmentId string

@description('User-assigned managed identity resource id.')
param identityId string

@description('Container image reference.')
param containerImage string

@description('Azure Container Registry login server.')
param containerRegistryServer string

@description('Container App secrets.')
@secure()
param secrets object

@description('Worker environment variables.')
param environmentVariables array

@description('Cron schedule.')
param cronExpression string

@description('Maximum replica execution time in seconds.')
param replicaTimeout int

@description('Maximum replica retries.')
param replicaRetryLimit int

@description('Container CPU allocation.')
param cpu string

@description('Container memory allocation.')
param memory string

resource job 'Microsoft.App/jobs@2024-03-01' = {
  name: name
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identityId}': {}
    }
  }
  properties: {
    environmentId: environmentId
    configuration: {
      triggerType: 'Schedule'
      replicaTimeout: replicaTimeout
      replicaRetryLimit: replicaRetryLimit
      secrets: secrets.items
      scheduleTriggerConfig: {
        cronExpression: cronExpression
        parallelism: 1
        replicaCompletionCount: 1
      }
      registries: [
        {
          server: containerRegistryServer
          identity: identityId
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'hve-squad-mcp-worker'
          image: containerImage
          command: [
            'node'
            'dist/src/worker-main.js'
          ]
          resources: {
            cpu: json(cpu)
            memory: memory
          }
          env: environmentVariables
        }
      ]
    }
  }
}
