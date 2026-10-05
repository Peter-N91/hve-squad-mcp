---
bump: minor
type: Added
---

- **The runbook's Azure deployment is now automated end to end.** A new
  `Azure infrastructure` workflow (`.github/workflows/azure-infra.yml`) lints and
  compiles every Bicep template and parameter file and runs `what-if` on every
  change, then deploys only after a required reviewer approves the
  `azure-production` environment. It signs in as a user-assigned managed identity
  through GitHub OIDC (no stored secret) that only the approval-gated environment
  can reach, deploys the foundation, builds the image
  in ACR tagged with the commit SHA, deploys the app, and smoke-tests `/mcp`.
- **`host/infra/main.bicep` is now an orchestrator over one module per resource**
  (`host/infra/modules/`), and every deployment value lives in
  `host/infra/main.bicepparam`. The template now also provisions the container
  registry (with `AcrPull` for the app identity, which pulls previously lacked) and
  the Azure OpenAI account and model deployment with key auth disabled, and grants
  the app identity `Cognitive Services OpenAI User` — RUNBOOK Steps 3, 5 and 7 are
  no longer manual. The model endpoint and its allow-list derive from that account.
  Breaking for existing parameter files: `containerImage`, `containerRegistryServer`
  and the `squad.model*` fields are replaced by `imageRepository`,
  `containerImageTag` and the `openAi` object.
- **One-time bootstrap** (`host/infra/bootstrap/Initialize-AzureCicd.ps1` +
  `bootstrap/main.bicep`) registers the resource providers and creates two CI
  identities: a plan identity whose custom role can read and run what-if but not
  change anything, and a deploy identity (Contributor plus an ABAC-constrained RBAC
  Administrator, workload resource group only) federated solely to the approval-gated
  environment. It also creates the Entra app registration with every scope and the
  `Squad.Operate` role, and the GitHub environments and variables. It replaces the
  reference `host/oidc/deploy-aca.workflow.yml`.
