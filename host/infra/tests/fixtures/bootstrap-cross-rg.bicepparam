using '../../bootstrap/bootstrap.bicep'

// Bootstrap fixture: registry in ANOTHER subscription + RG, existing AOAI account
// in another RG — exercises every cross-RG / single-GUID grant (S5 / C2 / C10).
param environmentName = 'prod'
param location = 'eastus'
param identityResourceGroupName = 'rg-squadmcp-ci-identities'
param appResourceGroupName = 'rg-squadmcp-fixture'
param githubRepository = 'example-org/hve-squad-mcp'
param containerRegistryResourceId = '/subscriptions/44444444-4444-4444-4444-444444444444/resourceGroups/rg-acr-shared/providers/Microsoft.ContainerRegistry/registries/squadfixture'
param openAiAccountResourceId = '/subscriptions/33333333-3333-3333-3333-333333333333/resourceGroups/rg-aoai-shared/providers/Microsoft.CognitiveServices/accounts/squadfixture-aoai'