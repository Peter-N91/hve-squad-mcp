using '../../../main.bicep'

// Build-params fixture (A9). Dummy, non-secret values only: every id below is a
// documentation placeholder, never a real tenant, subscription, or principal.

param containerImage = 'squadfixture.azurecr.io/hve-squad-mcp:fixture'
param containerRegistryServer = 'squadfixture.azurecr.io'
param authClientId = '11111111-1111-1111-1111-111111111111'
param authOpenIdIssuer = 'https://login.microsoftonline.com/22222222-2222-2222-2222-222222222222/v2.0'

param squad = {
  audience: 'api://11111111-1111-1111-1111-111111111111'
  allowedOrigins: 'https://copilotstudio.microsoft.com'
  allowedIssuers: 'https://login.microsoftonline.com/22222222-2222-2222-2222-222222222222/v2.0'
  allowedTenants: '22222222-2222-2222-2222-222222222222'
  jwksUri: 'https://login.microsoftonline.com/22222222-2222-2222-2222-222222222222/discovery/v2.0/keys'
  modelEndpoint: 'https://squadfixture-aoai.openai.azure.com'
  allowedModelEndpoints: 'https://squadfixture-aoai.openai.azure.com'
  modelDeployment: 'gpt-4o'
  modelApiVersion: '2024-10-21'
  tenantConcurrency: 4
  tenantCostCeilingUsd: 500
}

param minReplicas = 0
param maxReplicas = 5
param budgetAmountUsd = 500
param budgetAlertEmails = [
  'alerts@example.com'
]
// EXPECTED FAILURE (budget start date guard): not the first day of a month.
param budgetStartDate = '2026-09-15'
