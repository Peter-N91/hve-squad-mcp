// The scale-to-zero Container App serving Streamable HTTP /mcp, plus ACA built-in
// Entra auth in front of the app's own audience-bound validation.
//   * COST-3 / ARCH-2 — minReplicas 0 with ACA's idle scale-down.
//   * SEC-8           — HTTPS-only ingress (allowInsecure: false).
//   * SEC-1           — built-in Entra auth (defense-in-depth).

@description('Container App name.')
param name string

@description('Azure region.')
param location string

@description('Managed environment resource id.')
param environmentId string

@description('User-assigned identity the app runs as and pulls its image with.')
param identityId string

@description('Registry login server the image is pulled from.')
param registryServer string

@description('Full image reference.')
param image string

@description('Container environment variables. Secret values appear only as secretRef entries.')
param env object[]

@description('Base64 32-byte run encryption key, stored as an ACA secret (never a plain env value). Empty = no secret.')
@secure()
param runEncryptionKeyBase64 string = ''

@description('Minimum replicas. 0 enables scale-to-zero.')
@minValue(0)
param minReplicas int

@description('Maximum replicas.')
@minValue(1)
param maxReplicas int

@description('Entra application (client) id for the ACA built-in auth.')
param authClientId string

@description('Entra OpenID issuer URL for the ACA built-in auth.')
param authOpenIdIssuer string

@description('Token audience accepted at the ingress.')
param audience string

@description('Tags applied to the app.')
param tags object = {}

var secrets = empty(runEncryptionKeyBase64)
  ? []
  : [
      { name: 'run-encryption-key', value: runEncryptionKeyBase64 }
    ]

resource app 'Microsoft.App/containerApps@2024-03-01' = {
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
    managedEnvironmentId: environmentId
    configuration: {
      activeRevisionsMode: 'Single'
      secrets: secrets
      ingress: {
        external: true
        targetPort: 3000
        transport: 'auto'
        allowInsecure: false
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
          name: 'hve-squad-mcp'
          image: image
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: env
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
                concurrentRequests: '20'
              }
            }
          }
        ]
      }
    }
  }
}

// The original Authorization header is forwarded so the app still performs
// audience + per-tool scope checks.
resource authConfig 'Microsoft.App/containerApps/authConfigs@2024-03-01' = {
  parent: app
  name: 'current'
  properties: {
    platform: {
      enabled: true
    }
    globalValidation: {
      unauthenticatedClientAction: 'Return401'
    }
    identityProviders: {
      azureActiveDirectory: {
        enabled: true
        registration: {
          openIdIssuer: authOpenIdIssuer
          clientId: authClientId
        }
        validation: {
          allowedAudiences: [
            audience
          ]
        }
      }
    }
  }
}

@description('The HTTPS FQDN of the /mcp endpoint.')
output fqdn string = app.properties.configuration.ingress.fqdn
