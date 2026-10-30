using '../../bootstrap/bootstrap.bicep'

// Bootstrap fixture: registry and AOAI in the app resource group (no cross-RG
// grants, no squad-ci-cross-rg-deploy role). Dummy, non-secret identifiers only.
param environmentName = 'prod'
param location = 'eastus'
param identityResourceGroupName = 'rg-squadmcp-ci-identities'
param appResourceGroupName = 'rg-squadmcp-fixture'
param createAppResourceGroup = true
param githubRepository = 'example-org/hve-squad-mcp'
param githubDeployEnvironment = 'prod'
param containerRegistryResourceId = '/subscriptions/33333333-3333-3333-3333-333333333333/resourceGroups/rg-squadmcp-fixture/providers/Microsoft.ContainerRegistry/registries/squadfixture'
param openAiAccountResourceId = ''