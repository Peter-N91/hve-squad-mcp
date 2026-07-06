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
before spend grows.

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

You can deploy manually with your own `az login` (above) or wire the reference
GitHub Actions workflow (`host/oidc/deploy-aca.workflow.yml`) with **workload-identity
federation** so no client secret is ever stored.

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
Create one app registration to represent the MCP resource server.

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

Add all five scopes — the generated connector requests every one of them. The
`Squad.Operate` app role is separate: it authorizes the out-of-band operator
approval route (`POST /admin/approve`) and is granted as an Entra **app role**, not
a delegated connector scope.

If you enable the optional deterministic render tool (below), also add a
`Squad.Render` delegated scope — it authorizes `squad_render_pptx` and is
least-privilege (a render grant does not imply research/plan/run).

Notes:

- The **audience** the server checks is `api://$APP_ID` (the `SQUAD_MCP_AUDIENCE`
  value). Keep it consistent across the app registration, `main.bicepparam`, and the
  connector's `apiProperties.json`.
- The **JWKS / issuer** the server trusts are your tenant's:
  - JWKS: `https://login.microsoftonline.com/$TENANT_ID/discovery/v2.0/keys`
  - Issuer: `https://login.microsoftonline.com/$TENANT_ID/v2.0`
- If Copilot Studio's first-party connector needs pre-authorization, add it under
  **Expose an API → Authorized client applications**.

## Step 3 — provision Azure OpenAI (real spend begins) (SEC-3)

The embedded engine calls **one** operator-configured Azure OpenAI endpoint
(SEC-3: the endpoint is allow-listed and never taken from a caller). Create or
reuse an AOAI resource and a chat deployment.

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
  audience: 'api://<ENTRA_CLIENT_ID>'
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
param budgetAlertEmails = [ '<ALERT_EMAIL>' ]
```

These map 1:1 to the server's environment contract (`SQUAD_MCP_AUDIENCE`,
`SQUAD_MCP_ALLOWED_ORIGINS`, `SQUAD_MCP_JWKS_URI`, `SQUAD_MCP_MODEL_ENDPOINT`, …);
the Container App sets them for you. No secret belongs in this file — the model
token comes from managed identity at runtime (SEC-10).

## Step 5 — build the image in ACR (real, small spend)

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

```bash
az deployment group create \
  --resource-group "$RESOURCE_GROUP" \
  --template-file squad-mcp/host/infra/main.bicep \
  --parameters squad-mcp/host/infra/main.bicepparam \
  --parameters containerImage="$ACR_NAME.azurecr.io/$IMAGE" \
  --parameters containerRegistryServer="$ACR_NAME.azurecr.io"
```

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
no key in code or image. Grant it the data-plane role on the AOAI account:

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
# A token whose audience is the resource server. Use a client that requests the
# Squad.Research scope for a real tools/call; initialize only needs a valid token.
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

## Step 8 — import the connector into Copilot Studio (PROD-1)

The connector files are generated under
`generated/copilot-studio-connector/` (regenerate with
`npm run generate:connector`; do not edit by hand).

1. In `apiDefinition.swagger.json` and `apiProperties.json`, replace:
   - `<SQUAD_MCP_HOST>` → your `mcpFqdn` from Step 6 (host only, no scheme),
   - `<ENTRA_TENANT_ID>` → your tenant id,
   - `<ENTRA_CLIENT_ID>` → the `APP_ID` from Step 2,
   - `<SQUAD_MCP_AUDIENCE>` → `api://<ENTRA_CLIENT_ID>`.
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

## Cross-references

- IaC: [host/infra/main.bicep](infra/main.bicep) · [host/infra/main.bicepparam](infra/main.bicepparam)
- Image: [host/Containerfile](Containerfile)
- OIDC: [host/oidc/README.md](oidc/README.md) · [host/oidc/deploy-aca.workflow.yml](oidc/deploy-aca.workflow.yml)
- Connector: [generated/copilot-studio-connector/README.md](../generated/copilot-studio-connector/README.md)
- Conformance gate (run before you ship): `npm run test:conformance` in `squad-mcp/`.
