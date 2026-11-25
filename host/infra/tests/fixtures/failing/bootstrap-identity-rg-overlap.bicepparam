using '../../../bootstrap/bootstrap.bicep'

// EXPECTED FAILURE (U1): the "dedicated" identity RG is the app RG.
param environmentName = 'prod'
param location = 'eastus'
param identityResourceGroupName = 'rg-squadmcp-fixture'
param appResourceGroupName = 'rg-squadmcp-fixture'
param githubRepository = 'example-org/hve-squad-mcp'
param containerRegistryResourceId = '/subscriptions/33333333-3333-3333-3333-333333333333/resourceGroups/rg-squadmcp-fixture/providers/Microsoft.ContainerRegistry/registries/squadfixture'