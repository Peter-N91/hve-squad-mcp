@description('Container App name.')
param name string

@description('Azure region for the Container App.')
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

@description('Container environment variables.')
param environmentVariables array

@description('Minimum replicas.')
param minReplicas int

@description('Maximum replicas.')
param maxReplicas int

@description('Maximum concurrent HTTP requests per replica.')
param concurrentRequests string

@description('Container CPU allocation.')
param cpu string

@description('Container memory allocation.')
param memory string

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: name
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identityId}': {}
    }
  }
  properties: {
    managedEnvironmentId: environmentId
    configuration: {
      activeRevisionsMode: 'Single'
      secrets: secrets.items
      ingress: {
        external: true
        targetPort: 3000
        transport: 'auto'
        allowInsecure: false
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
          name: 'hve-squad-mcp'
          image: containerImage
          resources: {
            cpu: json(cpu)
            memory: memory
          }
          env: environmentVariables
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
        rules: [
          {
            name: 'http-concurrency'
            http: {
              metadata: {
                concurrentRequests: concurrentRequests
              }
            }
          }
        ]
      }
    }
  }
}

output fqdn string = app.properties.configuration.ingress.fqdn
