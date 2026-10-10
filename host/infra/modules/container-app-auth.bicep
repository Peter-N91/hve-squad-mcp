@description('Existing Container App name.')
param containerAppName string

@description('Entra application client id.')
param clientId string

@description('Entra OpenID issuer URL.')
param openIdIssuer string

@description('Allowed token audience.')
param audience string

resource app 'Microsoft.App/containerApps@2024-03-01' existing = {
  name: containerAppName
}

resource auth 'Microsoft.App/containerApps/authConfigs@2024-03-01' = {
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
          openIdIssuer: openIdIssuer
          clientId: clientId
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
