<!-- markdownlint-disable-file -->
# Managed-identity OIDC setup for Azure deployment

The active workflow at
[`/.github/workflows/azure-deploy.yml`](../../.github/workflows/azure-deploy.yml)
uses a **user-assigned managed identity** with GitHub OIDC federation. It stores
no client secret.

The identities are deliberately separate:

- **Deployment identity:** GitHub assumes this identity. It runs what-if, builds
  the image in ACR, deploys the Bicep template, and creates the template's RBAC
  assignments.
- **Application identity:** `main.bicep` creates this identity for the Container
  App and worker. The modular template grants it ACR pull, Azure OpenAI inference,
  Key Vault secret read, and optional Storage data access.

## One-time setup

Sign in with Azure Owner permissions on the target resource group and with a
GitHub account that can manage repository environments and variables:

```powershell
az login --tenant '<ENTRA_TENANT_ID>'
az account set --subscription '<SUBSCRIPTION_ID>'
gh auth login

./host/oidc/Setup-AzureDeploymentIdentity.ps1 `
  -GitHubRepository 'owner/repository' `
  -ResourceGroup '<RESOURCE_GROUP>' `
  -ContainerRegistryName '<REGISTRY>' `
  -ProductionApprover '<GITHUB_USERNAME>' `
  -Location '<AZURE_REGION>'
```

The idempotent script:

1. creates the resource group and ACR when needed;
2. creates a user-assigned deployment identity;
3. grants it `Contributor` and `Role Based Access Control Administrator` on the
   resource group, plus `AcrPush` on the existing registry;
4. creates OIDC credentials for the `preview` and `production` GitHub
   environments;
5. creates an unprotected `preview` environment and a `production` environment
   with the specified required reviewer; and
6. writes `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`,
   `AZURE_SUBSCRIPTION_ID`, and `AZURE_RESOURCE_GROUP` as repository variables.

The `preview` environment runs Azure what-if automatically on trusted pushes to
`main` and manual workflow runs. The `production` environment pauses the deploy
job for reviewer approval before ACR build or Azure deployment starts.

## Workflow behavior

- Pull requests that change `host/infra/**` lint and compile both Bicep parameter
  files without receiving an Azure token.
- Pushes to `main` that affect the image or infrastructure run lint, compile, and
  Azure what-if.
- A successful what-if queues the `production` job. Deployment starts only after
  the configured reviewer approves it.
- The workflow reads the registry and image repository from
  `host/infra/main.bicepparam`; the immutable image tag is always the commit SHA.

The Entra resource-server app registration and Copilot Studio connector consent
remain tenant-administrator operations; they are not ARM resources and are kept
outside the routine deployment identity.

See [the deployment runbook](../RUNBOOK.md) for the complete sequence.
