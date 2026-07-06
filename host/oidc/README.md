<!-- markdownlint-disable-file -->
# OIDC setup for the ACA deploy

The deploy workflow ([deploy-aca.workflow.yml](deploy-aca.workflow.yml)) authenticates to Azure with
Entra **workload-identity federation (OIDC)** — no client secret is ever stored.

## Reuse the azure-scaffold OIDC wizard

This package already ships a one-time OIDC setup script under the `azure-scaffold` skill. Reuse it
rather than duplicating it here:

- Template: `squad-src/.github/skills/azure-scaffold/Setup-AzureOidc.template.ps1`
- Copy to your consumer repo as `scripts/Setup-AzureOidc.ps1`, then run it once.

It creates the Entra app registration, the federated credential, the RBAC role assignments, and the
GitHub secrets/variables (`AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`) the deploy
workflow consumes.

## ACA-specific notes

- The federated credential **subject** must match the workflow's environment, e.g.
  `repo:<owner>/<repo>:environment:prod` (the deploy workflow uses `environment: prod`).
- The deploy identity needs `Contributor` (or a narrower custom role) on the target resource group,
  plus `AcrPush` on the registry if the workflow builds the image in ACR.
- The **app's** managed identity (created by `host/infra/main.bicep`, output `appPrincipalId`) is a
  *separate* identity from the deploy identity. Grant it **Cognitive Services OpenAI User** on the
  Azure OpenAI account so the embedded backend can call inference with managed identity (no key).

See [../RUNBOOK.md](../RUNBOOK.md) for the full end-to-end sequence.
