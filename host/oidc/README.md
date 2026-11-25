<!-- markdownlint-disable-file -->
# OIDC for the Azure deploy

The workflow ([`.github/workflows/azure-infra.yml`](../../.github/workflows/azure-infra.yml))
authenticates to Azure with GitHub **OIDC federated into user-assigned managed
identities** — no client secret, certificate, or CI app registration exists.

## One-time setup

Run [`host/infra/bootstrap/Initialize-AzureCicd.ps1`](../infra/bootstrap/Initialize-AzureCicd.ps1).
It deploys [`host/infra/bootstrap/main.bicep`](../infra/bootstrap/main.bicep), which creates, in
its own CI/CD resource group:

| Identity | Federated subject (only) | Roles on the workload resource group |
| --- | --- | --- |
| `hve-squad-mcp-plan` | `repo:<owner>/<repo>:environment:azure-plan` | custom *hve-squad-mcp what-if*: `*/read`, deployments what-if/validate, and the `join`/`assign` actions what-if's linked access checks need — **cannot change a resource** |
| `hve-squad-mcp-deploy` | `repo:<owner>/<repo>:environment:azure-production` | `Contributor`, plus `Role Based Access Control Administrator` constrained by an ABAC condition to the five roles `main.bicep` grants the app identity |

Every credential uses issuer `https://token.actions.githubusercontent.com` and
audience `api://AzureADTokenExchange`. The script also sets the
`AZURE_PLAN_CLIENT_ID`, `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`,
`AZURE_SUBSCRIPTION_ID`, and `AZURE_RESOURCE_GROUP` repository **variables** (none
of them is a secret) and creates both GitHub environments. `azure-production`
carries the required reviewers — the approval gate — and accepts `main` only, so
the deploy identity is unreachable without approval even if the workflow file is
edited in a pull request.

## Notes

- A federated credential matches the **environment**, not the branch. Renaming an
  environment in the workflow means changing `planEnvironment` / `deployEnvironment`
  in `host/infra/bootstrap/main.bicepparam` and re-running the bootstrap.
- The **app's** managed identity (created by `host/infra/main.bicep`, output
  `appPrincipalId`) is a *third*, separate identity. `main.bicep` grants it
  **Cognitive Services OpenAI User** on the Azure OpenAI account and **AcrPull** on
  the registry itself.

See [../RUNBOOK.md](../RUNBOOK.md) for the full end-to-end sequence.