<!-- markdownlint-disable-file -->
# RUNBOOK — deploy the hve-squad MCP remote thin slice to YOUR Azure tenant

> **Documentation-only.** This runbook is a reference sequence. Nothing here runs
> automatically — you (the operator) run each step in **your own** Azure tenant
> after reviewing it. Replace every `<PLACEHOLDER>` with your values.
>
> **Fidelity claim (locked):** squad-guided / embedded — NOT "squad-executed". The
> squad runs server-side under its gates and methodology and returns a finished
> artifact; the calling agent is guided by the squad, it does not itself execute
> the cast.

This is the end-to-end sequence the connector README, `host/infra/main.bicep`, and
the connector generator all point at. It stands up the scale-to-zero Azure
Container Apps (ACA) app that serves the Streamable HTTP `/mcp` endpoint with
Entra authentication and managed-identity secrets, then imports the generated
Copilot Studio connector.

The remote surface exposes six tools: four **synchronous advisory tools**
`squad_research`, `squad_review`, `squad_plan`, and `squad_architect` (each runs a
single-stage embedded advisory dispatch and lands no impactful action), plus the
gated **async advisory pipeline** `squad_run` and the `squad_status` poll utility.
`squad_run` is exposed but **safe by construction** — it returns a run id and holds
at the Human Gate, never auto-releasing; `squad_status` advances the run only after
an out-of-band approval.

## Where real (small) spend begins

| Stage | Resource | Spend |
| --- | --- | --- |
| Steps 0–2 | Entra app registration, OIDC federation, RBAC | **$0** (identity is free) |
| Step 3 | Azure OpenAI account + model deployment | **Real, usage-based** — billed per token at inference time |
| Step 5 | `az acr build` (image build + storage in ACR) | **Real, small** — ACR Tasks build minutes + image storage |
| Step 6 | ACA managed environment, Log Analytics, Key Vault | **Real, small** — Log Analytics ingestion + Key Vault ops; **ACA idle compute ≈ $0** thanks to `minReplicas: 0` (COST-3 / ARCH-2) |
| Step 7 | First `/mcp` calls | **Real** — AOAI inference per embedded run, bounded by the per-tenant monthly ceiling (COST-2) and concurrency cap (SEC-9 / COST-1) |

The `main.bicep` deployment also provisions a **monthly budget with 70 / 90 / 100%
alerts** (COST-2). Set `budgetAmountUsd` and `budgetAlertEmails` so you are notified
before spend grows. Leave `budgetStartDate` unset for the **first** deploy only —
it then means the first day of the current UTC month; every **later** deploy must
**pin** the date the budget was actually created with, or Azure rejects the update
(`Start date of budgets cannot be updated`). See
[host/infra/environments/README.md](infra/environments/README.md#budget-start-date)
for the full design and the resolver command CI runs before each what-if/deploy.

## Prerequisites

- An Azure subscription where you can create resource groups and assign roles
  (Owner or Contributor + User Access Administrator on the target resource group).
- Permission to **register an Entra application** and grant admin consent in your
  tenant.
- The Azure CLI (`az`) with the Bicep tooling (`az bicep install`).
- Access to **Microsoft Copilot Studio** in the same tenant, with permission to
  create custom connectors and enable generative orchestration.
- The built server in this package (`squad-mcp/`); the container image is built in
  ACR, so local Docker is **not** required.

**Automated path (recommended).** Steps 1 and 2 are now one-time, human-run Bicep
deployments — [host/infra/bootstrap/bootstrap.bicep](infra/bootstrap/bootstrap.bicep)
and [host/infra/bootstrap/entra-app.bicep](infra/bootstrap/entra-app.bicep) — and
Steps 5–7 are automated by your CI/CD pipeline once it exists. Every step below
still documents the exact manual command sequence as a fallback. See Step 1 for
the bootstrap prerequisites, the U5 named-security-reviewer sign-off gate, and
mapping outputs to GitHub variables, and Step 2 for the separate Entra
Application Developer prerequisite.

Set these shell variables once (used throughout):

```bash
# Identity + placement
SUBSCRIPTION_ID="<SUBSCRIPTION_ID>"
TENANT_ID="<ENTRA_TENANT_ID>"
LOCATION="<AZURE_REGION>"            # e.g. eastus2
RESOURCE_GROUP="<RESOURCE_GROUP>"   # e.g. hve-squad-mcp-rg

# Container registry + image
ACR_NAME="<REGISTRY>"               # ACR name WITHOUT .azurecr.io
IMAGE="hve-squad-mcp:latest"

az login --tenant "$TENANT_ID"
az account set --subscription "$SUBSCRIPTION_ID"
az group create --name "$RESOURCE_GROUP" --location "$LOCATION"
```

## Step 1 — deploy identity (OIDC for CI, or local `az` for a manual run)

**Automated path.** [host/infra/bootstrap/bootstrap.bicep](infra/bootstrap/bootstrap.bicep)
is a one-time, **subscription-scoped** deployment an operator runs once per
environment — never from CI, and never folded into `main.bicep` (a pipeline
identity cannot grant itself the rights it runs with):

```bash
az deployment sub create \
  --location "$LOCATION" \
  --template-file host/infra/bootstrap/bootstrap.bicep \
  --parameters host/infra/bootstrap/bootstrap.local.bicepparam
```

Copy [host/infra/bootstrap/bootstrap.bicepparam](infra/bootstrap/bootstrap.bicepparam)
to an uncommitted `bootstrap.local.bicepparam` and fill in every `<PLACEHOLDER>`
(`.gitignore` already covers `host/infra/**/*.local.bicepparam`).

- **Prerequisites.** The operator needs subscription **Owner**, or **User Access
  Administrator + Contributor**, plus `roleDefinitions/write` on every
  assignable scope — including a registry or Azure OpenAI resource group in
  another subscription (AC-A14). The app resource group
  (`appResourceGroupName`) must already exist (`az group create`, above) unless
  you set `createAppResourceGroup = true` (the default `false` avoids an ARM
  resource-group `PUT` replacing an existing group's tags).
- **A dedicated identity resource group.** `identityResourceGroupName` holds
  ONLY the two CI identities below and grants them **no role of its own** (U1)
  — every grant instead targets the app resource group, the registry, or the
  Azure OpenAI account.
- **Two CI identities and their federated-credential subjects:**
  - `ciPlanIdentity` (read-only what-if identity) federates on
    `repo:<owner>/<repo>:pull_request` and
    `repo:<owner>/<repo>:ref:refs/heads/main`.
  - `ciDeployIdentity` (deploy identity) federates on
    `repo:<owner>/<repo>:environment:prod` (`githubDeployEnvironment`).
- **Three custom roles** it defines: `squad-ci-plan-reader` (`*/read` +
  `deployments/validate/action` + `deployments/whatIf/action` — no write, no
  delete, no `listKeys`/`listSecrets`), `squad-ci-cross-rg-deploy` (nested
  deployments only, cross-resource-group targets), and `squad-ci-acr-build`
  (exactly what `az acr build` needs — no `AcrPush`/`AcrPull` data actions).
- **ABAC-conditioned RBAC Administrator grants.** `ciDeployIdentity` gets
  `Contributor` plus `RBAC Administrator` at the app resource group, the latter
  restricted by an ABAC condition to exactly the five role-definition GUIDs
  `main.bicep`'s modules assign, `ServicePrincipal`-only, and excluding both CI
  identities themselves as a target principal. A cross-resource-group registry
  or Azure OpenAI account gets the same pattern, narrowed to the single
  relevant GUID (`AcrPull` or `Cognitive Services OpenAI User`).
- **The U5 gate — mandatory before the first live run.** A **named** human
  security reviewer — recorded by name and date in this repository's own
  change-management record, not merely "a security reviewer" — signs off on:
  the compiled ABAC condition strings
  (`host/infra/bootstrap/modules/abac.bicep`); the three custom role
  definitions; the dedicated-identity-resource-group isolation (U1); the rule
  that no UAMI in the app resource group holds a more privileged grant than
  this bootstrap creates (security C5); the U3 residual-risk re-confirmation
  (below Step 7); and `host/infra/bootstrap/entra-app.bicep` (Step 2) —
  **before** `bootstrap.bicep` or `entra-app.bicep` is ever applied against a
  real subscription/tenant. Record the reviewer's name and the sign-off date
  before proceeding.

  Part of that sign-off is running the **ABAC sandbox negative-test matrix** in
  [host/infra/tests/README.md](infra/tests/README.md) (the "What stays
  live-only" section) as `ciDeployIdentity` against a throwaway resource
  group — it proves the condition allows exactly the five intended roles for
  the app identity and denies everything else, including self-assignment.

- **Map the outputs to GitHub variables/secrets:**

  | `bootstrap.bicep` output | GitHub name |
  | --- | --- |
  | `ciPlanClientId` | the what-if job's `AZURE_CLIENT_ID` |
  | `ciDeployClientId` | the deploy job's `AZURE_CLIENT_ID` |
  | `tenantId` | `AZURE_TENANT_ID` |
  | `subscriptionId` | `AZURE_SUBSCRIPTION_ID` |

  (`ciPlanPrincipalId` / `ciDeployPrincipalId` are for the U5 audit/sandbox test
  only — the pipeline itself does not need them.)

**Manual fallback.** You can still deploy manually with your own `az login`
(above), or wire the reference GitHub Actions workflow
(`host/oidc/deploy-aca.workflow.yml`) with **workload-identity federation** so no
client secret is ever stored.

For the CI path, reuse the one-time OIDC wizard shipped under the `azure-scaffold`
skill rather than duplicating it:

- Template: `squad-src/.github/skills/azure-scaffold/Setup-AzureOidc.template.ps1`
- Copy it into your consumer repo as `scripts/Setup-AzureOidc.ps1` and run it once.

It creates the deploy app registration, the federated credential
(`repo:<owner>/<repo>:environment:prod`), the RBAC role assignments, and the
`AZURE_CLIENT_ID` / `AZURE_TENANT_ID` / `AZURE_SUBSCRIPTION_ID` GitHub secrets the
deploy workflow consumes. See [host/oidc/README.md](oidc/README.md) for the
ACA-specific notes.

> The **deploy** identity is separate from the **app's** managed identity created in
> Step 6. The app identity is what calls Azure OpenAI at runtime (Step 7).

## Step 2 — register the Entra app and expose the API (SEC-1 / SEC-2)

The server validates that every token's **audience** is bound to this resource
server (RFC 8707) and that each tool call carries the tool's required **scope**.

**Automated path.** [host/infra/bootstrap/entra-app.bicep](infra/bootstrap/entra-app.bicep)
provisions the app registration, its identifier URI, all eleven delegated
scopes, the `Squad.Operate` app role, and its service principal — as its
**own**, separate deployment (U2), applied by a human holding the Entra
**Application Developer** directory role (not `Application.ReadWrite.All`, and
not the same person who ran `bootstrap.bicep` in Step 1), who becomes the app's
owner:

```bash
az deployment group create \
  --resource-group "$RESOURCE_GROUP" \
  --template-file host/infra/bootstrap/entra-app.bicep \
  --parameters host/infra/bootstrap/entra-app.local.bicepparam
```

Copy [host/infra/bootstrap/entra-app.bicepparam](infra/bootstrap/entra-app.bicepparam)
to an uncommitted `entra-app.local.bicepparam` first. Apply this only after
Step 1's U5 named-reviewer sign-off is already recorded.

Notes on what it does and does not do:

- **The identifier URI** it sets is `api://<tenantId>/<uniqueName>` — a form
  valid under Entra's default policy that never self-references the app's own
  not-yet-assigned `appId`, so there is no separate "set the identifier URI
  after creation" pass; the template computes it in one deployment from your
  tenant id and a tenant-unique `uniqueName` you choose.
- **v2 tokens change the audience you configure.** `entra-app.bicep` sets
  `api.requestedAccessTokenVersion: 2`, and with v2 tokens the `aud` claim is
  the appId **GUID**, not the `api://…` identifier URI. Set `squad.audience`
  (`SQUAD_MCP_AUDIENCE`), `authClientId`, and `allowedAudiences` from the
  `tokenAudience` / `appId` outputs (the same GUID value), and `allowedIssuers`
  to the v2 issuer `https://login.microsoftonline.com/<ENTRA_TENANT_ID>/v2.0`
  (unchanged from the values in Step 4).
- **Adoption is new-app only.** A manually created app registration has no
  `uniqueName`, and Microsoft Graph cannot add one to it after the fact, so
  this template cannot adopt an existing manual registration. Migrating an
  already-deployed environment means running `entra-app.bicep` as a **new**
  app, repointing `squad.audience` / `authClientId` / `allowedAudiences` at its
  outputs, redeploying `main.bicep` (Step 6), and then retiring the old app
  registration.
- **Tenant admin consent stays manual regardless of automation.** The template
  declares every scope unconditionally and marks `Squad.Run`, `Squad.Federate`,
  `Squad.MemoryWrite`, and `Squad.Backlog` for admin-only consent, but granting
  that consent — and consenting to Copilot Studio's connector generally — is a
  tenant-admin action no template performs.

**Manual fallback.** Create one app registration to represent the MCP resource
server, by hand:

```bash
# 1. Create the app registration for the MCP resource server.
APP_ID=$(az ad app create --display-name "hve-squad MCP" --query appId -o tsv)

# 2. Set the Application ID URI — this is the token AUDIENCE the server enforces.
az ad app update --id "$APP_ID" --identifier-uris "api://$APP_ID"
```

Then **Expose an API → Add a scope** (Azure portal is the most reliable path for
delegated scopes) and add exactly the scopes the connector requests:

| Scope | Grants |
| --- | --- |
| `Squad.Research` | invoke `squad_research` |
| `Squad.Plan` | invoke `squad_plan` |
| `Squad.Review` | invoke `squad_review` |
| `Squad.Architect` | invoke `squad_architect` |
| `Squad.Run` | invoke `squad_run` and poll `squad_status` |
| `Squad.Federate` | invoke `squad_federate` (the federation meta layer) |

Add all six scopes — the generated connector requests every one of them. The
`Squad.Operate` app role is separate: it authorizes the out-of-band operator
approval route (`POST /admin/approve`) and is granted as an Entra **app role**, not
a delegated connector scope.

`Squad.Federate` is deliberately distinct from `Squad.Run`: authorization to run
one squad is not authorization to drive a whole federation. `squad_federate` is a
gated catch-all like `squad_run` — it is served only when
`SQUAD_MCP_REMOTE_PIPELINE_ENABLED=true`, holds at the Human Gate, and is released
by the same out-of-band `/admin/approve` route.

If you enable the optional deterministic render tool (below), also add a
`Squad.Render` delegated scope — it authorizes `squad_render_pptx` and is
least-privilege (a render grant does not imply research/plan/run).

If you enable the shared-state memory broker, add `Squad.Memory` (read) and
`Squad.MemoryWrite` (compare-and-swap write / batch flush). If you enable the
business tools, add `Squad.Business` (`squad_business_plan`) and `Squad.Backlog`
(`squad_backlog`). Every scope is fail-closed: a missing scope returns 403 with no
work performed.

Notes:

- The **audience** the server checks under this manual, v1-style flow is
  `api://$APP_ID`. `main.bicepparam` and `environments/prod.bicepparam` now
  **default** `squad.audience` to the bare client-id GUID — the v2 `aud` an
  `entra-app.bicep` app issues (see above) — so a manual v1-token app does
  **not** get the right audience for free: set
  `squad.audience: 'api://<APP_ID>'` (or `SQUAD_INFRA_AUDIENCE=api://<APP_ID>`)
  **explicitly**. Keep it consistent across the app registration,
  `main.bicepparam` / `environments/prod.bicepparam`, and the connector's
  `apiProperties.json`.
- The **JWKS / issuer** the server trusts are your tenant's:
  - JWKS: `https://login.microsoftonline.com/$TENANT_ID/discovery/v2.0/keys`
  - Issuer: `https://login.microsoftonline.com/$TENANT_ID/v2.0`
- If Copilot Studio's first-party connector needs pre-authorization, add it under
  **Expose an API → Authorized client applications**.

## Step 3 — provision Azure OpenAI (real spend begins) (SEC-3)

The embedded engine calls **one** operator-configured Azure OpenAI endpoint
(SEC-3: the endpoint is allow-listed and never taken from a caller).

**Automated path.** `main.bicep`'s `openAiMode` parameter selects how the
account is provisioned, and **defaults to `'existing'`** — point at an
already-provisioned account and change nothing else:

```bicep
param openAiMode = 'existing'   // default: no new resource, no new spend
```

Set `openAiMode = 'create'` to have Step 6's deployment provision the account
and its model deployment(s) itself, via
[host/infra/modules/openai.bicep](infra/modules/openai.bicep):

```bicep
param openAiMode = 'create'
param openAiAccountName = '<AOAI_RESOURCE>'   // required in create mode; also the custom subdomain
param openAiResourceGroupName = '<AOAI_RG>'   // defaults to this deployment's own resource group
param openAiLocation = '<AZURE_REGION>'       // defaults to `location`
param openAiSkuName = 'S0'
param openAiPublicNetworkAccess = 'Enabled'   // always set explicitly (S10)
param openAiDeployments = [
  { name: '<AOAI_DEPLOYMENT>', modelName: '<MODEL_NAME>', modelVersion: '<MODEL_VERSION>', modelFormat: 'OpenAI', skuName: 'GlobalStandard', capacity: 10 }
]
```

- **Indicative cost default (K1).** Each `openAiDeployments` entry defaults to
  SKU `GlobalStandard`, capacity `10` if you omit `skuName`/`capacity` — a
  starting point you should size to your own expected load, not a
  guaranteed-sufficient value. **The existing `budgetAmountUsd` /
  `budgetAlertEmails` ($500 default, Step 4) may not cover Azure OpenAI usage
  once `create` mode is enabled** — raise the budget or add a dedicated Azure
  OpenAI budget before enabling `create` mode for real.
- **The endpoint has no trailing slash and must already be in your allow-list.**
  `create` mode's effective endpoint is always
  `https://<openAiAccountName>.openai.azure.com` (no trailing slash). `main.bicep`
  asserts, with a named `fail()` guard, that this exact string already appears
  in `squad.allowedModelEndpoints` (the comma-split allow-list SEC-3 requires)
  before the deployment proceeds — a deployment with a missing or
  trailing-slash-mismatched entry fails immediately at deploy time instead of
  failing only when the container boots. Add the endpoint to
  `squad.allowedModelEndpoints` (Step 4) before you deploy.
- **`disableLocalAuth` is always on in create mode** — the account has no
  API-key auth path at all; the app identity's `Cognitive Services OpenAI User`
  role assignment (Step 7) is the only access path. `existing` mode never
  modifies the account, and no output in either mode ever exposes a key.

**Manual fallback (also how you provision the account the first time for
`existing` mode).** Create or reuse an AOAI resource and a chat deployment by
hand:

```bash
AOAI_NAME="<AOAI_RESOURCE>"         # e.g. hve-squad-aoai
AOAI_DEPLOYMENT="<AOAI_DEPLOYMENT>" # e.g. gpt-4o

az cognitiveservices account create \
  --name "$AOAI_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --location "$LOCATION" \
  --kind OpenAI \
  --sku S0 \
  --custom-domain "$AOAI_NAME"

az cognitiveservices account deployment create \
  --name "$AOAI_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --deployment-name "$AOAI_DEPLOYMENT" \
  --model-name "<MODEL_NAME>" \
  --model-version "<MODEL_VERSION>" \
  --model-format OpenAI \
  --sku-capacity 10 \
  --sku-name Standard
```

Record the endpoint — `https://$AOAI_NAME.openai.azure.com` — and the deployment
name; both go into `main.bicepparam`. Inference is billed per token from here on.

## Step 4 — fill in the deployment parameters

Edit [host/infra/main.bicepparam](infra/main.bicepparam) and replace every
`<PLACEHOLDER>`. Every value is **operator-controlled** and never caller-influenced:

```bicep
param containerImage = '<REGISTRY>.azurecr.io/hve-squad-mcp:latest'
param containerRegistryServer = '<REGISTRY>.azurecr.io'
param authClientId = '<ENTRA_CLIENT_ID>'      // the APP_ID from Step 2
param authOpenIdIssuer = 'https://login.microsoftonline.com/<ENTRA_TENANT_ID>/v2.0'

param squad = {
  audience: '<ENTRA_CLIENT_ID>'   // v2 aud = appId GUID (entra-app.bicep apps); legacy v1 apps keep 'api://<ENTRA_CLIENT_ID>'
  allowedOrigins: 'https://copilotstudio.microsoft.com'   // SEC-8: strict, never '*'
  allowedIssuers: 'https://login.microsoftonline.com/<ENTRA_TENANT_ID>/v2.0'
  allowedTenants: '<ENTRA_TENANT_ID>'
  jwksUri: 'https://login.microsoftonline.com/<ENTRA_TENANT_ID>/discovery/v2.0/keys'
  modelEndpoint: 'https://<AOAI_RESOURCE>.openai.azure.com'
  allowedModelEndpoints: 'https://<AOAI_RESOURCE>.openai.azure.com'  // SEC-3 allow-list
  modelDeployment: '<AOAI_DEPLOYMENT>'
  modelApiVersion: '2024-10-21'
  tenantConcurrency: 4      // SEC-9 / COST-1
  tenantCostCeilingUsd: 500 // COST-2 (hard per-tenant monthly ceiling)
}

param budgetAmountUsd = 500
// Leave budgetStartDate unset for the FIRST deployment only (defaults to the
// first day of the current UTC month). Azure rejects any change to an existing
// budget's start date, so every LATER deployment must pin the date it was
// created with (infra/environments/README.md#budget-start-date):
//   az resource show --ids <rg-id>/providers/Microsoft.Consumption/budgets/<namePrefix>-budget \
//     --query properties.timePeriod.startDate -o tsv    # e.g. 2026-07-01T00:00:00Z
// An environment first deployed from an earlier version of this file pins '2026-07-01'.
// param budgetStartDate = '<YYYY-MM>-01'
param budgetAlertEmails = [ '<ALERT_EMAIL>' ]
```

These map 1:1 to the server's environment contract (`SQUAD_MCP_AUDIENCE`,
`SQUAD_MCP_ALLOWED_ORIGINS`, `SQUAD_MCP_JWKS_URI`, `SQUAD_MCP_MODEL_ENDPOINT`, …);
the Container App sets them for you. No secret belongs in this file — the model
token comes from managed identity at runtime (SEC-10).

**All configuration lives in `.bicepparam` files.** `main.bicepparam` (this
file) is the manual/local deploy template — copy it to an uncommitted
`main.local.bicepparam` and fill in every `<PLACEHOLDER>`. Once Steps 5 and 6
are automated, your CI/CD pipeline instead deploys
[host/infra/environments/prod.bicepparam](infra/environments/prod.bicepparam),
which sets every value from `SQUAD_INFRA_*` environment variables — see
[host/infra/environments/README.md](infra/environments/README.md) for the full
64-variable contract, the GitHub-variable/secret mapping, and the budget
start-date resolver. Three flags and one resource id are new in this revision
and worth considering explicitly (in either file) even if you leave them at
their defaults:

```bicep
// param containerRegistryResourceId = '/subscriptions/<SUB_ID>/resourceGroups/<ACR_RG>/providers/Microsoft.ContainerRegistry/registries/<REGISTRY>'
param manageAcrPullAssignment = false      // see Step 5 and the migration note under Step 7
param manageOpenAiRoleAssignment = false   // see Step 7 and its migration note
param openAiMode = 'existing'              // see Step 3
```

`containerRegistryResourceId` is required only when `manageAcrPullAssignment`
is `true`. Both `manage*` flags default `false` so an already-deployed
environment sees no new (and potentially conflicting) role assignment; a
brand-new environment can set both `true` from its first deploy. If you are
switching either flag from `false` to `true` on an environment that already has
the matching role assignment created out of band, follow the migration under
Step 7 first.

**Secrets never belong in this file.** `runEncryptionKeyBase64` (used only when
`enableRemotePipeline`/`enableWorker` is on, to AES-256-GCM encrypt request/run
state at rest) is passed only from a secret — either
`--parameters runEncryptionKeyBase64="$SECRET_VALUE"` on the CLI/CI, or
`readEnvironmentVariable('SQUAD_INFRA_RUN_ENCRYPTION_KEY_B64', '')` in an
uncommitted `*.local.bicepparam` or in `environments/prod.bicepparam`. CI
supplies it from the GitHub **secret** `RUN_ENCRYPTION_KEY` (`prod`-environment-scoped),
exposed to Bicep only as the env var `SQUAD_INFRA_RUN_ENCRYPTION_KEY_B64` — the
only secret in the `environments/README.md` contract; every other
`SQUAD_INFRA_*` value is a GitHub **variable**. `main.bicep` rejects, with a
named `fail()`, any non-empty value that is not exactly the base64 encoding of
32 bytes (44 characters), and never echoes the value in the failure message.
`.gitignore` covers `host/infra/**/*.local.bicepparam` — use that suffix for
any parameter file that ever holds a real secret or tenant-specific value,
including `bootstrap.local.bicepparam` (Step 1) and `entra-app.local.bicepparam`
(Step 2).

## Step 5 — build the image in ACR (real, small spend)

**Automated path.** Once `cicd`'s pipeline exists, this step runs automatically
as `ciDeployIdentity`, which holds the `squad-ci-acr-build` custom role
(`host/infra/bootstrap/bootstrap.bicep`, Step 1) at the registry — scoped to
exactly what `az acr build` needs (`registries/read`,
`listBuildSourceUploadUrl/action`, `scheduleRun/action`, `runs/read`,
`runs/listLogSasUrl/action`) and, deliberately, **no `AcrPush`** — the role
that would authorize the wrong action set for this command. The command it
runs is the one below.

**Manual fallback / what the pipeline runs:**

```bash
az acr build \
  --registry "$ACR_NAME" \
  --image "$IMAGE" \
  --file squad-mcp/host/Containerfile \
  squad-mcp
```

This builds and pushes `$ACR_NAME.azurecr.io/$IMAGE`. The multi-stage build runs
`npm run build` and ships only `dist/`, `tools.catalog.yml`, and `generated/`; no
secret is baked into the image (SEC-10).

## Step 6 — deploy the Container App + Key Vault + managed identity (real, small spend)

`host/infra/main.bicep` is now a **slim orchestrator**: it calls one Bicep
module per resource under [host/infra/modules/](infra/modules/)
(log-analytics, managed-identity, key-vault, container-apps-environment,
container-app, storage-account, worker-job, container-registry-access, openai,
openai-role-assignment, budget), and every environment-specific value lives in
`main.bicepparam` (manual, Step 4) or
[host/infra/environments/prod.bicepparam](infra/environments/prod.bicepparam)
via `SQUAD_INFRA_*` env vars (CI). The deployment command itself is unchanged,
made explicit here:

```bash
az deployment group create \
  --resource-group "$RESOURCE_GROUP" \
  --name main \
  --mode Incremental \
  --template-file squad-mcp/host/infra/main.bicep \
  --parameters squad-mcp/host/infra/main.bicepparam \
  --parameters containerImage="$ACR_NAME.azurecr.io/$IMAGE" \
  --parameters containerRegistryServer="$ACR_NAME.azurecr.io"
```

**Always `--mode Incremental`, never `--mode Complete`** — `Complete` mode
deletes any resource in the resource group that is not declared in the
template, which this deployment never wants.

**Automated path.** Once `cicd`'s pipeline exists, it runs this same shape of
command as `ciDeployIdentity` in the `prod` GitHub Environment — but with
`--parameters host/infra/environments/prod.bicepparam` in place of
`main.bicepparam`, every value coming from `SQUAD_INFRA_*` variables (see
[host/infra/environments/README.md](infra/environments/README.md)) —
automatically, after a required reviewer approves deploying the reviewed
commit SHA. Before each what-if/deploy it resolves
`SQUAD_INFRA_BUDGET_START_DATE` from the existing budget (empty on the very
first run) and runs the placeholder preflight —
`az bicep build-params --file host/infra/environments/prod.bicepparam`
(without the secret set) piped into
`node host/infra/tests/check-no-placeholders.mjs` — so a leftover
`<PLACEHOLDER>` fails the job before any Azure call. You do not need to run any
of this by hand. Before enabling that deploy job for any environment, run
local validation once: `node host/infra/tests/validate.mjs` (needs Azure CLI
with Bicep, Node ≥ 20, git, and tar; local and credential-free — see
[host/infra/tests/README.md](infra/tests/README.md)).

> **Mandatory live what-if gate.** Before enabling any environment's automated
> deploy job, run one **live** `what-if` against a real subscription, as
> `ciPlanIdentity`, with `--validation-level ProviderNoRbac`:
>
> ```bash
> az deployment group what-if \
>   --resource-group "$RESOURCE_GROUP" \
>   --template-file host/infra/main.bicep \
>   --parameters host/infra/main.bicepparam \
>   --parameters containerImage="<ci-built-tag>" containerRegistryServer="<registry>.azurecr.io" \
>   --validation-level ProviderNoRbac
> ```
>
> For a `cicd`-managed environment, replace
> `--parameters host/infra/main.bicepparam --parameters containerImage=… containerRegistryServer=…`
> with `--parameters host/infra/environments/prod.bicepparam`, with every
> `SQUAD_INFRA_*` variable already exported in the job's environment (Step 4 /
> `infra/environments/README.md`).
>
> **Pass bar: zero `Delete`, `Replace`, or `Unsupported` changes.** This is a
> hard prerequisite recorded once per environment/fixture shape before the
> deploy job is turned on — this RUNBOOK does not run it for you, and
> `main.bicep` cannot prove it locally; `cicd`'s pipeline runs it as its own
> gated job (see "The `prod` GitHub Environment gate" below Step 7).

If the very first deployment's Container App fails its first image pull (RBAC
propagation lag between the `AcrPull` grant and the pull), **retry the
deployment once** — `az deployment group show --name main` still works to
inspect the failed run first.

`main.bicep` provisions, in one resource-group-scoped deployment:

- the **ACA managed environment** + the **scale-to-zero app** (`minReplicas: 0`,
  HTTPS-only ingress on port 3000; COST-3 / ARCH-2 / SEC-8);
- a **user-assigned managed identity** + a **Key Vault** with an RBAC role
  assignment so the app identity can read secrets (SEC-10);
- **ACA built-in Entra auth** in front of the app's own audience-bound validation
  (defense-in-depth; SEC-1); and
- a **monthly budget** with 70 / 90 / 100% alerts (COST-2).

Capture the outputs:

```bash
az deployment group show \
  --resource-group "$RESOURCE_GROUP" \
  --name main \
  --query "properties.outputs.{fqdn:mcpFqdn.value, principal:appPrincipalId.value, kv:keyVaultName.value}"
```

- `mcpFqdn` — the HTTPS FQDN of your `/mcp` endpoint.
- `appPrincipalId` — the app managed-identity principal id (used in Step 7).
- `keyVaultName` — the Key Vault for any operator secrets.

## Step 7 — grant the app identity access to Azure OpenAI (SEC-3 / SEC-10)

The embedded backend authenticates to AOAI with the app's **managed identity** —
no key in code or image.

**Automated path.** Set `manageOpenAiRoleAssignment = true` in
`main.bicepparam` (Step 4) and Step 6's deployment grants
`Cognitive Services OpenAI User` to the app identity itself, via
[host/infra/modules/openai-role-assignment.bicep](infra/modules/openai-role-assignment.bicep) —
in both `openAiMode` values, including when the account lives in a different
resource group than the app (`openAiResourceGroupName`). The same pattern
(`manageAcrPullAssignment`, Step 5's `AcrPull` grant, via
[host/infra/modules/container-registry-access.bicep](infra/modules/container-registry-access.bicep))
applies to the registry grant. Both flags default `false`.

**Migrating an already-deployed environment (U4).** If you already granted
`AcrPull` and/or `Cognitive Services OpenAI User` to the app identity out of
band, flipping either flag straight to `true` fails the deployment
(`RoleAssignmentExists`, 409) — `main.bicep` names its managed assignment
deterministically and your manual one has a different name. Do this instead,
in one maintenance window (there is a brief cold-start outage risk across the
redeploy):

1. Run [host/infra/tests/Test-RoleAssignmentPreFlip.ps1](infra/tests/Test-RoleAssignmentPreFlip.ps1)
   (read-only; it only calls `az role assignment list`):

   ```powershell
   ./host/infra/tests/Test-RoleAssignmentPreFlip.ps1 `
     -AppPrincipalId "<appPrincipalId from Step 6>" `
     -ContainerRegistryResourceId "<containerRegistryResourceId>" `
     -OpenAiAccountResourceId "<AOAI_RESOURCE_ID>"
   ```

2. **Delete** every manually created `AcrPull` / `Cognitive Services OpenAI
   User` assignment it lists (`az role assignment delete --ids <id>`).
3. Re-run the script until it reports none outstanding.
4. Flip `manageAcrPullAssignment` and/or `manageOpenAiRoleAssignment` to `true`
   in that environment's `.bicepparam`.
5. Redeploy (Step 6).

A **brand-new** environment sets both flags `true` from its very first deploy
and needs no migration step.

**Manual fallback:**

```bash
APP_PRINCIPAL_ID="<appPrincipalId from Step 6>"
AOAI_RESOURCE_ID=$(az cognitiveservices account show \
  --name "$AOAI_NAME" --resource-group "$RESOURCE_GROUP" --query id -o tsv)

az role assignment create \
  --assignee "$APP_PRINCIPAL_ID" \
  --role "Cognitive Services OpenAI User" \
  --scope "$AOAI_RESOURCE_ID"
```

Smoke-test the endpoint (auth + handshake). `initialize` does not require a scope;
a `tools/call` does (Step 8 validates that end to end through Copilot Studio):

```bash
# The --resource value must be an identifier URI Entra recognizes for this app:
# api://<ENTRA_TENANT_ID>/<uniqueName> for an entra-app.bicep app (Step 2) — the
# `aud` in the resulting v2 token is still the appId GUID, not this URI — or
# api://<ENTRA_CLIENT_ID> for a legacy manual (v1) app, shown below. The bare
# appId GUID (--resource "<ENTRA_CLIENT_ID>", no "api://" prefix) is ALSO a
# valid --resource value for a v2 app and resolves to the identical `aud` —
# cicd's own smoke check (infra-deploy.yml) uses this bare-GUID form via
# SQUAD_INFRA_ENTRA_CLIENT_ID. Use a client that requests the Squad.Research
# scope for a real tools/call; initialize only needs a valid token.
TOKEN=$(az account get-access-token --resource "api://<ENTRA_CLIENT_ID>" --query accessToken -o tsv)

curl -sS "https://<mcpFqdn>/mcp" \
  -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Origin: https://copilotstudio.microsoft.com" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
```

A successful response returns `serverInfo.name = hve-squad-mcp` and an
`Mcp-Session-Id` header. A `401` means the token audience/issuer is not accepted;
a `403 origin_not_allowed` means the `Origin` is not on the allow-list.

### The `prod` GitHub Environment gate and the accepted residual risk (U3)

Before `cicd`'s deploy job (Step 6) is enabled for any environment, the `prod`
GitHub Environment must have, as a checkable prerequisite rather than a
suggestion:

- **required reviewers** configured;
- **prevent self-review** enabled;
- a **deployment branch policy restricted to `main` only**; and
- **no admin bypass**.

The deploy job must deploy the **exact commit SHA** that was reviewed and
approved — not a re-checkout of `main` at approval time. `ciDeployIdentity`'s
federated-credential subject (`repo:<owner>/<repo>:environment:prod`, Step 1)
only issues a token inside that Environment, so these settings are what make
the approval gate real, not merely advisory.

**Accepted residual risk (U3 — corrected and re-confirmed 2026-09-28T00:44+02:00).**
`ciDeployIdentity`'s `Contributor` grant at the app resource group (Step 1)
still permits it to add a federated-credential subject to the app's own
managed identity — a self-escalation path narrower than, but not eliminated
by, the ABAC condition on its `RBAC Administrator` grant:

> Contributor on the app RG gives full control of that RG's data and identities
> (FIC write, identity assign/action, containerApps listSecrets, storage and
> Log Analytics listKeys, redeploying the image as the app identity). The
> blast radius is KV secrets, storage data, AOAI, and the app identity's Graph
> Sites.Selected write. The prod environment gate (required reviewers, prevent
> self-review, main-only, no admin bypass) is the primary control. The later
> custom deploy role only partly reduces the risk.

This risk is **accepted and tracked**, not fixed, in this revision. The
**`prod` environment gate above is the primary control**; a future
`Contributor`-minus-`federatedIdentityCredentials/write` custom deploy role is
a tracked Follow-Up, not implemented here.

### The CI/CD pipeline (`cicd`)

Steps 5–6 above are now automated by two workflow files. `.github/workflows/infra-validate.yml`
("Infra validate") lints, `build-params`-checks, and contract-diffs `host/infra/**`
credential-free on every PR/push touching a deploy-affecting path, then runs a
scoped `what-if` as `ciPlanIdentity`. `.github/workflows/infra-deploy.yml`
("Infra deploy") triggers only from `infra-validate`'s success on a same-repository
push to `main`, or an operator's `workflow_dispatch` — its first job, `resolve`,
holds no Azure credential at all and independently re-verifies the proposed
commit SHA (a 40-hex-character shape, a real commit object, and
`git merge-base --is-ancestor <sha> origin/main`) before any later job ever
requests a token, closing the fork/`workflow_run` privilege-escalation path a
naive `workflow_run` trigger would otherwise leave open. A pre-approval
`what-if` then re-runs for that exact verified SHA, a required reviewer
approves the `prod` GitHub Environment, `build` produces a digest-pinned
image, and `deploy` re-verifies the identical diff signature immediately
before `az deployment group create` — so approving a diff always means
approving the diff that is actually applied.

#### Variable/secret inventory

Every `SQUAD_INFRA_*` name from
[`infra/environments/README.md`](infra/environments/README.md)'s env-var
contract maps to exactly one GitHub scope below. `.github/scripts/export-infra-vars.mjs`
reads the whole `vars` context as one JSON blob and forwards only the
non-empty `SQUAD_INFRA_*` names to the job's environment — an unset optional
variable never becomes an empty-string override of its `main.bicep` default.

| Scope | Name(s) |
| --- | --- |
| **Repo-level GitHub variable** | Every `SQUAD_INFRA_*` name in the contract table below EXCEPT the three "computed at runtime" rows — including `SQUAD_INFRA_CONTAINER_REGISTRY_SERVER`, `SQUAD_INFRA_CONTAINER_REGISTRY_RESOURCE_ID`, and every optional flag/default. Repo-level (not `prod`-environment-level) because the `what-if` jobs declare no `environment:` key and must still read the identical values `deploy` reads. |
| **Repo-level GitHub variable (pipeline infrastructure, outside the `SQUAD_INFRA_*` namespace)** | `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `RESOURCE_GROUP`, `CI_PLAN_CLIENT_ID` (from `bootstrap.bicep`'s `ciPlanClientId` output), `CONTAINER_REGISTRY_NAME`, `INFRA_DEPLOY_ENABLED` (the kill switch — see below) |
| **`prod`-environment-level GitHub variable** | `AZURE_CLIENT_ID` (from `bootstrap.bicep`'s `ciDeployClientId` output — `ciDeployIdentity`'s client id; read only by `build`/`deploy`) |
| **The one GitHub secret** (`prod`-environment-scoped) | `RUN_ENCRYPTION_KEY` — mapped to `SQUAD_INFRA_RUN_ENCRYPTION_KEY_B64` **only** in `deploy`'s step-level `env:`. Every `what-if` job (in both workflows) instead uses a fixed, non-secret 44-character placeholder whenever `SQUAD_INFRA_ENABLE_REMOTE_PIPELINE` resolves `true`, so the predicted diff's shape matches what `deploy` will actually apply without ever exposing the real key to a job with no `environment: prod`. This is the ONLY secret name used anywhere in this pipeline — the same name everywhere it appears. |
| **Computed at runtime — never a static GitHub value** | `SQUAD_INFRA_CONTAINER_IMAGE` (a placeholder digest in `what-if` jobs; `build`'s own captured digest in `deploy`), `SQUAD_INFRA_BUDGET_START_DATE` (a fresh `az resource show` read-only lookup before every what-if/deploy, per "Budget start date" above), `SQUAD_INFRA_RUN_ENCRYPTION_KEY_B64` (above) |

#### Placeholder preflight and the mandatory live what-if

Every what-if/deploy job runs the placeholder preflight
(`az bicep build-params` on a key-less `prod.bicepparam`, then
`node host/infra/tests/check-no-placeholders.mjs`) before its `az deployment
group what-if`/`create` step. The **mandatory first live what-if** callout
above this subsection still applies unchanged: it must pass (zero
`Delete`/`Replace`/`Unsupported`) before `INFRA_DEPLOY_ENABLED` is ever set.

#### Enabling the pipeline: the `INFRA_DEPLOY_ENABLED` kill switch

`vars.INFRA_DEPLOY_ENABLED` gates `infra-deploy.yml`'s `build` and `deploy`
jobs (never `what-if`, which must always be runnable so an operator can
produce the evidence below). It defaults **unset** (falsy) in every clone —
flip it to the literal string `'true'` only after recording, in this
repository's own change-management record:

1. The **run URL** of the first clean (zero `Delete`/`Replace`/`Unsupported`)
   live `what-if` against the real subscription.
2. The **named U5 security reviewer's name and date** confirming that what-if
   output (security C11) — the same named-reviewer discipline as Step 1's U5
   gate above, applied here to the pipeline's own first real run.

_Record here once available: `<run URL>` — reviewed by `<name>` on `<date>`._

After the first production deploy that sets `SQUAD_INFRA_RUN_ENCRYPTION_KEY_B64`,
an operator manually verifies (outside the pipeline) that the key's value does
not appear in the deployment's Azure Activity Log / deployment-history
`properties.parameters` — `az deployment group create --parameters
prod.bicepparam` keeps a `securestring` parameter out of that history by ARM's
own contract, but this human confirmation is required on the first real run
rather than trusting the contract alone (security C5).

#### Operator setup: the `prod` GitHub Environment

Run [`.github/scripts/setup-prod-environment.sh`](../.github/scripts/setup-prod-environment.sh)
once (idempotent; safe to re-run) to create/verify the `prod` Environment's
required reviewers (at least one team, or at least two users),
prevent-self-review, and its `main`-only custom deployment branch policy. It
needs a `gh` session with `repo` admin / `Administration: write` on this
repository, and never touches `INFRA_DEPLOY_ENABLED` or any secret. It also
prints a reminder that "Allow administrators to bypass configured protection
rules" has no REST API field as of GitHub API version 2022-11-28 — confirm
that checkbox is **unchecked** by hand in Settings → Environments → `prod`.
Also enable **"Require approval for all external contributors"** in the
repository's Actions settings, so a first-time contributor's workflow run
needs a maintainer's approval before it executes at all.

#### Redeploy / rollback

A `workflow_dispatch` redeploy or rollback to an already-merged, older commit
passes through the **identical** `resolve` verification as any other run —
the SHA must still be a real, ancestor-of-`main` commit; there is no second,
weaker path. `build` checks `az acr task list-runs` for an existing successful
build tagged with that SHA and reuses its digest instead of rebuilding when
found. A rollback still re-applies that commit's **Bicep** with
`--mode Incremental`, not only its image — the digest-reuse shortcut applies
to the image build step alone.

#### Approval-prompt count

`build` and `deploy` both declare `environment: prod`. Because `deploy` only
becomes eligible for the `prod` Environment's review queue after `build` has
already completed (`needs: build`), **expect two separate approval prompts
per deploy run** (one for `build`, one for `deploy`), not one combined prompt
— GitHub batches multiple pending jobs against the same environment only when
they are queued at the same time, which `build` and `deploy` never are.
_Record the actually observed count here after the first real run:_ `<count>`.

#### Required-status-check caveat

`infra-validate.yml`/`infra-deploy.yml` are both path-filtered. If either is
ever configured as a required branch-protection status check, a change that
touches no filtered path leaves that PR's check permanently pending — GitHub
does not run a path-filtered workflow at all for such a change, so it never
reports a passing (or any) status. This RUNBOOK documents the caveat; whether
either workflow is configured as a required check is a separate repository
settings decision, and no "always-running fallback/gatekeeper" job is
implemented here.

#### Recurring CI cost (indicative)

Alongside the existing budget/K1 callouts: **ACR Tasks build minutes** (one
`az acr build` per deploy that is not a digest-reuse redeploy) and **Log
Analytics ingestion** from the workflow runs' own step summaries and any
Container Apps logs the smoke check triggers. Both are small relative to the
Azure OpenAI/Container Apps spend already documented above; get exact figures
from the Azure pricing calculator once a real SKU/region is chosen, matching
the existing K1 pattern — this callout is indicative only.

## Step 8 — import the connector into Copilot Studio (PROD-1)

The connector files are generated under
`generated/copilot-studio-connector/` (regenerate with
`npm run generate:connector`; do not edit by hand).

1. In `apiDefinition.swagger.json` and `apiProperties.json`, replace:
   - `<SQUAD_MCP_HOST>` → your `mcpFqdn` from Step 6 (host only, no scheme),
   - `<ENTRA_TENANT_ID>` → your tenant id,
   - `<ENTRA_CLIENT_ID>` → the `APP_ID` from Step 2 (always the OAuth client
     id, regardless of app type),
   - `<SQUAD_MCP_AUDIENCE>` → the connector's `AzureActiveDirectoryResourceId`
     / token **resource** — *not* always the same as the token's `aud` claim:
     for an `entra-app.bicep` app use its `identifierUri` output
     (`api://<ENTRA_TENANT_ID>/<uniqueName>`); for a legacy manual (v1) app use
     `api://<ENTRA_CLIENT_ID>`.
2. In **Copilot Studio**, add a **custom connector** from the OpenAPI file (or use
   the MCP onboarding wizard). The connector advertises the
   `x-ms-agentic-protocol: mcp-streamable-1.0` `/mcp` operation and the four
   remotely-exposed tools (`squad_research`, `squad_review`, `squad_run`,
   `squad_status`).
3. Complete the **Entra OAuth 2.0** connection, consenting to the `Squad.Research`,
   `Squad.Review`, and `Squad.Run` scopes from Step 2.
4. **Enable generative orchestration** on the agent so it can call the MCP tools.
5. Test the synchronous path: ask the agent to "research X with the squad". The
   call should reach `/mcp`, the server runs the hero tool server-side under its
   gates, and returns a `squad-guided / embedded` artifact.
6. Test the async pipeline: ask the agent to "run the full squad on X". `squad_run`
   returns a **run id** and pauses at the Human Gate; after an out-of-band
   operator approval (below), a `squad_status` poll with that run id advances the
   run and returns the finished artifact. The gate never auto-releases across the
   remote boundary.

### Releasing a held run (operator action)

A held `squad_run` is released ONLY by an operator, out-of-band, through the admin
route — never by the caller or the model (SEC-6):

- Grant the human/service operator the distinct **`Squad.Operate`** app role (NOT
  `Squad.Run`). Only this role may approve; a caller that can start or poll a run
  cannot release one.
- Release a run with an authenticated `POST /admin/approve`:

  ```bash
  curl -sS -X POST "https://$FQDN/admin/approve" \
    -H "Authorization: Bearer $OPERATOR_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"runId":"<run-id-from-squad_run>"}'
  # 200 {"approved":true,"runId":"...","approver":"<operator>","at":<epoch-ms>}
  ```

  The release is **tenant-scoped** (an operator can release only runs in their own
  tenant; a cross-tenant or unknown run id returns 404 with no leakage) and
  **auditable** (approver + timestamp are recorded and emitted to the scrubbed
  audit log). The route is served only when the pipeline is enabled
  (`SQUAD_MCP_REMOTE_PIPELINE_ENABLED=true`); otherwise it returns 404. It is NOT
  an MCP tool and is not advertised in the connector.

### Enabling the pipeline: single-replica vs multi-replica + worker

The async pipeline has two run-state backends, selected by `SQUAD_MCP_RUN_STATE_BACKEND`:

- **`file`** (default) — a local directory (`SQUAD_MCP_RUN_STATE_DIR`). Durable across
  restarts but **single-replica**: an approval recorded on one replica is not visible
  to others. Keep `minReplicas`/`maxReplicas` at 1 for this backend.
- **`table`** — **Azure Table Storage**, the cross-replica backend (WI-06). Run records
  are partitioned by tenant; a held→running transition uses an ETag `If-Match`
  compare-and-swap, so exactly one replica drives a run. Approval is stored ON the run
  record, so `POST /admin/approve` on any replica releases the run for all. This is the
  backend for a **multi-replica / scale-to-zero** deployment.

Deploy the pipeline (Table backend) with the IaC parameters:

```bicep
enableRemotePipeline: true          // creates the Storage account + table + RBAC, sets SQUAD_MCP_* env
enableWorker: true                  // deploys the worker ACA Job (below)
runEncryptionKeyBase64: '<base64 32-byte key>'  // optional: AES-256-GCM encrypt request/context at rest (MEDIUM-3)
```

The app's managed identity is granted **Storage Table Data Contributor** on the account;
no connection string or key is used (managed identity only, SEC-10).

**Long runs (>240s) — the worker.** The Azure Container Apps HTTP ingress hard-caps a
request at 240s, so a minutes-long pipeline cannot ride one `squad_status` poll. With
`SQUAD_MCP_WORKER_ENABLED=true` (which requires the `table` backend) the status poll
becomes **read-only** and a scheduled **worker ACA Job** (`<prefix>-worker`, default every
5 minutes) drains approved runs off the request path. The worker shares the app image
(`node dist/src/worker-main.js`), the same managed identity, and the same Table store; it
only ever picks up runs the store reports claimable (an approved held run, or a `running`
run whose lease lapsed) and CAS-claims each first, so the gate stays non-bypassable and two
workers never double-execute a run.

### Optional: the deterministic PowerPoint render tool (`squad_render_pptx`)

`squad_render_pptx` is a deterministic FILE-OUTPUT tool: it renders caller-supplied
deck content YAML to a `.pptx` with `python-pptx` and returns a short-lived
**download link**. It is OFF by default and independent of the async pipeline.

Enable it by setting `enableRenderPptx=true` in `main.bicep`. That provisions (behind
the flag) a **private Blob container** (`renders`, public access disabled) on the same
Storage account and grants the app identity **Storage Blob Data Contributor** — the role
that also allows minting a **user-delegation SAS** (`generateUserDelegationKey/action`).
The Storage account deploys when EITHER the async pipeline OR render is enabled.

How it works and what is safe by construction:

- The container image installs Python 3.11 + `python-pptx` (build-only; no LibreOffice
  or poppler — those back the export/validate actions the tool never runs). The build
  scripts are snapshotted into the image by `npm run snapshot:render`.
- The caller sends `contentYaml` (a document with a top-level `slides:` array) and
  `styleYaml`. The server renders in a **bounded ephemeral workspace** that is always
  cleaned up, writes only data files (never an executable `content-extra.py`), and never
  passes `--allow-scripts` — so caller YAML is DATA, never code (SEC-5).
- The deck is uploaded to `renders/<tenantId>/<uuid>/deck.pptx` (tenant-scoped,
  non-guessable) and the caller receives a **user-delegation SAS** link that expires in
  `renderSasTtlMinutes` (default 60). The SAS is a read-only, per-blob capability; it is
  registered as a secret and **never logged** (SEC-10).
- Grant callers the least-privilege **`Squad.Render`** scope. Missing the scope fails
  closed (403, no render work).

Optional branding: set `renderBrandTemplatePath` to a `.pptx` baked into the image to
brand every deck; absent, the render uses the skill default look and says so in the result.

### Optional: automatic squad memory (`SQUAD_MCP_MEMORY_AUTO_ENABLED`)

The memory broker (`SQUAD_MCP_ENABLE_MEMORY=true`, `enableMemory=true` in
`main.bicepparam`) exposes memory as tools the agent must choose to call. Under
Copilot Studio's generative orchestration that is unreliable: the agent may skip the
call, and it invents a different `project` name each session, so continuity silently
disappears.

Set `SQUAD_MCP_MEMORY_AUTO_ENABLED=true` (`enableMemoryAuto=true` in
`main.bicepparam`) to make continuity a SERVER behavior instead:

- before each embedded dispatch the server reads the resolved project's `state` and
  `decisions` and injects them as **delimited DATA** — never authority, so memory can
  never act as instructions (SEC-5);
- after a completed dispatch it writes the artifact to `history/<toolId>-<runId>` and
  appends a digest line to `state` under compare-and-swap with a bounded retry.

The partition is derived from a pinned federation sub-squad, else
`SQUAD_MCP_MEMORY_DEFAULT_PROJECT` (default `default`, lower-kebab-case). It is never
taken from caller free text. Requires `SQUAD_MCP_ENABLE_MEMORY=true`; boot fails fast
otherwise. When this is on, tell your Copilot Studio agent **not** to call the memory
tools (remove the memory section from the generated agent instructions).

### Optional: persist the squad ledger (`SQUAD_MCP_ENABLE_ARTIFACTS`)

Auto-memory keeps three flat keys. That is continuity between two turns and nothing
an operator can audit — you cannot open the PRD a run produced, or see which agent
wrote what.

Set `enableArtifacts=true` in `main.bicepparam` (requires `enableMemory` and
`enableMemoryAuto`) and a run additionally writes a browsable `.copilot-tracking`
tree:

- `squad/team.md`, `squad/routing.md`, `squad/state.json` seeded on first use;
- `squad/decisions.md` and `squad/notifications.md`, append-only;
- `squad/history/<agent>.md` per agent and `squad/history/autopilot-run-<id>.md`
  per run, each carrying a measured `#### Consumption` block;
- `squad/consumption.md`, rebuilt from those blocks so earlier turns are never
  dropped;
- each role's deliverable under its roster Deliverable Root — `research/<date>/`,
  `plans/`, `reviews/`, `ppt/<date>/<slug>/`, `docs/`, `outputs/`.

It writes through the store `memoryBackend` already selected, so the destination is
chosen once: `table` for Azure Table, `graph` for a SharePoint library your users can
open directly, `file` for a single replica. The `squad_history` tool reads the tree
back (`op=index` to summarize, `op=list` to enumerate, `op=read` to open one file),
and the run index is injected into each new run as DATA so a follow-up turn resumes
from what the project already holds.

### Optional: let advisory runs proceed unattended (`SQUAD_MCP_ADVISORY_AUTOPILOT_ENABLED`)

`squad_run` holds for an out-of-band approval at `/admin/approve`. A Copilot Studio
agent cannot reach that endpoint, so without this setting every `product` run holds
forever waiting for a human who is not in that loop.

Set `enableAdvisoryAutopilot=true` (requires `enableRemotePipeline`) and the server
releases the hold **only** for a run it has itself determined to be advisory-only —
one whose seeded roster produces text into the tracking tree and touches nothing
else. It is a narrowing of the gate, not an override:

- a run flagged destructive still holds;
- any roster seeding `backlog-executor`, `deployer`, `iac-author` or
  `azure-diagnose` still holds, so `azure`, `operations` and `full` are unaffected;
- `mode=autopilot` alone still releases nothing;
- the determination comes from the server-resolved roster, never from `request`,
  `context`, or model output.

Leave it off if you want every pipeline run reviewed by an operator first.

### Optional: persist memory to SharePoint or OneDrive (`SQUAD_MCP_MEMORY_BACKEND=graph`)

Set `enableMemory=true` and `memoryBackend='graph'` in `main.bicepparam`, plus
`memoryGraphDriveId`. The template projects these environment variables:

| Variable | `main.bicep` parameter | Meaning |
| --- | --- | --- |
| `SQUAD_MCP_MEMORY_BACKEND=graph` | `memoryBackend` | Persist memory through Microsoft Graph instead of Azure Table / local disk. |
| `SQUAD_MCP_MEMORY_GRAPH_DRIVE_ID` | `memoryGraphDriveId` | The target document library's drive id (or a OneDrive drive). Required. |
| `SQUAD_MCP_MEMORY_GRAPH_ROOT_PATH` | `memoryGraphRootPath` | Folder within the drive that roots squad memory (empty = the drive root). |
| `SQUAD_MCP_MEMORY_GRAPH_ENDPOINT` | `memoryGraphEndpoint` | Override the Graph endpoint for a sovereign cloud. |
| `SQUAD_MCP_MEMORY_GRAPH_ENCRYPT` | `memoryGraphEncrypt` | `true` to field-encrypt content at rest. **Default false.** |

Each entry becomes one readable markdown file at
`<rootPath>/<tenantId>/<project>/<path>.md`, versioned by SharePoint and subject to
your existing retention, search, and DLP policy. Concurrency uses Graph's native
`eTag` with `If-Match`, so a stale write loses the race rather than clobbering.

Content is **plaintext by default** — the reason to target SharePoint is that a human
can open the file, and encrypting it defeats that. Opt into ciphertext only if your
policy requires it, and configure `runEncryptionKeyBase64` when you do.

The `tenantId` from the validated token is always the first path segment, so tenant
isolation is preserved regardless of destination.

#### Grant the app identity access to the library (`graph-memory-permissions.bicep`)

The app's managed identity needs a Microsoft Graph **application** permission on the
target drive. Deploy `host/infra/graph-memory-permissions.bicep`, which does both
halves idempotently:

1. assigns **`Sites.Selected`** to the identity — the least-privilege choice, which
   on its own grants access to **no** site and only makes the identity eligible;
2. grants that identity **write on exactly one site** (`POST /sites/{siteId}/permissions`),
   so the server can reach only the library you designated — not every site in the
   tenant.

This is a **separate deployment on purpose.** It requires
`AppRoleAssignment.ReadWrite.All` and `Sites.FullControl.All`, a far higher privilege
than deploying the Container App; keeping it apart means your routine app deploys never
need Graph admin rights. Both operations are Graph data-plane calls with no ARM resource
type, so they run in one deployment script authenticated as a **managed identity you
supply** — no credential is passed to or stored in the template, and re-running the
deployment is a no-op.

```bash
# 1. Resolve the site id (the hostname,siteCollectionId,siteId triple).
SITE_ID=$(az rest --method GET \
  --url "https://graph.microsoft.com/v1.0/sites/<TENANT>.sharepoint.com:/sites/<SITE_PATH>" \
  --query id --output tsv)

# 2. Resolve the drive id of the document library that will hold squad memory.
az rest --method GET \
  --url "https://graph.microsoft.com/v1.0/sites/$SITE_ID/drives" \
  --query "value[].{name:name,id:id}" --output table

# 3. Fill in graph-memory-permissions.bicepparam (appPrincipalId + appClientId come
#    from the main.bicep outputs) and deploy as an administrator.
az deployment group create \
  --resource-group "$RG" \
  --template-file host/infra/graph-memory-permissions.bicep \
  --parameters host/infra/graph-memory-permissions.bicepparam
```

Leave `sharePointSiteId` empty to assign `Sites.Selected` only. That is a deliberate
safe partial state: the identity is eligible but reaches nothing, so a half-finished
onboarding never silently exposes a library.


### Optional: offer several memory destinations (`SQUAD_MCP_MEMORY_TARGETS`)

To let a team choose where their agent saves, declare an allow-list:

```jsonc
// SQUAD_MCP_MEMORY_TARGETS
[
  { "name": "azure",      "backend": "table", "tableName": "squadmemory" },
  { "name": "sharepoint", "backend": "graph", "driveId": "<DRIVE_ID>", "rootPath": "squad-memory" }
]
```

with `SQUAD_MCP_MEMORY_DEFAULT_TARGET=azure` (`memoryTargets` / `memoryDefaultTarget`
in `main.bicepparam`). The memory tools then accept an optional `target` naming one of
these. **You** own every credential-bearing field; the caller only ever sees the opaque
name. An undeclared name is rejected before any I/O and never falls back to the
default. Declaring no targets keeps the single-destination behavior and the `target`
input is ignored.

### Optional: the business-user tools (`SQUAD_MCP_ENABLE_BUSINESS_TOOLS`)

Set `SQUAD_MCP_ENABLE_BUSINESS_TOOLS=true` (`enableBusinessTools=true` in
`main.bicepparam`) to serve `squad_business_plan` and `squad_backlog` (scopes
`Squad.Business` / `Squad.Backlog`). Both are advisory: one server-side dispatch each,
no gate, no impactful action. Requires `SQUAD_MCP_MODEL_ENDPOINT`.

`squad_backlog` returns a validated JSON contract (`epics` → `stories` → `tasks`, plus
a flattened `workItems[]` with stable `ref` / `parentRef`) designed to be looped one
call per item into the **native** Azure DevOps or Jira connector. This server performs
no ADO/Jira write — see the Scenario A runbook for the connector, licensing, throttle,
and DLP guidance, and paste
`generated/copilot-studio-connector/agent-instructions.md` into your agent so it maps
the contract correctly and asks for confirmation before creating items.


## Optional — register hve-squad-mcp for Agents 365 governed-tenant onboarding (WI-05)

> **Documentation-only.** This optional section is a reference sequence for onboarding the
> deployed `/mcp` endpoint as a governed **bring-your-own (BYO) MCP** tool through the
> Agents 365 admin flow, so a Copilot Studio maker in a governed tenant can consume it
> under central approval. It governs the tool; it does NOT make this server an agent host
> on M365 or Cowork (see "What this deployment intentionally does NOT do" below).

Use this path when your tenant requires MCP tools to be admin-approved before a maker can
add them, rather than each maker importing the custom connector ad hoc (Step 8). The
underlying endpoint, Entra app, and scopes are the same ones stood up in Steps 2 and 8;
this flow adds a tenant-level registration and approval in front of them.

### Prerequisites

- The server is deployed and smoke-tested (Steps 1 to 8): you have `mcpFqdn`, the Entra
  `APP_ID`, and the audience it validates against — the bare `APP_ID` GUID for an
  `entra-app.bicep` app (v2 tokens), or `api://<APP_ID>` for a legacy manual app.
- The Entra app exposes the connector scopes (Step 2): `Squad.Research`, `Squad.Plan`,
  `Squad.Review`, `Squad.Architect`, `Squad.Run` (and `Squad.Render` if you enabled the
  optional render tool).
- You (or a tenant admin) hold the **Microsoft 365 admin** role needed to approve BYO
  tools, and a Copilot Studio maker seat exists in the same tenant.
- **Generative orchestration** can be enabled on the consuming agent; it is required for
  the agent to call MCP tools.
- A **Data Loss Prevention (DLP)** classification is planned for the tool. Governed
  tenants block unclassified connectors by default, and blocking a connector also blocks
  the connected MCP server's tools.

### Step A — register the server via the Agents 365 CLI

Register the deployed endpoint as a BYO MCP tool. Exact command names and flags track the
current Agents 365 CLI documentation; the shape is:

```bash
# Authenticate the CLI to the same tenant as the deployment.
agents365 login --tenant "<ENTRA_TENANT_ID>"

# --audience must equal SQUAD_MCP_AUDIENCE / squad.audience: the bare APP_ID
# GUID for an entra-app.bicep app (v2 tokens), or api://<ENTRA_CLIENT_ID> for a
# legacy manual app (shown below).
# Register the MCP endpoint as a bring-your-own tool in the tenant catalog.
agents365 tool register \
  --name "hve-squad-mcp" \
  --protocol mcp-streamable \
  --endpoint "https://<mcpFqdn>/mcp" \
  --auth entra-oauth2 \
  --audience "api://<ENTRA_CLIENT_ID>" \
  --scopes "Squad.Research Squad.Plan Squad.Review Squad.Architect Squad.Run"
```

The endpoint advertises `x-ms-agentic-protocol: mcp-streamable-1.0`; it is Streamable HTTP
only (SSE is unsupported after August 2025). Registration submits the tool for admin
approval; it does not make the tool consumable until Step B approves it.

### Step B — approve the tool in the Microsoft 365 Admin Center

A tenant admin reviews and approves the registered tool before any maker can add it:

```text
1. Open the Microsoft 365 Admin Center, then Copilot / Agents & tools, then pending approvals.
2. Locate the "hve-squad-mcp" BYO MCP tool submitted in Step A.
3. Review the endpoint (https://<mcpFqdn>/mcp), the Entra audience (the bare `APP_ID`
   GUID for an `entra-app.bicep` app, or `api://<APP_ID>` for a legacy manual app), and
   the requested scopes; confirm they match this deployment.
4. Assign the DLP classification (Business vs Non-Business) so the tool is permitted in the
   intended environment and blocked where it should not run.
5. Approve the tool (optionally scope it to specific environments or maker groups).
```

Approval is what lets governed-tenant makers see and add the tool; without it the
registration stays pending and is not consumable.

### Step C — consume the approved tool in Copilot Studio

Once approved, a maker adds it like any governed tool:

```text
1. In Copilot Studio, open the agent, then Tools, then Add a tool, then Model Context Protocol.
2. Select the approved "hve-squad-mcp" tool from the tenant catalog; no manual OpenAPI
   import is needed once it is admin-approved.
3. Complete the Entra OAuth 2.0 connection, consenting to the scopes from Step 2.
4. Enable generative orchestration on the agent so it can call the MCP tools.
5. Test: "research X with the squad" reaches /mcp and returns a squad-guided / embedded
   artifact; "run the full squad on X" returns a run id and holds at the Human Gate.
```

Success criteria: a tenant admin has approved the registered `hve-squad-mcp` BYO MCP tool,
a governed-tenant Copilot Studio maker can add it under the assigned DLP classification,
and the agent (with generative orchestration enabled) calls the advisory tools over the
Entra-authenticated `/mcp` endpoint.

## Step 9 — operate and tear down

- **Cost controls:** the per-tenant concurrency cap (SEC-9 / COST-1) and the hard
  monthly cost ceiling (COST-2) are enforced in the engine; the budget alerts and
  scale-to-zero are enforced in the IaC. Per-tenant *rate* limiting (host side) is a
  documented Phase-1b boundary requiring an APIM / Front Door layer.
- **Logs:** application logs flow to the Log Analytics workspace; every line is
  scrubbed of tokens, keys, and claims before it is written (SEC-10).
- **Tear down everything:** `az group delete --name "$RESOURCE_GROUP" --yes`. Delete
  the Entra app registration and the connector separately
  (`az ad app delete --id "$APP_ID"`).

## What this deployment intentionally does NOT do

- **No shell / process execution** over the remote boundary; the embedded engine
  does inference plus contained file I/O only (SEC-7).
- `squad_run` **is** exposed as a gated async pipeline, but a long run beyond the
  240s ACA ingress timeout needs a **background worker / ACA Job** to drive
  execution off the status-poll path; that worker is not deployed here, so keep
  runs short.
- **No M365 / Agent 365 (PROD-4) and no Microsoft Cowork (PROD-3)** targets yet.
- Widening the remote surface to `squad_run` / `squad_status` reopens the
  council-gated PROD-1 boundary; a **security re-gate** is required before
  production use, even though the gate is safe by construction (holds, never
  auto-releases, cross-tenant denied).
- Durable resumable run-state **is** realized for the async pipeline
  (`DurableRunStateStore`); the production store targets Azure Storage / Key Vault
  (a follow-up) rather than the local file store used here.
- **`bootstrap.bicep` and `entra-app.bicep` are one-time, human-run, gated
  deployments — never part of any per-commit pipeline.** Neither is ever run by
  CI; each waits on the named security reviewer's U5 sign-off (Step 1) before
  its first live run against a real subscription/tenant.
- **Tenant-admin consent stays manual regardless of automation** — for the four
  high-impact scopes (`Squad.Run`, `Squad.Federate`, `Squad.MemoryWrite`,
  `Squad.Backlog`, Step 2) and for Copilot Studio's connector generally.
- **The Copilot Studio connector import and generative-orchestration toggle
  (Step 8), the optional Agents 365 registration/approval/consumption steps
  (the "Optional — register hve-squad-mcp for Agents 365" section), and the
  `graph-memory-permissions.bicep` deployment (its own separate,
  higher-privileged admin action — see "Grant the app identity access to the
  library" above) all stay manual, in-product or human-run actions** — none of
  them is folded into `main.bicep` or any CI/CD pipeline.
- **Releasing a held `squad_run`** stays an out-of-band, human `/admin/approve`
  call (above) — the product's own Human Gate, not something automation
  short-circuits.

## Cross-references

- IaC: [host/infra/main.bicep](infra/main.bicep) · [host/infra/main.bicepparam](infra/main.bicepparam)
- Bootstrap (Step 1, one-time, subscription-scoped): [host/infra/bootstrap/bootstrap.bicep](infra/bootstrap/bootstrap.bicep) · [host/infra/bootstrap/bootstrap.bicepparam](infra/bootstrap/bootstrap.bicepparam)
- Entra app registration (Step 2, one-time, separate deployment): [host/infra/bootstrap/entra-app.bicep](infra/bootstrap/entra-app.bicep) · [host/infra/bootstrap/entra-app.bicepparam](infra/bootstrap/entra-app.bicepparam)
- Local IaC validation: [host/infra/tests/README.md](infra/tests/README.md) · `node host/infra/tests/validate.mjs` · [host/infra/tests/Test-RoleAssignmentPreFlip.ps1](infra/tests/Test-RoleAssignmentPreFlip.ps1) (Step 7 migration)
- Image: [host/Containerfile](Containerfile)
- OIDC: [host/oidc/README.md](oidc/README.md) · [host/oidc/deploy-aca.workflow.yml](oidc/deploy-aca.workflow.yml)
- Connector: [generated/copilot-studio-connector/README.md](../generated/copilot-studio-connector/README.md)
- Conformance gate (run before you ship): `npm run test:conformance` in `squad-mcp/`.
