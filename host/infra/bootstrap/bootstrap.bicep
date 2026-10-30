// hve-squad MCP server — one-time CI bootstrap (subscription scope).
//
// Run ONCE per environment by a human holding Owner (or User Access
// Administrator + Contributor) on the subscription — and roleDefinitions/write on
// every assignable scope below, including a registry / AOAI resource group in
// another subscription (AC-A14 prerequisite). NEVER from CI, never folded into
// main.bicep: a pipeline identity cannot grant itself the rights it runs with
// (research Finding 5). U5: a NAMED human security reviewer signs off on the
// final ABAC condition expressions (modules/abac.bicep) before the first live
// run. Deploy with `az deployment sub create` (Incremental; never Complete).
//
// Structure (AC-A4): at subscription scope this template declares ONLY resource
// groups and custom role definitions. The identities, their federated
// credentials, and every role assignment are in modules with an explicit scope.
//
//   * U1 — ciPlanIdentity / ciDeployIdentity live in a DEDICATED identity
//     resource group that grants them no role; every grant targets the app RG,
//     the registry, or the AOAI account.
//   * S6 — ciPlanIdentity: subjects pull_request + ref:refs/heads/main; role
//     squad-ci-plan-reader only.
//   * S4 / C1 — ciDeployIdentity: Contributor + ABAC-conditioned RBAC
//     Administrator at the app RG (5 role GUIDs, ServicePrincipal only, both CI
//     principals excluded).
//   * S5 / S11 / C2 / C3 — registry: squad-ci-acr-build at the registry;
//     cross-RG: single-GUID (AcrPull) RBAC Administrator at the registry,
//     squad-ci-cross-rg-deploy + squad-ci-plan-reader at its RG. AOAI outside the
//     app RG: single-GUID (OpenAI User) RBAC Administrator at the account plus the
//     same two custom roles at its RG.
//   * AC-A7 — custom role names carry the environment and subscription id;
//     assignableScopes are union()-deduplicated.
//   * U3 (ACCEPTED, tracked) — Contributor on the app RG still allows
//     federatedIdentityCredentials/write on the APP identity, identity
//     assign/action, containerApps listSecrets, storage / Log Analytics listKeys,
//     and redeploying the image as the app identity. Blast radius: Key Vault
//     secrets, storage data, AOAI, and the app identity's Graph Sites.Selected
//     write. Primary control: the prod GitHub Environment gate (required
//     reviewers, prevent self-review, main-only, no admin bypass). A custom
//     Contributor-minus-FIC-write deploy role is a tracked follow-up.

targetScope = 'subscription'

@description('Environment discriminator used in identity and custom-role names, e.g. prod.')
@minLength(2)
@maxLength(12)
param environmentName string

@description('Region for the resource groups and the CI identities.')
param location string = deployment().location

@description('Name of the DEDICATED resource group that holds the two CI identities (U1). Must differ from every target resource group.')
param identityResourceGroupName string

@description('Name of the app resource group main.bicep deploys into (this subscription).')
param appResourceGroupName string

@description('Also declare the app resource group. Leave false for an existing group: an ARM resource-group PUT replaces its tags.')
param createAppResourceGroup bool = false

@description('GitHub repository, owner/repo.')
param githubRepository string

@description('GitHub Environment the deploy job runs in (ciDeployIdentity subject environment:<name>).')
param githubDeployEnvironment string = 'prod'

@description('ARM resource id of the Azure Container Registry the pipeline builds into and the app pulls from.')
param containerRegistryResourceId string

@description('ARM resource id of an EXISTING Azure OpenAI account outside the app resource group. Empty when the account is in the app resource group (or not managed by the pipeline).')
param openAiAccountResourceId string = ''

@description('Tags for the resource groups and identities.')
param tags object = {}

// ---- validated resource-id parsing (C10 / AC-A14): subscription AND RG ----
var acrSegments = split(containerRegistryResourceId, '/')
var acrId = length(acrSegments) != 9
  ? fail('containerRegistryResourceId must be /subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.ContainerRegistry/registries/<name>.')
  : toLower('${acrSegments[6]}/${acrSegments[7]}') != 'microsoft.containerregistry/registries'
      ? fail('containerRegistryResourceId must be a Microsoft.ContainerRegistry/registries resource id.')
      : containerRegistryResourceId
var acrSubscriptionId = split(acrId, '/')[2]
var acrResourceGroupName = split(acrId, '/')[4]
var acrName = split(acrId, '/')[8]

var manageOpenAi = !empty(openAiAccountResourceId)
var aoaiSegments = split(openAiAccountResourceId, '/')
var aoaiId = !manageOpenAi
  ? ''
  : length(aoaiSegments) != 9
      ? fail('openAiAccountResourceId must be /subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.CognitiveServices/accounts/<name>.')
      : toLower('${aoaiSegments[6]}/${aoaiSegments[7]}') != 'microsoft.cognitiveservices/accounts'
          ? fail('openAiAccountResourceId must be a Microsoft.CognitiveServices/accounts resource id.')
          : openAiAccountResourceId
var aoaiSubscriptionId = manageOpenAi ? split(aoaiId, '/')[2] : subscription().subscriptionId
var aoaiResourceGroupName = manageOpenAi ? split(aoaiId, '/')[4] : appResourceGroupName
var aoaiName = manageOpenAi ? split(aoaiId, '/')[8] : ''

// Lower-cased RG ids so union() / comparisons are case-insensitive, as ARM is.
var appRgId = toLower('/subscriptions/${subscription().subscriptionId}/resourceGroups/${appResourceGroupName}')
var identityRgId = toLower('/subscriptions/${subscription().subscriptionId}/resourceGroups/${identityResourceGroupName}')
var acrRgId = toLower('/subscriptions/${acrSubscriptionId}/resourceGroups/${acrResourceGroupName}')
var aoaiRgId = toLower('/subscriptions/${aoaiSubscriptionId}/resourceGroups/${aoaiResourceGroupName}')
var acrCrossRg = acrRgId != appRgId
var aoaiCrossRg = manageOpenAi && aoaiRgId != appRgId

// U1 enforcement: the identity RG must never be a target scope.
var validatedIdentityResourceGroupName = contains([appRgId, acrRgId, aoaiRgId], identityRgId)
  ? fail('identityResourceGroupName must be a dedicated resource group, different from the app, registry, and AOAI resource groups (U1).')
  : identityResourceGroupName

// Deterministic identity resource ids (guid() inputs; never module outputs).
var planIdentityName = 'id-squad-ci-plan-${environmentName}'
var deployIdentityName = 'id-squad-ci-deploy-${environmentName}'
var planIdentityResourceId = resourceId(subscription().subscriptionId, identityResourceGroupName, 'Microsoft.ManagedIdentity/userAssignedIdentities', planIdentityName)
var deployIdentityResourceId = resourceId(subscription().subscriptionId, identityResourceGroupName, 'Microsoft.ManagedIdentity/userAssignedIdentities', deployIdentityName)

// Custom role definition GUIDs (AC-A7: environment-discriminated, per subscription).
var planReaderRoleGuid = guid(subscription().id, 'squad-ci-plan-reader', environmentName)
var crossRgDeployRoleGuid = guid(subscription().id, 'squad-ci-cross-rg-deploy', environmentName)
var acrBuildRoleGuid = guid(subscription().id, 'squad-ci-acr-build', environmentName)
var roleNameSuffix = '${environmentName}-${subscription().subscriptionId}'

// ---------------------------------------------------------------------------
// Subscription-scope resources: resource groups and role definitions ONLY.
// ---------------------------------------------------------------------------

resource identityResourceGroup 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: validatedIdentityResourceGroupName
  location: location
  tags: tags
}

resource appResourceGroup 'Microsoft.Resources/resourceGroups@2024-03-01' = if (createAppResourceGroup) {
  name: appResourceGroupName
  location: location
  tags: tags
}

// S6: read + validate + what-if; no write, no delete, no listKeys/listSecrets
// (those are actions, not */read).
resource planReaderRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: planReaderRoleGuid
  properties: {
    roleName: 'squad-ci-plan-reader-${roleNameSuffix}'
    description: 'Read-only + deployment validate/what-if for the squad CI plan identity. No write/delete on any resource.'
    type: 'CustomRole'
    permissions: [
      {
        actions: [
          '*/read'
          'Microsoft.Resources/deployments/validate/action'
          'Microsoft.Resources/deployments/whatIf/action'
        ]
        notActions: []
      }
    ]
    assignableScopes: union([appRgId], acrCrossRg ? [acrRgId] : [], aoaiCrossRg ? [aoaiRgId] : [])
  }
}

// S5: nested deployments only, in the cross-RG target groups only.
resource crossRgDeployRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = if (acrCrossRg || aoaiCrossRg) {
  name: crossRgDeployRoleGuid
  properties: {
    roleName: 'squad-ci-cross-rg-deploy-${roleNameSuffix}'
    description: 'Create/read nested deployments in a cross-resource-group target of the squad CI deploy identity. No resource write.'
    type: 'CustomRole'
    permissions: [
      {
        actions: [
          'Microsoft.Resources/deployments/*'
        ]
        notActions: []
      }
    ]
    assignableScopes: union(acrCrossRg ? [acrRgId] : [], aoaiCrossRg ? [aoaiRgId] : [])
  }
}

// S11 / C3: exactly what `az acr build` needs; no push/pull data actions.
// Custom-role assignableScopes support management group / subscription / RG
// only, so the role is assignable in the registry's RG and ASSIGNED at the
// registry resource itself (registry-role-assignments.bicep).
resource acrBuildRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: acrBuildRoleGuid
  properties: {
    roleName: 'squad-ci-acr-build-${roleNameSuffix}'
    description: 'az acr build (remote build) on one registry for the squad CI deploy identity. No AcrPush/AcrPull data actions.'
    type: 'CustomRole'
    permissions: [
      {
        actions: [
          'Microsoft.ContainerRegistry/registries/read'
          'Microsoft.ContainerRegistry/registries/listBuildSourceUploadUrl/action'
          'Microsoft.ContainerRegistry/registries/scheduleRun/action'
          'Microsoft.ContainerRegistry/registries/runs/read'
          'Microsoft.ContainerRegistry/registries/runs/listLogSasUrl/action'
        ]
        notActions: []
      }
    ]
    assignableScopes: [
      acrRgId
    ]
  }
}

// ---------------------------------------------------------------------------
// Modules with explicit scopes: identities + FICs, then role assignments.
// ---------------------------------------------------------------------------

module ciIdentities 'modules/ci-identities.bicep' = {
  name: take('${deployment().name}-ci-identities', 64)
  scope: identityResourceGroup
  params: {
    location: location
    environmentName: environmentName
    githubRepository: contains(githubRepository, '/') ? githubRepository : fail('githubRepository must be owner/repo.')
    githubDeployEnvironment: githubDeployEnvironment
    tags: tags
  }
}

module appRgRbac 'modules/rg-role-assignments.bicep' = {
  name: take('${deployment().name}-app-rg-rbac', 64)
  scope: resourceGroup(appResourceGroupName)
  params: {
    deployPrincipalId: ciIdentities.outputs.deployPrincipalId
    planPrincipalId: ciIdentities.outputs.planPrincipalId
    deployIdentityResourceId: deployIdentityResourceId
    planIdentityResourceId: planIdentityResourceId
    planReaderRoleGuid: planReaderRoleGuid
  }
  dependsOn: [
    appResourceGroup
    planReaderRole
  ]
}

module registryRbac 'modules/registry-role-assignments.bicep' = {
  name: take('${deployment().name}-registry-rbac', 64)
  scope: resourceGroup(acrSubscriptionId, acrResourceGroupName)
  params: {
    registryName: acrName
    crossResourceGroup: acrCrossRg
    deployPrincipalId: ciIdentities.outputs.deployPrincipalId
    planPrincipalId: ciIdentities.outputs.planPrincipalId
    deployIdentityResourceId: deployIdentityResourceId
    planIdentityResourceId: planIdentityResourceId
    acrBuildRoleGuid: acrBuildRoleGuid
    crossRgDeployRoleGuid: crossRgDeployRoleGuid
    planReaderRoleGuid: planReaderRoleGuid
  }
  dependsOn: [
    appResourceGroup
    acrBuildRole
    crossRgDeployRole
    planReaderRole
  ]
}

module openAiRbac 'modules/openai-account-role-assignments.bicep' = if (aoaiCrossRg) {
  name: take('${deployment().name}-openai-rbac', 64)
  scope: resourceGroup(aoaiSubscriptionId, aoaiResourceGroupName)
  params: {
    openAiAccountName: aoaiName
    deployPrincipalId: ciIdentities.outputs.deployPrincipalId
    planPrincipalId: ciIdentities.outputs.planPrincipalId
    deployIdentityResourceId: deployIdentityResourceId
    planIdentityResourceId: planIdentityResourceId
    crossRgDeployRoleGuid: crossRgDeployRoleGuid
    planReaderRoleGuid: planReaderRoleGuid
  }
  dependsOn: [
    crossRgDeployRole
    planReaderRole
  ]
}

@description('Tenant id for the GitHub AZURE_TENANT_ID variable.')
output tenantId string = subscription().tenantId

@description('Subscription id for the GitHub AZURE_SUBSCRIPTION_ID variable.')
output subscriptionId string = subscription().subscriptionId

@description('ciPlanIdentity client id — the what-if job\'s AZURE_CLIENT_ID (no environment:, pull_request / push to main only).')
output ciPlanClientId string = ciIdentities.outputs.planClientId

@description('ciDeployIdentity client id — the deploy job\'s AZURE_CLIENT_ID (environment: prod only).')
output ciDeployClientId string = ciIdentities.outputs.deployClientId

@description('ciPlanIdentity principal id (for audit / the U5 ABAC sandbox test).')
output ciPlanPrincipalId string = ciIdentities.outputs.planPrincipalId

@description('ciDeployIdentity principal id (for audit / the U5 ABAC sandbox test).')
output ciDeployPrincipalId string = ciIdentities.outputs.deployPrincipalId

@description('Custom role definition ids created by this bootstrap.')
output customRoleDefinitionIds object = {
  planReader: planReaderRole.id
  crossRgDeploy: (acrCrossRg || aoaiCrossRg) ? crossRgDeployRole.id : ''
  acrBuild: acrBuildRole.id
}
