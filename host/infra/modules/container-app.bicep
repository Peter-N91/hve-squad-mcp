// The scale-to-zero Container App serving the Streamable HTTP /mcp endpoint, plus
// its ACA built-in Entra auth config.
//
// Council conditions carried here (moved from the pre-modularization header):
//   * COST-3 / ARCH-2 — minReplicas 0 with ACA's idle scale-down (~5 min).
//   * SEC-8           — HTTPS-only ingress (allowInsecure: false).
//   * SEC-1           — ACA built-in Entra auth in front of the app's own
//                       audience-bound validation (defense-in-depth).
//   * SEC-10 / S1     — the run-encryption key arrives as a @secure() string and
//                       the ACA `secrets:` array is built HERE, so no secret ever
//                       crosses a module boundary as a plain array/object.

@description('Azure region for the app.')
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

@description('The fully concatenated container env array, assembled in main.bicep (research D2).')
param env object[]

@description('Minimum replicas. 0 enables scale-to-zero (COST-3 / ARCH-2).')
@minValue(0)
@maxValue(5)
param minReplicas int

@description('Maximum replicas.')
@minValue(1)
@maxValue(30)
param maxReplicas int

@description('Entra application (client) id for the ACA built-in auth (SEC-1).')
param authClientId string

@description('Entra OpenID issuer URL for the ACA built-in auth.')
param authOpenIdIssuer string

@description('Token audience accepted by the ACA built-in auth (squad.audience).')
param audience string

// Encryption key passed as an ACA secret (never a plain env value). Built inside
// this module from the secure string (S1).
var encryptionSecrets = !empty(runEncryptionKeyBase64)
  ? [ { name: 'run-encryption-key', value: runEncryptionKeyBase64 } ]
  : []

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${namePrefix}-app'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identityId}': {}
    }
  }
  properties: {
    managedEnvironmentId: managedEnvironmentId
    configuration: {
      activeRevisionsMode: 'Single'
      secrets: encryptionSecrets
      ingress: {
        external: true
        targetPort: 3000
        transport: 'auto'
        // SEC-8: HTTPS-only — reject plaintext at the ingress.
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
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: env
        }
      ]
      scale: {
        // COST-3 / ARCH-2: scale-to-zero with HTTP-driven scale-out.
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

// SEC-1 (defense-in-depth): require an Entra token at the ingress in addition to
// the app's own audience-bound validation. The original Authorization header is
// forwarded so the app still performs audience + per-tool scope checks.
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
