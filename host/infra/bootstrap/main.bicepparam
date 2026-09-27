using './main.bicep'

// One-time CI/CD bootstrap. Apply with host/infra/bootstrap/Initialize-AzureCicd.ps1
// (or `az deployment sub create`) as an operator who can assign roles.

param location = 'eastus2'
param workloadResourceGroupName = 'hve-squad-mcp-rg'
param cicdResourceGroupName = 'hve-squad-mcp-cicd-rg'
param planIdentityName = 'hve-squad-mcp-plan'
param deployIdentityName = 'hve-squad-mcp-deploy'
param githubRepository = 'Peter-N91/hve-squad-mcp'

// Must match the `environment:` names in .github/workflows/azure-infra.yml.
//   azure-plan       — what-if, runs automatically, read-only identity
//   azure-production — deploy, gated by the environment's required reviewers
param planEnvironment = 'azure-plan'
param deployEnvironment = 'azure-production'

param tags = {
  workload: 'hve-squad-mcp'
  managedBy: 'bicep'
}