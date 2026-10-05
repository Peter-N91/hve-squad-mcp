// Azure OpenAI account + model deployments (RUNBOOK Step 3 as IaC; D8).
//
// main.bicep deploys this module with an explicit
// `scope: resourceGroup(openAiResourceGroupName)` (A5 / AC-A8) and ONLY when
// openAiMode is 'create', so an 'existing'-mode environment gets no new nested
// deployment, no write, and no spend (U4 / D8). In 'existing' mode this module
// declares nothing: the account is never modified (S10). The Step 7 role
// assignment lives in openai-role-assignment.bicep, never here (A5).
//
// Create-mode hardening (S10): disableLocalAuth true (no API-key path — the app
// identity's Cognitive Services OpenAI User grant is the only access path) and an
// explicit publicNetworkAccess. No output ever carries a key; this module never
// calls listKeys().
//
// Cost (K1): each deployment defaults to GlobalStandard / capacity 10, an
// indicative starting point. Real per-token spend begins in create mode and the
// resource-group $500 budget may not cover it.

import { OpenAiDeployment } from 'types.bicep'

@description('existing = reference a pre-provisioned account (no resources declared here); create = provision the account and its deployments.')
@allowed([
  'existing'
  'create'
])
param openAiMode string = 'existing'

@description('Account name; also the custom subdomain, so the endpoint is https://<name>.openai.azure.com. Validated non-empty and allow-listed by main.bicep before this module is deployed.')
param openAiAccountName string

@description('Azure region for the account (create mode).')
param location string

@description('Account SKU (create mode).')
param openAiSkuName string = 'S0'

@description('Public network access for the account (create mode). Always set explicitly (S10).')
@allowed([
  'Enabled'
  'Disabled'
])
param openAiPublicNetworkAccess string = 'Enabled'

@description('Model deployments to create (create mode). The first entry is the primary deployment.')
param openAiDeployments OpenAiDeployment[] = []

var isCreate = openAiMode == 'create'

resource account 'Microsoft.CognitiveServices/accounts@2024-10-01' = if (isCreate) {
  name: openAiAccountName
  location: location
  kind: 'OpenAI'
  sku: {
    name: openAiSkuName
  }
  properties: {
    customSubDomainName: openAiAccountName
    disableLocalAuth: true
    publicNetworkAccess: openAiPublicNetworkAccess
  }
}

// Deployments on one account are serialized; ARM rejects concurrent deployment
// writes on the same account.
@batchSize(1)
resource deployments 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = [
  for deployment in (isCreate ? openAiDeployments : []): {
    parent: account
    name: deployment.name
    sku: {
      name: deployment.?skuName ?? 'GlobalStandard'
      capacity: deployment.?capacity ?? 10
    }
    properties: {
      model: {
        format: deployment.?modelFormat ?? 'OpenAI'
        name: deployment.modelName
        version: deployment.modelVersion
      }
    }
  }
]

@description('Deterministic endpoint https://<openAiAccountName>.openai.azure.com with NO trailing slash (A6), or empty in existing mode.')
output endpoint string = isCreate ? 'https://${openAiAccountName}.openai.azure.com' : ''

@description('The first deployment name (create mode), or empty.')
output primaryDeploymentName string = isCreate && !empty(openAiDeployments) ? openAiDeployments[0].name : ''
