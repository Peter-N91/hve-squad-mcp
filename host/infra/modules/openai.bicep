// Azure OpenAI account + chat model deployment (RUNBOOK Step 3), and the app
// identity's Cognitive Services OpenAI User grant on it (RUNBOOK Step 7).
//
// create = false reuses an existing account in this resource group and only adds
// the role assignment, for operators who already run an AOAI account.

@description('Create the account and model deployment (true) or reuse an existing account in this resource group (false).')
param create bool

@description('Account name.')
param name string

@description('Custom subdomain of the account; forms the endpoint https://<subdomain>.openai.azure.com.')
param customSubDomainName string = name

@description('Azure region for a created account (model availability varies by region).')
param location string

@description('Model deployment name.')
param deploymentName string

@description('Model name, e.g. gpt-4o.')
param modelName string

@description('Model version, e.g. 2024-11-20.')
param modelVersion string

@description('Deployment SKU, e.g. Standard or GlobalStandard.')
param skuName string

@description('Deployment capacity in thousands of tokens per minute.')
@minValue(1)
param capacity int

@description('Principal id granted Cognitive Services OpenAI User.')
param userPrincipalId string

@description('Resource id of that principal. Seeds the role assignment name.')
param userIdentityId string

@description('Tags applied to a created account.')
param tags object = {}

var cognitiveServicesOpenAiUserRoleId = '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'

resource created 'Microsoft.CognitiveServices/accounts@2024-10-01' = if (create) {
  // checkov:skip=CKV_AZURE_134:The Container Apps environment has no VNet or private endpoint; every call is Entra-authorized by the app identity and key auth is disabled.
  // checkov:skip=CKV_AZURE_236:False positive: Checkov does not read the properties of a conditional (if) resource. disableLocalAuth is true below.
  // checkov:skip=CKV_AZURE_238:False positive: Checkov does not read the properties of a conditional (if) resource. A system-assigned identity is set below.
  name: name
  location: location
  tags: tags
  kind: 'OpenAI'
  identity: {
    type: 'SystemAssigned'
  }
  sku: {
    name: 'S0'
  }
  properties: {
    customSubDomainName: customSubDomainName
    // SEC-10: managed identity only; key-based access is disabled.
    disableLocalAuth: true
    publicNetworkAccess: 'Enabled'
  }
}

resource modelDeployment 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = if (create) {
  parent: created
  name: deploymentName
  sku: {
    name: skuName
    capacity: capacity
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: modelName
      version: modelVersion
    }
  }
}

// One reference that resolves in both modes, so the grant has a single scope.
resource account 'Microsoft.CognitiveServices/accounts@2024-10-01' existing = {
  name: name
}

resource openAiUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceId('Microsoft.CognitiveServices/accounts', name), userIdentityId, cognitiveServicesOpenAiUserRoleId)
  scope: account
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', cognitiveServicesOpenAiUserRoleId)
    principalId: userPrincipalId
    principalType: 'ServicePrincipal'
  }
  dependsOn: [
    created
    modelDeployment
  ]
}

@description('The inference endpoint the server calls (and allow-lists; SEC-3).')
output endpoint string = 'https://${customSubDomainName}.openai.azure.com'

@description('The model deployment name.')
output deploymentName string = deploymentName
