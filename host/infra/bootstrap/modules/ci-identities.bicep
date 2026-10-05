// The two CI user-assigned managed identities and their GitHub OIDC federated
// credentials (U1 / S6 / A11 / D7). Deployed by bootstrap.bicep into the
// DEDICATED identity resource group, which grants neither identity any role:
// every role either identity holds is scoped to another resource group or
// resource (see rg-role-assignments.bicep / registry-role-assignments.bicep /
// openai-account-role-assignments.bicep).
//
// Native UAMI federatedIdentityCredentials need no Entra app registration and no
// Microsoft Graph permission (D7).

@description('Azure region for the identities.')
param location string

@description('Environment discriminator, e.g. prod.')
param environmentName string

@description('GitHub repository as owner/repo.')
param githubRepository string

@description('GitHub Environment the deploy job runs in (subject environment:<name>).')
param githubDeployEnvironment string

@description('Tags applied to both identities.')
param tags object = {}

var githubIssuer = 'https://token.actions.githubusercontent.com'
var tokenAudiences = [
  'api://AzureADTokenExchange'
]

// Plan / what-if identity: read-only custom role only (S6).
resource ciPlanIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-squad-ci-plan-${environmentName}'
  location: location
  tags: tags
}

// Deploy identity: used only from the protected GitHub Environment (S7).
resource ciDeployIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-squad-ci-deploy-${environmentName}'
  location: location
  tags: tags
}

// S6: exactly two subjects for the plan identity — pull_request and push to main.
resource planPullRequest 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: ciPlanIdentity
  name: 'github-pull-request'
  properties: {
    issuer: githubIssuer
    subject: 'repo:${githubRepository}:pull_request'
    audiences: tokenAudiences
  }
}

// A11: ARM rejects concurrent federated-credential writes on one UAMI, so the
// second credential on the same identity waits for the first explicitly.
resource planMain 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: ciPlanIdentity
  name: 'github-main'
  properties: {
    issuer: githubIssuer
    subject: 'repo:${githubRepository}:ref:refs/heads/main'
    audiences: tokenAudiences
  }
  dependsOn: [
    planPullRequest
  ]
}

// The deploy identity trusts only the protected Environment (matches
// host/oidc/deploy-aca.workflow.yml's environment: prod convention).
resource deployEnvironment 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: ciDeployIdentity
  name: 'github-environment-${githubDeployEnvironment}'
  properties: {
    issuer: githubIssuer
    subject: 'repo:${githubRepository}:environment:${githubDeployEnvironment}'
    audiences: tokenAudiences
  }
  // Serialize every federated-credential write in this deployment (A11), not only
  // the two on the same identity; costs seconds, removes the race entirely.
  dependsOn: [
    planMain
  ]
}

@description('ciPlanIdentity principal (object) id.')
output planPrincipalId string = ciPlanIdentity.properties.principalId

@description('ciPlanIdentity client id (the what-if job\'s AZURE_CLIENT_ID).')
output planClientId string = ciPlanIdentity.properties.clientId

@description('ciDeployIdentity principal (object) id.')
output deployPrincipalId string = ciDeployIdentity.properties.principalId

@description('ciDeployIdentity client id (the deploy job\'s AZURE_CLIENT_ID).')
output deployClientId string = ciDeployIdentity.properties.clientId
