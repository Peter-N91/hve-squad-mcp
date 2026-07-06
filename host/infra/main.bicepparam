using './main.bicep'

// Replace every <PLACEHOLDER> with your tenant's values before deploying.
// No secret belongs here — the model token comes from managed identity at runtime.

param containerImage = '<REGISTRY>.azurecr.io/hve-squad-mcp:latest'
param containerRegistryServer = '<REGISTRY>.azurecr.io'
param authClientId = '<ENTRA_CLIENT_ID>'
param authOpenIdIssuer = 'https://login.microsoftonline.com/<ENTRA_TENANT_ID>/v2.0'

param squad = {
  audience: 'api://<ENTRA_CLIENT_ID>'
  allowedOrigins: 'https://copilotstudio.microsoft.com'
  allowedIssuers: 'https://login.microsoftonline.com/<ENTRA_TENANT_ID>/v2.0'
  allowedTenants: '<ENTRA_TENANT_ID>'
  jwksUri: 'https://login.microsoftonline.com/<ENTRA_TENANT_ID>/discovery/v2.0/keys'
  modelEndpoint: 'https://<AOAI_RESOURCE>.openai.azure.com'
  allowedModelEndpoints: 'https://<AOAI_RESOURCE>.openai.azure.com'
  modelDeployment: '<AOAI_DEPLOYMENT>'
  modelApiVersion: '2024-10-21'
  tenantConcurrency: 4
  tenantCostCeilingUsd: 500
}

param minReplicas = 0
param maxReplicas = 5
param budgetAmountUsd = 500
param budgetStartDate = '2026-07-01'
param budgetAlertEmails = [
  '<ALERT_EMAIL>'
]
