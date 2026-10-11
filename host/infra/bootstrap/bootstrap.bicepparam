using './bootstrap.bicep'

// One-time, human-run CI bootstrap (subscription scope). NOT part of the
// per-commit pipeline. Apply with:
//   az deployment sub create --location <LOCATION> \
//     --template-file host/infra/bootstrap/bootstrap.bicep \
//     --parameters host/infra/bootstrap/bootstrap.bicepparam
// only AFTER the named security reviewer's sign-off on the ABAC conditions (U5).
// Copy to bootstrap.local.bicepparam for real values; replace every <PLACEHOLDER>.
// No secret belongs here — every value below is an identifier.

param environmentName = 'prod'
param location = '<LOCATION>'

// U1: a resource group that holds ONLY the two CI identities and grants them no role.
param identityResourceGroupName = '<CI_IDENTITY_RG>'

// The resource group main.bicep deploys into. Set createAppResourceGroup = true
// only for a brand-new group (an ARM RG PUT replaces an existing group's tags).
param appResourceGroupName = '<RESOURCE_GROUP>'
param createAppResourceGroup = false

// The GitHub repository whose workflows federate to the CI identities:
//   ciPlanIdentity   -> repo:<owner>/<repo>:pull_request, repo:<owner>/<repo>:ref:refs/heads/main
//   ciDeployIdentity -> repo:<owner>/<repo>:environment:<githubDeployEnvironment>
param githubRepository = '<OWNER>/<REPO>'
param githubDeployEnvironment = 'prod'

// The registry `az acr build` pushes to and the app pulls from. Its subscription
// and resource group are parsed from the id; a registry outside the app RG gets
// the cross-RG grants automatically.
param containerRegistryResourceId = '/subscriptions/<SUB_ID>/resourceGroups/<ACR_RG>/providers/Microsoft.ContainerRegistry/registries/<REGISTRY>'

// Only when an EXISTING Azure OpenAI account lives outside the app resource group;
// otherwise leave empty.
param openAiAccountResourceId = ''

param tags = {}
