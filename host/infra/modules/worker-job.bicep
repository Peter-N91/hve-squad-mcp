// WI-1b4-WORKER: a scheduled ACA Job drains approved runs off the request path so
// a run may exceed the 240s HTTP ingress ceiling. It shares the app image + the
// same identity + the same cross-replica store; SQUAD_MCP_WORKER_ONCE makes each
// scheduled run a single drain pass that exits.
//
// S1: the run-encryption key arrives as a @secure() string and the ACA
// `secrets:` array is built inside this module, independently of container-app.

@description('Azure region for the job.')
param location string

@description('Short prefix for resource names.')
param namePrefix string

@description('Resource id of the ACA managed environment (deterministic resourceId() from main.bicep).')
param managedEnvironmentId string

@description('Resource id of the app managed identity (deterministic resourceId() from main.bicep).')
param identityId string

@description('Container image reference.')
param containerImage string

@description('Azure Container Registry login server the image is pulled from.')
param containerRegistryServer string

@description('Base64-encoded 32-byte AES-256-GCM key (MEDIUM-3). Empty = platform-only at-rest encryption. Secure end to end (S1).')
@secure()
param runEncryptionKeyBase64 string = ''

@description('Cron schedule for the drain pass.')
param workerCron string

@description('The fully concatenated worker env array, assembled in main.bicep (research D2).')
param env object[]

// Encryption key passed as an ACA secret (never a plain env value). Built inside
// this module from the secure string (S1).
var encryptionSecrets = !empty(runEncryptionKeyBase64)
  ? [ { name: 'run-encryption-key', value: runEncryptionKeyBase64 } ]
  : []

resource workerJob 'Microsoft.App/jobs@2024-03-01' = {
  name: '${namePrefix}-worker'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identityId}': {}
    }
  }
  properties: {
    environmentId: managedEnvironmentId
    configuration: {
      triggerType: 'Schedule'
      replicaTimeout: 1800
      replicaRetryLimit: 1
      secrets: encryptionSecrets
      scheduleTriggerConfig: {
        cronExpression: workerCron
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
          command: [ 'node', 'dist/src/worker-main.js' ]
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: env
        }
      ]
    }
  }
}
