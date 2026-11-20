// WI-1b4-WORKER: a scheduled ACA Job that drains approved runs off the request
// path so a run may exceed the 240s ingress ceiling. It shares the app image, the
// app identity, and the cross-replica store; SQUAD_MCP_WORKER_ONCE makes each
// scheduled execution a single drain pass that exits.

@description('Job name.')
param name string

@description('Azure region.')
param location string

@description('Managed environment resource id.')
param environmentId string

@description('User-assigned identity the job runs as and pulls its image with.')
param identityId string

@description('Registry login server the image is pulled from.')
param registryServer string

@description('Full image reference (the app image).')
param image string

@description('Container environment variables. Secret values appear only as secretRef entries.')
param env object[]

@description('Base64 32-byte run encryption key, stored as an ACA secret. Empty = no secret.')
@secure()
param runEncryptionKeyBase64 string = ''

@description('Cron schedule of the drain pass.')
param cronExpression string

@description('Tags applied to the job.')
param tags object = {}

var secrets = empty(runEncryptionKeyBase64)
  ? []
  : [
      { name: 'run-encryption-key', value: runEncryptionKeyBase64 }
    ]

resource workerJob 'Microsoft.App/jobs@2024-03-01' = {
  name: name
  location: location
  tags: tags
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
      replicaTimeout: 1800
      replicaRetryLimit: 1
      secrets: secrets
      scheduleTriggerConfig: {
        cronExpression: cronExpression
        parallelism: 1
        replicaCompletionCount: 1
      }
      registries: [
        {
          server: registryServer
          identity: identityId
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'hve-squad-mcp-worker'
          image: image
          command: [ 'node', 'dist/src/worker-main.js' ]
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: concat(env, [
            { name: 'SQUAD_MCP_WORKER_ONCE', value: 'true' }
          ])
        }
      ]
    }
  }
}
