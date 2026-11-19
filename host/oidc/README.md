<!-- markdownlint-disable-file -->
# OIDC setup for Azure deployment

This repository's real CI/CD pipeline — [`.github/workflows/infra-validate.yml`](../../.github/workflows/infra-validate.yml)
(lint + gated what-if, every PR/push) and
[`.github/workflows/infra-deploy.yml`](../../.github/workflows/infra-deploy.yml)
(verified-SHA resolve, approval-gated build/deploy) — authenticates to Azure with
Entra **workload-identity federation (OIDC)**. No client secret is ever stored.

## Provision the two CI identities: `host/infra/bootstrap/bootstrap.bicep`

The actual, one-time identity setup for this repository is
[`host/infra/bootstrap/bootstrap.bicep`](../infra/bootstrap/bootstrap.bicep), run
once per environment by an operator (never from CI — see
[../RUNBOOK.md](../RUNBOOK.md), Step 1):

```bash
az deployment sub create \
  --location "$LOCATION" \
  --template-file host/infra/bootstrap/bootstrap.bicep \
  --parameters host/infra/bootstrap/bootstrap.local.bicepparam
```

It creates:

- **`ciPlanIdentity`** — a read-only what-if identity
  (`squad-ci-plan-reader`: `*/read` + `deployments/validate/action` +
  `deployments/whatIf/action`, no write/delete/`listKeys`). Federated-credential
  subjects: `repo:<owner>/<repo>:pull_request` and
  `repo:<owner>/<repo>:ref:refs/heads/main`. Used by `infra-validate.yml`'s
  `what-if` job and `infra-deploy.yml`'s pre-approval `what-if`/`smoke` jobs —
  none of which declares `environment:`.
- **`ciDeployIdentity`** — the deploy identity, federated only on
  `repo:<owner>/<repo>:environment:prod`. Used by `infra-deploy.yml`'s `build`
  and `deploy` jobs, both of which declare `environment: prod` — so this
  identity's token is issued only inside that protected GitHub Environment.

Map the deployment's outputs (`ciPlanClientId`, `ciDeployClientId`, `tenantId`,
`subscriptionId`) to GitHub variables exactly as
[../RUNBOOK.md](../RUNBOOK.md) Step 1 and its pipeline subsection document —
`ciPlanClientId` → the repo-level `CI_PLAN_CLIENT_ID` variable,
`ciDeployClientId` → the `prod`-environment-level `AZURE_CLIENT_ID` variable.

Before running `bootstrap.bicep` (or `entra-app.bicep`, Step 2) against a real
subscription/tenant, a **named human security reviewer** must sign off on the
compiled ABAC condition strings, the three custom role definitions, and the
dedicated-identity-resource-group isolation — see [../RUNBOOK.md](../RUNBOOK.md)
Step 1's "U5 gate" for the full checklist. This is a one-time, human-run,
Impactful-Action-Gated action, not something either workflow ever performs.

Once the `prod` GitHub Environment itself needs its protection rules (required
reviewers, prevent-self-review, `main`-only deployment branch policy)
configured, use
[`.github/scripts/setup-prod-environment.sh`](../../.github/scripts/setup-prod-environment.sh)
— also operator-run, never invoked by CI.

## This file's neighbor: `deploy-aca.workflow.yml`

[`deploy-aca.workflow.yml`](deploy-aca.workflow.yml) is a **deprecated,
corrected historical reference** — it predates `infra-validate.yml`/
`infra-deploy.yml`, cannot run from this repository (its `.workflow.yml`
suffix keeps it out of `.github/workflows/`), and its own header now names
every insecure pattern a reader must not copy (an unpinned `azure/login@v2`, a
non-secret client/tenant/subscription id stored as a GitHub secret, and build
paths that do not exist in this repository's layout). Read the two real
workflows instead.

## ACA-specific notes (still accurate)

- The **deploy** identity's federated-credential **subject** matches the
  GitHub Environment it is scoped to, e.g. `repo:<owner>/<repo>:environment:prod`
  — exactly what `ciDeployIdentity` above uses, and what `infra-deploy.yml`'s
  `build`/`deploy` jobs' `environment: prod` key requires to receive a token.
- The deploy identity needs `Contributor` (or a narrower custom role) on the
  target resource group, plus registry build permissions
  (`squad-ci-acr-build`, no `AcrPush`) — both provisioned by `bootstrap.bicep`,
  not granted by hand.
- The **app's** managed identity (created by `host/infra/main.bicep`, output
  `appPrincipalId`) is a *separate* identity from the deploy identity. Grant it
  **Cognitive Services OpenAI User** on the Azure OpenAI account so the
  embedded backend can call inference with managed identity (no key) —
  `main.bicepparam`'s / `prod.bicepparam`'s `manageOpenAiRoleAssignment` flag
  automates this (see [../RUNBOOK.md](../RUNBOOK.md) Step 7).

See [../RUNBOOK.md](../RUNBOOK.md) for the full end-to-end sequence, including
the pipeline's own variable/secret inventory and kill-switch/enablement
procedure.
