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
| Step 6 | ACA managed environment, Log Analytics, Key Vault | **Real** — Log Analytics ingestion + Key Vault ops; the template defaults to `minReplicas: 1` when MISE is enabled so its hourly client-telemetry exporter can run, which adds continuous ACA compute cost |
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
| `Squad.Federate` | invoke `squad_federate` (the federation meta layer) |

Add all six scopes — the generated connector requests every one of them. The
`Squad.Operate` permission is separate: it authorizes `squad_approve` and the
operator approval route (`POST /admin/approve`). Keep it off ordinary work
connections. For an operator's interactive Cowork connection, expose it as an
admin-consent delegated scope on the API, grant/consent it to the connector, and
refresh the connection token. An Entra app role also supports the external
operator workflow. Azure subscription Owner and storage-data roles are not
this API permission.

`Squad.Federate` is deliberately distinct from `Squad.Run`: authorization to run
one squad is not authorization to drive a whole federation. `squad_federate` is a
gated catch-all like `squad_run` — it is served only when
`SQUAD_MCP_REMOTE_PIPELINE_ENABLED=true`, holds at the Human Gate, and is released
by the same authorized `squad_approve` action or `/admin/approve` route.

If you enable the optional deterministic render tool (below), also add a
`Squad.Render` delegated scope — it authorizes `squad_render_pptx` and is
least-privilege (a render grant does not imply research/plan/run).

If you enable the shared-state memory broker, add `Squad.Memory` (read) and
`Squad.MemoryWrite` (compare-and-swap write / batch flush). If you enable the
business tools, add `Squad.Business` (`squad_business_plan`) and `Squad.Backlog`
(`squad_backlog`). Every scope is fail-closed: a missing scope returns 403 with no
work performed.

Notes:

- The **audience** the server checks is `api://$APP_ID` (the `SQUAD_MCP_AUDIENCE`
  value). Keep it consistent across the app registration, `main.bicepparam`, and the
  connector's `apiProperties.json`.
- `SQUAD_MCP_AUDIENCE` accepts a **comma-separated list** only for valid aliases
  of the same protected-resource registration. Entries are trimmed,
  de-duplicated, and matched **exactly** (never as a prefix or wildcard); a blank
  entry is dropped rather than becoming an audience that matches nothing. Never
  combine client ids from different app registrations. When MISE is enabled, the
  template ignores aliases and derives the application's, ingress's, and MISE's
  single audience from `authClientId`. Use a separate non-MISE deployment for a
  test registration.
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
param enableMise = false
param miseContainerImage = '<REGISTRY>.azurecr.io/mise/mise-1p-container@sha256:<MISE_IMAGE_DIGEST>'

param squad = {
  audience: 'api://<ENTRA_CLIENT_ID>'
  allowedOrigins: 'https://copilotstudio.microsoft.com'   // SEC-8: strict, never '*'
  allowedIssuers: 'https://login.microsoftonline.com/<ENTRA_TENANT_ID>/v2.0'
  allowedTenants: '<ENTRA_TENANT_ID>'
  jwksUri: 'https://login.microsoftonline.com/<ENTRA_TENANT_ID>/discovery/v2.0/keys'
  modelEndpoint: 'https://<AOAI_RESOURCE>.openai.azure.com'
  allowedModelEndpoints: 'https://<AOAI_RESOURCE>.openai.azure.com'  // SEC-3 allow-list
  modelDeployment: 'gpt-5.6-sol'
  modelApi: 'responses'
  modelApiVersion: '2024-10-21'
  modelMaxOutputTokens: 32768
  modelReasoningEffort: 'medium'
  modelVerbosity: 'medium'
  tenantConcurrency: 4      // SEC-9 / COST-1
  tenantCostCeilingUsd: 500 // COST-2 (hard per-tenant monthly ceiling)
}

param budgetAmountUsd = 500
param budgetAlertEmails = [ '<ALERT_EMAIL>' ]
```

These map 1:1 to the server's environment contract (`SQUAD_MCP_AUDIENCE`,
`SQUAD_MCP_ALLOWED_ORIGINS`, `SQUAD_MCP_JWKS_URI`, `SQUAD_MCP_MODEL_ENDPOINT`, …).
Current GPT-5 reasoning deployments should use `modelApi: 'responses'`;
`modelApiVersion` is retained only for legacy Chat Completions mode. The
`modelMaxOutputTokens` budget includes both visible output and reasoning tokens.
For GPT-5.6 Sol, 32,768 gives the model more than Microsoft's initial 25,000-token
reasoning/output reserve while leaving throughput headroom under the deployment's
TPM limit. Do not set the 128,000 model maximum as the routine default: Azure's
rate-limit estimate includes the configured maximum, even when actual output is
shorter. Explicit medium reasoning and medium verbosity avoid the model's
occasionally very long default response path while retaining balanced
planning/judgment quality for synchronous Cowork tools.
The Container App sets them for you. No secret belongs in this file — the model
token comes from managed identity at runtime (SEC-10).

### Optional: Microsoft Identity Service Essentials (MISE) Container v2

Set `enableMise=true` only after an approved MISE 2.4.1+ Linux x64 image is in a
registry the Container App identity can pull from. Pin `miseContainerImage` by
digest (preferred) or by a source-commit-specific immutable tag. Microsoft-only
MCR images can require ACR Artifact Sync; where the official MISE guidance permits
a source build, pin the published release tag and do not build a moving branch.

When MISE is enabled, `authClientId` identifies the **protected MCP resource** in
MISE telemetry and is the single source of truth for ACA Easy Auth, the
application audience, and the MISE `ClientId` and audience. The template does
not copy `squad.audience` aliases into MISE. MISE receives the tenant allow-list
from `squad`:

- one allowed tenant uses that tenant as the authority;
- several allowed tenants use the `common` authority plus explicit
  `ValidTenantIds`; and
- an empty application tenant allow-list maps to MISE's explicit `*` behavior.

For HVE Squad EMEA, keep the production and test identities isolated:

| Deployment | MISE | Resource app | Tenant boundary |
| --- | --- | --- | --- |
| Microsoft/Cowork production | Enabled | `c98eb224-95c3-42fe-b44f-3fe7a035272a` | Microsoft tenant `72f988bf-86f1-41af-91ab-2d7cd011db47` only |
| VentureDSMaven testing | Disabled | `37283524-358a-4a59-b6f5-1e66efa46151` | VentureDSMaven tenant `9ccd04d9-a4d9-4d23-85e8-9a638ef56624` only |

Give the test deployment a different resource group or `namePrefix`. With
`enableMise=false`, it has no MISE sidecar, sends no token to
`/ValidateRequest`, emits no MISE client telemetry, and defaults back to
scale-to-zero.

The application sends only Entra tokens to
`http://127.0.0.1:5000/ValidateRequest`, including the original method, absolute
URI, and ACA-provided rightmost sender IP required by MISE. Client-prepended
`X-Forwarded-For` values and `X-Forwarded-Host` are not trusted. The endpoint
configuration rejects every
non-loopback host, other port/path, credential, query, or fragment. MISE must
return exactly HTTP 200; timeout, redirect, non-200, or claim-decode failure is a
401 at the application boundary. Local simple-OAuth HS256 tokens continue to use
the local verifier and are never forwarded to MISE.

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

- the **ACA managed environment** + a configurable app (the template defaults
  to `minReplicas: 1` when MISE is enabled so sparse traffic still exports
  client telemetry, and to `0` otherwise;
  HTTPS-only ingress on port 3000; COST-3 / ARCH-2 / SEC-8);
- a **user-assigned managed identity** + a **Key Vault** with an RBAC role
  assignment so the app identity can read secrets (SEC-10);
- **ACA built-in Entra auth** in front of the app's own audience-bound validation
  (defense-in-depth; SEC-1); and
- when `enableMise=true`, the **MISE Container v2 sidecar**, with `/readyz` and
  `/healthz` probes, loopback-only application calls, and the same replica
  lifecycle as the application; and
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

For MISE, also verify that every live replica reports both `hve-squad-mcp` and
`mise` ready, that the sidecar fetched signing-key metadata, and that real
authenticated traffic reached `/ValidateRequest`. Keep the previous application
image reference. In this template's single-revision mode, rollback means
redeploying that known-good image with `enableMise=false`; do not weaken auth or
add a fallback from a MISE rejection to the legacy JWKS verifier. MISE client
metrics export hourly. For sparse workloads, keep `minReplicas: 1`; use
`minReplicas: 0` only when the process calls
`OneCollectorExporter.ForceFlush()` before shutdown or another verified strategy
keeps a validating process alive through an export interval. Also verify outbound
TCP 443 reachability through the `OneDsCollector` service tag where egress is
restricted. MISE/S360 telemetry normally needs 2–3 days after every validating
replica emits compliant signals before the KPI auto-resolves.

### Optional: zero-configuration OAuth (no Entra client registration)

The default Entra resource-server path above remains the recommended path for
Copilot Studio and governed Microsoft 365 clients. For a generic desktop or CLI
MCP client that cannot register an Entra application, set
`enableSimpleOAuth=true`. The server then becomes an additional OAuth issuer:

- RFC 9728 protected-resource metadata and `WWW-Authenticate` discovery;
- RFC 8414 authorization-server metadata;
- RFC 7591 dynamic public-client registration;
- authorization code flow with mandatory PKCE S256;
- loopback redirects only (`localhost`, `127.0.0.1`, or `[::1]`);
- operator-issued, single-use browser codes;
- short-lived signed access tokens and one-time rotating refresh tokens.

This path does **not** weaken or replace Entra. Entra bearer tokens continue to
work, and `/admin/approve` remains behind Container Apps Easy Auth plus the
distinct `Squad.Operate` role. The local issuer cannot grant `Squad.Operate`.

1. Generate a 32-byte signing key. Keep the current key first and retain the prior
   key after rotation until existing client registrations and refresh grants have
   expired. The deployment uses a versionless Key Vault reference, so Container
   Apps refreshes the secret and restarts active replicas after rotation:

   ```powershell
   $oauthKey = [Convert]::ToBase64String(
     [Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
   )
   ```

2. Set these Bicep parameters and deploy:

   ```bicep
   param enableSimpleOAuth = true
   param simpleOAuthSigningKeysBase64 = '<BASE64_32_BYTE_KEY>'
   // Optional: restrict the ordinary tool scopes a local token may receive.
   param simpleOAuthAllowedScopes = 'Squad.Research,Squad.Plan,Squad.Review,Squad.Architect,Squad.Run,Squad.Memory,Squad.Backlog'
   ```

   The template stores the signing-key value in Key Vault, creates the
   `squadoauth` Azure Table, grants the app identity Table access, and excludes
   only `/mcp` plus the public OAuth/discovery routes from Easy Auth. Application
   JWT verification remains the authorization boundary on `/mcp`.

3. Issue a code from **inside the running container**. There is deliberately no
   remote code-issuance endpoint:

   ```bash
   az containerapp exec \
     --resource-group "$RESOURCE_GROUP" \
     --name "${NAME_PREFIX:-squadmcp}-app" \
     --command "node dist/src/oauth-cli.js issue-code \
       --tenant-id <TENANT_PARTITION_UUID> \
       --subject <STABLE_USER_ID> \
       --scopes Squad.Run,Squad.Architect,Squad.Memory,Squad.Backlog \
       --ttl-seconds 600"
   ```

   `tenant-id` is the tenant partition the resulting token may address and must be
   present in `SQUAD_MCP_ALLOWED_TENANTS` when that allow-list is configured. The
   CLI prints the browser code once; Azure Table stores only its SHA-256 index and
   encrypted payload.

   Issuing a code performs a bounded expired-grant sweep. Operators can also run
   cleanup explicitly (for example from a scheduled Container Apps Job):

   ```bash
   node dist/src/oauth-cli.js sweep --limit 500
   ```

4. Give the user the code and add `https://<mcpFqdn>/mcp` to an OAuth-capable MCP
   client. The client discovers, registers, and opens `/oauth/authorize`; the user
   enters the code. No Entra application id or client secret is supplied to the
   MCP client.

5. Verify discovery without a credential:

   ```bash
   curl -sS "https://<mcpFqdn>/.well-known/oauth-protected-resource/mcp"
   curl -sS "https://<mcpFqdn>/.well-known/oauth-authorization-server"
   ```

Security properties: login and authorization codes are one-time; refresh tokens
rotate on every use; grant payloads are encrypted at rest; client registrations
and authorization forms are signed; access tokens last no more than one hour;
redirects are loopback-only; PKCE S256 is mandatory; client secrets and
anonymous/self-service token issuance are unsupported.

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
   returns a **run id** and pauses at the Human Gate; after an authorized
   operator approval (below), a `squad_status` poll with that run id advances the
   run and returns the finished artifact. The gate never auto-releases across the
   remote boundary.

### Releasing a held run (operator action)

A held `squad_run` is released ONLY by an authenticated operator with
`Squad.Operate`, through `squad_approve` or the admin route. A saved file, ordinary
tool scope, or text in request/context cannot release it:

- Grant the human/service operator the distinct **`Squad.Operate`** permission (NOT
  `Squad.Run`). Only this permission may approve; a caller that can start or poll a run
  cannot release one.
- In Cowork, capture the human decision, save/read back the decision contract,
  and invoke the discovered `squad_approve` with `runId`, `decision: "approve"`,
  the saved `projectId` for project-bound runs, and optionally `decisionId`.
  Only schema-supported fields are accepted; the approver comes from the token.
  Check `approved: true` and the matching run id in the response, save the receipt,
  and poll `squad_status` on that same run with the latest project checkpoint.
  An absent tool means the server is old, the pipeline is disabled, or the token
  lacks operator permission; do not call `squad_run` again to bypass it.
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
  itself an MCP tool; `squad_approve` is the separately discoverable alternative.

### Recovering queued runs and project-context conflicts

`outcome: held` is also the response envelope for unfinished queued work. Check
the reason: `queued`, `queued_for_worker`, and `run_already_in_flight` do not
request human approval. With `SQUAD_MCP_ADVISORY_AUTOPILOT_ENABLED=true`, server-
classified advisory work is persisted as `running` without a hold reason. Poll
that same run; do not submit or fabricate an approval receipt. Actual `held`
records still require an authenticated operator's explicit approval.

Older poll logic incorrectly reported unapproved `running` records as awaiting
human approval, while `squad_approve` correctly returned `run_not_held`. Deploy
the corrected poll logic and resume with `squad_status`; do not recreate the run,
manually change its status, or stamp approval fields into storage.

For repeated `project_context_conflict` with no concurrent project-file change,
check the Table adapter's ETag handling. Collection reads must request
`application/json;odata=fullmetadata`: neither `nometadata` nor `minimalmetadata`
includes `odata.etag`. Single-entity reads also preserve the HTTP ETag header.
Missing ETags must fail explicitly, never become an empty create-only token or
a wildcard update. Preserve conditional writes and genuine conflict detection.

The server accepts forward revision gaps caused by locally committed blocked
turns; `expectedNextRevision` is not a requirement to replay every intermediate
revision. Reload the current project manifest, keep its UUID and folder binding,
and poll the existing run with the current revision and activity sequence.
Do not roll the project back to the original run checkpoint. Approval checks
the run's tenant and project UUID, not the local revision number.

### Tool-enabled research and artifact gates

A model completion with a researcher persona is not a research runtime. The
server now provides a bounded native tool loop through its Azure OpenAI
Responses and Chat Completions backends. Responses tool turns replay reasoning
items in stateless mode; pinned agent and instruction files are loaded only
from the deployed cast bundle.

The active hve-squad v0.17.0 snapshot contains deployed agents and instructions
only. This runtime does not bundle or load Agent Skills; skill names in an
upstream charter do not create available capabilities. Native procedures and
validators provide research, planning, and review contracts instead.
`list_bundle` discovers pinned instructions, `load_instruction` adds an
instruction to system authority, and `read_reference` reads instruction
references as data. No tool reads project content as executable authority.
Code execution and deployment remain outside the Cowork advisory scope.

Prerequisites:

- Enable artifact storage and auto-memory over the configured memory backend.
  These bind tools to the authenticated tenant and resolved project partition.
  Both the HTTP process and worker wire the same memory/artifact stack.
- Use a tool-capable backend and deploy an image containing the active pinned
  agent and instruction bundle. A missing runtime, instruction, worker or
  durable artifact fails explicitly.
- Supply the brief's actual content through project context or stored artifacts.
  A SharePoint/OneDrive URL by itself does not give the model access to that file.
  Cowork remains the project I/O bridge; this change grants no new Graph access.

Execution and proof:

1. The primary researcher writes its main artifact before dispatching any
   source-gathering lanes.
2. Each `RPI Researcher` receives a bounded contract and is read-only. It returns
   candidate source pointers, exact locations, excerpts, and relevance notes as
   unverified suggestions; it creates no lane artifact or file. A worker's
   evidence receipts are not parent evidence. Workers cannot recurse, execute
   terminals, or change the primary. Reads are restricted to delegated paths and
   permitted source URLs.
3. The primary researcher independently reads every source it uses, cites its
   own tool-issued evidence IDs, and writes the verified synthesis. Retrieved
   evidence gets a source ID, timestamp and content SHA-256. Finishing research
   requires actual parent evidence receipts, citations in the saved artifact, at
   least one completed candidate-source lane and honest `ready-with-gaps`
   reporting for incomplete lanes. Each artifact has a `.sources.json`
   provenance sidecar. Wider/Deeper/Contrarian ordering and research structure
   are checked by the server-owned validator. `validate_artifacts` exposes
   structural errors for correction before final completion.
4. Writes use conditional storage updates and exact read-back checks. Dispatch
   history is verified before a successful stage result. Plan/review roles use
   server-owned structural contracts and typed BRD findings/report schemas;
   declared advisory delegates receive explicit read scope and separate output
   roots. Children cannot expand read permissions or form delegation cycles;
   named advisory delegation is limited to four levels. Research lanes and
   independent critique/BRD quality reviewers cannot recursively delegate.
   Council members also use the runtime, with separate artifact roots and
   serialized tool execution against the shared budget before verdict synthesis.
   Every tool-enabled member must return an explicit council verdict and any
   conditions; a missing verdict cannot silently become approval.
   Planning owns separate plan and phase-details artifacts and requires one
   fresh generic native-contract critique worker; this is not an invented named
   agent. BRD completion requires an explicit passing quality receipt for the current
   draft. A completed review reporting revisions, a stale review, or a modified
   review artifact cannot satisfy that gate. Quality review does not grant
   stakeholder approval.
   Critique execution status and verdict are distinct. A planning `Revise`
   verdict does not trigger a second critique; the parent applies compatible
   corrections and records finding ownership, disposition and resolving evidence.
5. A plain completion saying "no filesystem", missing artifacts, fabricated
   evidence IDs, lost writes or exhausted limits stops the run. The run is
   persisted as `failed` with a stable `failureReason`, not `complete` or awaiting
   human approval. Polling returns that same failure and does not rerun it.

Unexpected advisory-stage exceptions also preserve the active pipeline stage and
completed-stage output in the failed run's artifact. `model_backend_<kind>`
identifies the backend's classified failure (for example, `input_too_large` or
`upstream`); `stage_execution_failed` denotes an unclassified execution error,
and `stage_persistence_failed` denotes a completed stage whose progress or ledger
write failed. `advisory_run_failed` denotes an exception outside those stage
boundaries. Raw exception messages and provider payloads are not exposed in these
receipts. A failure inside a delegate identifies its owning pipeline stage, not
necessarily the child that failed. These diagnostics do not retroactively explain
older `run_failed` records, certify partial BRDs, or diagnose a host's separate
model-session errors. Existing human-response receipts and persisted files remain
intact; polling never retries a failed run.

Non-policy model failures also carry an optional `modelFailure` diagnostic in
the durable run, immediate MCP error, and subsequent terminal status. Its cause
is `model_backend_failure`, not `provider_content_policy`. The receipt includes
the owning stage, allocated run ID, existing failure kind, validated HTTP status,
an explicitly allowlisted lower-case provider/transport code, and a bounded
provider correlation identifier when supplied. Arbitrary error messages, bodies,
prompts and unrecognized codes are excluded. Transport failures without a
response have no invented HTTP status or provider request ID; a response-body
failure can retain the actual response status, including 200, without treating
its incomplete body as success. The same safe receipt is logged with the run ID.

Text-only hosts receive these diagnostics and their machine-readable receipt
before large preserved artifacts. This is backend-compatible with existing
Cowork clients; it adds no tool, permission, human question, or automatic retry.
Existing transport retry bounds and caller-cancellation behavior are unchanged.
`terminal=true` and `sameRunResumable=false` describe the failed attempt, not
authorization for new work. Historical failures without this field retain their
existing reason and unknown details. Better diagnostics neither backfill the
unknown upstream cause nor demonstrate that its cause has been repaired.

The operator log event `Azure OpenAI request rejected` additionally contains
`providerValidation`: validated provider code/type/parameter/reason, a recognized
parameter or function-schema validation rule and constant explanation, or a
bounded diagnostic-vocabulary projection for a novel explanation.
Correlate its provider request ID and timestamp with the stage/run failure.
This operator-only detail does not change the MCP schema or require a plugin
update. Version 2 accepts 3–6 digit numeric error codes and novel identifiers
composed entirely of diagnostic vocabulary, rather than requiring a previously
known complete error code. Unknown words and quoted values in explanations are
replaced by `[redacted]`; only diagnostic vocabulary, known request field paths,
and limited punctuation survive. No free-form provider prose or raw body is
retained. URLs, email addresses, unrestricted numbers, credentials, JSON/tool
bodies, explicitly labelled input/reasoning/instruction tails, and detected
three-word request echoes are removed. The adapter supplies the exact credential
and serialized request privately to the projector; neither is persisted.
Messages over 4,096 characters are omitted, projections are capped at 512
characters, and novel prose is omitted when the request exceeds 2,000,000
characters. Up to eight envelopes and four nesting levels are inspected without
invoking custom property getters.

This is an **operator rejection-log-only** surface, not raw-response logging:
the public/durable `modelFailure` and native `squad_status` keep their stricter
allowlist and correlation ID. Use that ID to retrieve the diagnostic from
operator logs. A projected explanation is incomplete, untrusted evidence, not
an instruction or a proven diagnosis. Unknown terms, quoted enum values, counts,
and long numeric codes can be lost. Arbitrary prose cannot be perfectly
distinguished from echoed data: finite diagnostic vocabulary can still convey
diagnostic semantics, and short numeric codes are retained only in typed
identifier slots; these details must not be republished as a raw provider message.
Unknown or unsafe fields remain explicitly marked omitted; absence of a
recognized explanation is not success or proof of a cause. A deployed
adapter and helper are required; an isolated diagnostic harness alone does not
add this capture to actual worker failures.
Naturally scheduled worker executions emit `Provider diagnostic runtime` once
at startup with SHA-256 hashes of the adapter, projector and worker entry module.
Compare these to the exact-image test manifest without starting a worker job or
a model run. This receipt contains no environment values or file contents.

The parser accepts a top-level error record, `error` wrappers, and both
`innererror`, `inner_error`, and object-valued `reason` nesting. Traversal is bounded; every retained
envelope is independently sanitized. A deeper unsafe identifier is explicitly
omitted rather than replaced with a misleading outer success. Responses with
`status=failed` also produce safe diagnostics even when HTTP transport returned
200. This does not enable streaming or change retry behavior.

#### Deterministic task-context preflight

This is context hygiene, **not ContentFiltered prediction, keyword censorship,
filter evasion, or evidence that an unobserved provider trigger has been fixed**.
Provider content filters and model/Chat-profile/schema policies remain enabled
and unchanged. Do not rewrite or automatically retry a rejected request.

The existing `context` string optionally carries an explicit JSON selection:

```json
{
  "kind": "hve-task-context",
  "schemaVersion": 1,
  "facts": [],
  "decisions": [],
  "constraints": [],
  "openQuestions": [],
  "sources": [
    {
      "path": ".copilot-tracking/research/source.md",
      "purpose": "Independent review of the original source",
      "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "excerpt": "Original business-source excerpt; preserve caveats exactly."
    }
  ],
  "exclusions": [
    { "category": "diagnostic_history", "count": 1 }
  ]
}
```

All top-level fields shown are required; `sources[].sha256` and `.excerpt` are
optional. Unknown fields, duplicate JSON keys, wrong/unsupported versions, bad
types and malformed claimed packets are rejected, not discarded. The serialized
packet is limited to **32,000 JavaScript string characters**, including JSON
formatting. Each array has at most 64 entries; `sources` has at most 16.
Facts, decisions, constraints and open questions are strings. Source path and
purpose must be nonblank strings; an optional hash must be 64 hexadecimal
characters. Exclusion entries contain only `category` and a nonnegative safe
integer `count`; categories are `conversation_history`, `diagnostic_history`,
`duplicate`, and `unrelated`. They never contain omitted conversation/diagnostic
prose. A hash is retained evidence metadata, not proof the supplied excerpt
matches the canonical source; independent source reading/review remains necessary.
Structure checks do not prove relevance, exclusion counts, or whether callers
correctly classified prose as business facts rather than historical diagnostics.

Accepted context is not summarized, trimmed, or rewritten by preflight. The
same packet validation runs during prompt composition and initial/resumed
`input/context.md` seeding, closing the readable-input bypass. Explicit packets
are not expanded with automatic memory/history digests; original canonical
artifacts remain unchanged and available through the existing evidence/review
tools. The coordinator validates the original root context before memory loading
or framing. It still opens the run recorder for roster seeding and the persisted
effective profile; tenant/project identity and normal durable history recording
are unchanged. SEC-5 authority/data separation and its existing envelope-delimiter
neutralization in composed prompts are preserved. Seeded input keeps original
accepted text; tool-result pairing, source hashes, review scope and actual human
answers are not modified.

Legacy plain context and ordinary business JSON remain supported. A legacy
request/context/prior-artifact section is limited to **256,000 characters**;
excess is now a local rejection, not middle truncation. Legacy context does not
prove relevance or exclude historical material; callers should select an
explicit packet when that distinction matters. Existing automatic legacy
memory framing still applies, and its final composed section must fit the cap.

Every `completeWithObserver` call and direct Azure completion is inspected
before backend invocation/authentication/fetch. The runtime also checks before
consuming its model-call counter, including later tool results and resumed human
answers. Inspected surfaces include the server system text, visible messages,
tool arguments/results/identifiers, tool definitions and nested schema
descriptions. JSON string values are inspected after JSON decoding; ordinary
nested JSON and business words such as “explicit”, “override”, “health” and
“breach” are not rejected. High-confidence private-key material, bearer/SAS
payloads, recognizable credential formats and forged chat-protocol role tokens
produce fixed rules. Opaque Responses `reasoning.encrypted_content` is neither
decoded nor changed; visible reasoning summaries still receive inspection.
This is not an exhaustive secret/PII detector or a universal injection classifier;
encoded/novel credentials and semantic attacks need additional controls.

Traversal is bounded (4,000,000 inspected characters including decoded values,
100,000 traversed nodes, depth 32, at most eight reported issues); cycles,
accessors, depth excess and over-budget input fail closed. The existing runtime
conversation cap also returns a local budget receipt. Rejections have
`modelFailure.providerCode = local_context_preflight_rejected`,
`providerAttempted = false`, and `preflight = {schemaVersion: 1, issues: [...]}`.
Issues contain only fixed `rule` identifiers and bounded structural `field`
locations. Arbitrary property names are represented by indexed `keys`/`values`,
not copied into receipts. Public/native status, durable failure metadata and
logs retain **no matched input, credential, snippet, tool body or provider body**.
No synthetic provider-attempt/usage event is emitted for a local rejection;
earlier real attempts and their costs remain accounted. These terminal failures
do not authorize a new run, bypass a gate, or alter provider filter settings.

#### Model capabilities and function schemas

Deployment names are operator-defined aliases, not a capability registry.
For Chat Completions, set `SQUAD_MCP_MODEL_CHAT_PROFILE` from the actual deployed
model's documented capabilities:

| Profile | Request behavior |
| --- | --- |
| `standard` (default) | Existing ordinary-chat behavior: `max_tokens` and the requested/default temperature. Reasoning effort is rejected locally. |
| `reasoning` | `max_completion_tokens`, no temperature, and configured `reasoning_effort` when supplied. Verify that the actual model supports the chosen effort. |
| `reasoning-no-effort` | `max_completion_tokens`, no temperature; rejects configured `reasoning_effort` (for example, the documented `o1-mini` limitation). |
| `gpt-5.6` | Reasoning Chat parameters, plus local rejection of tools/tool history unless effort was explicitly configured as `none`. The error recommends `SQUAD_MCP_MODEL_API=responses`; it does not silently disable reasoning or send a provider request. |

`max` effort is Responses-only; GPT-5.6 does not support `minimal`.
The capability profile does not rename a deployment, change model settings,
or infer capabilities from its alias. `SQUAD_MCP_MODEL_VERBOSITY` remains
Responses-only. Existing Responses routing, configured reasoning/verbosity,
stateless tool history, authentication and retry limits remain unchanged.
The deployed GPT-5.6 Responses configuration needs no new profile setting.

Both API branches explicitly send function `strict:false`. Existing schemas
are forwarded unchanged, including optional properties and their full JSON
Schema constraints; they are not converted into a narrower strict subset.
Provider schema conformance is not a trust boundary: existing server-side
argument validation, tool allowlists, permissions and human gates still apply.

Documentation verified for these compatibility rules:

- [Azure reasoning models](https://learn.microsoft.com/azure/foundry/openai/how-to/reasoning):
  Chat token parameters, model-dependent efforts, unsupported parameters and
  the GPT-5.6 reasoning-plus-tools limitation.
- [Responses REST reference](https://learn.microsoft.com/rest/api/microsoft-foundry/azureopenai/responses):
  `OpenAI.FunctionToolParam.strict` is an explicit nullable boolean.
- [Azure structured outputs](https://learn.microsoft.com/azure/foundry/openai/how-to/structured-outputs):
  `strict:true` schema enforcement has additional schema constraints.

These are documented compatibility fixes, not proof of the cause of any
historical HTTP 400. Investigate the exact new correlation and sanitized
validation receipt before attributing a failure.

For `model_backend_content_policy`, the provider rejected the request under its
content policy; an HTTP 400 with `ContentFiltered` is not a context-size error or
a document-review verdict. Keep the run failed and its draft unreviewed. Do not
automatically retry, switch models, strip safety instructions, or weaken filters.
An authorized operator can correlate the run ID and timestamp with the worker's
safe `Azure OpenAI request rejected` metadata (`status`, `kind`, `providerCode`)
and `worker run failed` entry. These fields alone do not identify the triggering
content, policy category, or delegated actor; do not infer those details or log
full prompts/provider responses to obtain them. Investigate suspected false
positives through the provider's supported review/support process.

Current policy failures expose a structured `responsibleAi` receipt in both
immediate MCP errors and subsequent status results. It includes stable cause
`provider_content_policy`, owning stage and run ID where allocated, terminal
semantics, and only validated provider status/code, correlation ID, direction,
category booleans and severity enums. Missing metadata stays `unknown` or absent.
HTTP 400 error filter-result metadata identifies the prompt path when supplied;
without it, direction remains unknown. Chat `finish_reason=content_filter` and
Responses `incomplete_details.reason=content_filter` identify filtered output.
Partial text and tool calls from those outputs are discarded before artifact
processing. A policy-coded Responses error with no directional metadata remains
unknown rather than inventing a completion category.

The durable run remains `failed`, with `failureReason=model_backend_content_policy`.
The receipt has `terminal=true`, `sameRunResumable=false` and
`acknowledgmentCanOverride=false`; it is not a `humanInput` question. Cowork should
explain the block immediately and offer legitimate source/request correction,
stop, or provider escalation. A correction requires explicit authorization for
new work linked to the original run; no automatic replay or same-run resumption
is implemented. Completed-stage outputs, persisted draft files and prior human
responses remain intact. These diagnostics make policy enforcement transparent;
they do not guarantee provider acceptance or remove provider safeguards.

Installing a Cowork plugin does not deploy the MCP API or worker. Check both
deployed image digests and revision timestamps before assuming local diagnostic
fixes are active. A historical table row with `status=failed` and no
`failureReason` still polls as `run_failed`; existing correlated worker logs may
explain it, but deploying a fix does not backfill that record.

A terminal run can retain an older project checkpoint after a human response or
later project activity. When a `squad_status` call omits `projectContext` and that
inherited checkpoint is stale, failed/completed status remains readable under
the existing tenant and project-identity checks. This fallback returns no bridge
acknowledgment or tracking projection and performs no checkpoint write or model
work. Explicit stale contexts and nonterminal runs still fail closed. Read the
terminal receipt; reconcile project synchronization separately rather than
rewriting history or replaying the run merely to see its failure.
Failure receipts and the read-only notice are placed in the first text block,
before large preserved artifacts, because some hosts discard structured content
or subsequent text blocks. Historical failures still retain their original
generic classification; adding the status envelope does not invent a cause.

Limits are shared across the runtime: 60 model calls, 160 tool calls, 6 delegated
workers per parent, 48 workspace files, 64,000 characters per artifact write, a
1,000,000-character tool conversation and a 180-second inline deadline
(30 minutes of active execution in the background worker). Every provider
attempt is recorded without prompt or artifact content. Usage supplied on
successful, incomplete, and failed responses is charged once to the process-local
tenant cost tracker; the cost ceiling is rechecked before the next completion.
Each durable run retains run/stage/actor, backend, model/deployment, outcome,
provider response ID, and reported input/output/reasoning/cache token fields.
Reasoning tokens are included in output totals and cache-read tokens are included
in input totals, so those detail fields must not be added to the totals.
The structured log also emits `gen_ai.operation.name`,
`gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.agent.name`,
`gen_ai.conversation.id`, `gen_ai.usage.input_tokens`,
`gen_ai.usage.output_tokens`, and `gen_ai.usage.cache_read.input_tokens` when
known, plus outcome/success and a tool-call count. These fields support retry,
context-growth, cache-hit, and tool-inflation analysis without logging content.

Cost values are configuration-derived estimates in USD, never posted billing.
Set both `SQUAD_MCP_PRICE_INPUT_PER_MTOK` and
`SQUAD_MCP_PRICE_OUTPUT_PER_MTOK` for the selected deployment. If the deployment
uses discounted cached input or a separately billed cache-write meter, also set
`SQUAD_MCP_PRICE_CACHED_INPUT_PER_MTOK` and
`SQUAD_MCP_PRICE_CACHE_WRITE_PER_MTOK`. Missing rates remain explicitly
`unavailable` or `incomplete`; they are not converted to zero. Invalid or
half-configured base pricing fails startup.

The monthly tenant cost tracker remains process-local. In a multi-replica web
tier or scheduled-job deployment it is not a shared billing-enforcement ledger;
durable per-completion records make reconciliation possible but do not make the
configured ceiling globally atomic. Treat shared quota enforcement as a separate
correctness rollout rather than an efficiency claim.

Pinned skills, shared instructions and declarative references have a separate
**256,000-character per-resource read limit**. Each actor may load up to
**1,000,000 characters of unique pinned authority**. Re-loading a resource
replaces its existing entry rather than charging it twice. Full instruction
content is supplied in the next system message; the tool reply contains a
path/hash/size receipt rather than another copy of that content. References read
as data remain data and are not promoted to system authority.

Required root skills resolved from the pinned persona are loaded deterministically
before the first model turn. The dynamic execution-budget block is appended after
stable persona, skill, runtime-contract, and actor-assignment content. Optional
skills and references retain the existing tool-driven discovery path.

`stage_skill_limit` is a local read/authority budget, not proof of model
context-window exhaustion. Its detail identifies the pinned resource, size and
limit. The former shared 64,000-character artifact/read limit was too small for
the shipped 157,075-character roster; bundle regression tests now ensure all
shipped instructions, skills and declarative references fit their read budget.
These character limits are not token counts. GPT-5.6 Sol supports up to 922,000
input tokens and 128,000 output tokens in its 1,050,000-token context window
([model limits](https://learn.microsoft.com/azure/ai-foundry/openai/how-to/reasoning)).
The model enforces that token window; increasing `SQUAD_MCP_MODEL_MAX_OUTPUT_TOKENS`
changes generation/reasoning allowance, not the skill-read or input-window limit.
Artifact writes, tenant cost/concurrency, active execution and checkpoint storage
limits remain independently enforced. Oversized authority fails explicitly,
never by silently truncating instructions.

External retrieval is deliberately limited to HTTPS `learn.microsoft.com`
documentation, with no credentials, query strings or redirect following, a
15-second fetch timeout and a 1 MB response limit. Long document extracts are
explicitly marked truncated. General web search, other websites and direct
M365 file retrieval are **not** available; missing sources must remain gaps.
BRD stakeholder/lifecycle approval is not inferred from a model tool receipt.

Deploying this code does not turn old saved blocker reports into completed
research, reset failed/complete runs, or release human gates. Inspect the existing
run and preserve its history before agreeing on any recovery/re-execution.
The private research tools need no additional Entra scopes. The human-handoff
protocol below requires the updated Cowork plugin and server together.

#### Model content-policy rejection

A provider HTTP 400 with `ContentFiltered` is distinct from missing runtime
tools or skills. The current backend retains the status and provider code, but
not the provider's category annotations. The generic rejection does not identify
the flagged passage or prove that the brief, rather than other model context,
caused it. Do not log raw provider errors or prompt content to investigate.

On 2026-09-18, the operator approved attaching `hve-prompt-high-20260918` to
the `gpt-5.6-sol` deployment in `venturemaven-foundry-playground`. This policy
copies `Microsoft.DefaultV2` and changes only the **Prompt** thresholds for
Hate, Sexual, Violence and Selfharm from Medium to High. High-severity blocking
remains enabled. Completion filtering, jailbreak detection, protected-material
handling and all other filters were preserved and checked by read-back.
Model/version, SKU/capacity and upgrade settings were also preserved.

This is a model-deployment setting, not a plugin or Container App setting, and
affects every caller of that model deployment. Rollback consists of reattaching
`Microsoft.DefaultV2` without changing the model or capacity. A threshold change
does not establish which filter rejected an earlier request, resolve rejections
from other protections, or replay a failed Squad run. Any controlled retry
requires a separately authorized new run; preserve the failed run's history.

#### Same-run questions and phase confirmations

Top-level persona stages in async `squad_run` and `squad_federate` can invoke
`request_human_input`. The stage stops immediately, before downstream work.
The server stores an encrypted, size-bounded checkpoint containing the tool
conversation, stage position, actor state, evidence receipts and artifact hashes.
`squad_status` returns `held` / `awaiting human input` with `humanInput` containing
the server-generated `questionId`, question, purpose, optional choices and notice.
The private checkpoint and provider reasoning are never exposed to Cowork.

Cowork must display the notice and question verbatim, obtain an explicit answer,
and call `squad_respond` with `runId`, `questionId`, `answer` and, when available,
the bound `projectContext`. This uses **Squad.Run**, not **Squad.Operate**.
The action atomically records the authenticated respondent and timestamp and
queues the **same run**. It does not perform inference. Verify `accepted: true`
and matching IDs before polling. A retry of the same current question/answer
by the same principal preserves the original receipt; a conflicting answer,
stale question, or cross-tenant request is rejected.

If the user cannot answer alone, Cowork leaves the question pending in the
shared OneDrive/SharePoint project and stops the turn. No cancellation,
placeholder answer, or continued polling is necessary. The run remains held
across sessions and restarts until an actual decision is submitted. A different
authorized collaborator in the same tenant may submit the first answer; the
receipt identifies the authenticated submitter, not necessarily the decision's
author. Cowork reloads the shared decision and verifies the current question ID
before submitting it. When present, `expiresAt` in the status response gives the
retention deadline. Expired/missing runs require explicit recovery discussion,
not an automatic replacement or a claim that the old decision was accepted.

An operator approval cannot answer a clarification, and a clarification cannot
release an operator gate. Even a previously operator-approved run is not
claimable while it awaits an answer. Polls remain read-only during that wait.
After an answer, only one worker/poll claims the run. Completed stages are not
replayed; the suspended actor resumes with the answer as data, never authority.
Changed/deleted artifacts or changed loaded skill authority fail explicitly
rather than overwriting evidence or silently restarting.

The shared model/tool budgets survive the handoff, with at most 12 questions.
The active runtime deadline is **per top-level stage**, including all its
delegates. It resets only at the next pipeline stage, not on a delegate or a
human response. New checkpoints retain both cumulative `elapsedMs` and
`stageElapsedMs`; legacy checkpoints without the latter conservatively charge
their saved elapsed time to the resumed stage. A monotonic clock measures active
execution. Existing model/tool/cost ceilings, run TTL, leases and the worker's
35-minute replica timeout are unchanged. Consequently, multiple long stages
still must fit the independently configured worker execution lifetime.
The active runtime deadline excludes time spent waiting for a user or a worker;
the run's configured TTL still applies during that wait. Checkpoints are capped
at 4 MB uncompressed and 4.1 MB compressed before field encryption. The previous
96 KB compressed ceiling could fail after research/planning when the BRD actor
asked a legitimate question; that was a persistence limit, not a model context
window limit.

#### Explicit independent BRD review-only execution

On embedded `squad_run`, supply optional **`review`** separately from `context`:

```json
{
  "kind": "brd",
  "targetPath": ".copilot-tracking/brd/existing-document.md",
  "targetSha256": "<SHA-256 of exact UTF-8 target bytes>",
  "document": { "id": "<actual BRD identity>", "version": "<actual version>", "phase": "Define" },
  "sources": [
    { "path": ".copilot-tracking/evidence/decisions.md", "sha256": "<exact SHA-256>", "content": "<optional complete exact source text>" }
  ]
}
```

Refresh the client's MCP tool schema after installing this server version. This
is a new optional argument, not a new tool, profile, roster member or request
phrase convention. It selects only the registered **BRD Quality Reviewer** even
when the project was previously seeded as `brd`. Without `review`, existing
authoring routes remain unchanged. Review-only mode also omits automatic memory
and run-history injection; the existing versioned task-context packet and its
32,000-character limit are unchanged.

The target must already exist in the same authorized tenant/project artifact
store. A URL is not its content. Each additional source either exists there or
supplies complete inline `content`; inline sources are not installed into or
overwritten in canonical storage. At most 16 sources, 64,000 characters per inline
source, 256,000 serialized manifest characters and 256,000 combined full source
characters are accepted. Hashes, source availability and deterministic preflight
are checked before model dispatch. Metadata is explicitly caller-declared, never
invented; any present target frontmatter id/version/phase must agree. Missing
frontmatter remains assessable as a document-quality finding, not fabricated
author identity. `phase` is explicitly `Define` or `Govern`.

The reviewer cannot write source artifacts, fetch external URLs or delegate.
It reads complete permitted sources, including all pages, then calls
`finish_brd_review` with typed findings/report payloads and genuine evidence IDs.
The server checks schema, document identity, counts, rollups, thresholds and
evidence coverage, and rechecks persisted source hashes before issuing a receipt.
It persists a review Markdown file, JSON-compatible YAML findings/report payloads
and `brd-review-receipt.json` under `.copilot-tracking/reviews/<run-id>/`.
The receipt binds target/source/output hashes and the pinned reviewer charter.
**Execution complete is independent of quality:** `PASS` → `pass`,
`NEEDS_REVIEW` → `revise`, `FAIL` → `blocked`, all valid completed assessments.
Neither quality verdict nor execution completion asserts stakeholder approval.
Malformed/incomplete output, changed source or missing required evidence fails
execution explicitly; no completed receipt is issued. Existing human-input and
operator gates remain in force. Failed historical runs are not silently resumed.

Prompt-free `stage runtime timing` diagnostics contain the run, trusted stage/
actor names, call number, event, active elapsed and remaining stage milliseconds.
Events mark stage/model start/stop and a model-wait heartbeat every 60 seconds;
no prompt, tool arguments/results, reasoning, provider body or credentials are
logged. These diagnostics do not predict provider filtering or guarantee latency.

With the Table backend and `SQUAD_MCP_MEMORY_OVERFLOW_ENABLED=true`, large
run-state fields also use the configured private overflow container. Fields
above 32,000 UTF-16 bytes spill under
`run-state/<tenant>/<run>/<field>/<sha256>`; only a digest/length descriptor
remains in the Table row. The stored field envelope retains its existing
encryption, read-back verifies its length and SHA-256 before decryption, and
Table ETags remain the concurrency authority. Each overflow payload is bounded
at 16 MB. Existing inline and chunked rows remain readable. No SAS or checkpoint
payload is exposed through MCP or mirrored into the project.

Keep overflow enabled on both web and worker after spilling data. Removing it
fails closed on rows with descriptors. Drain active old workers before deploying
this format and update both hosts before admitting new work. After the first
spill, any rollback image must understand the run-state overflow descriptors;
pre-overflow binaries are not safe readers of those records.
A checkpoint that cannot be durably
stored fails with `checkpoint_persistence_failed` rather than returning a
misleading question. Blob writes precede Table CAS, so losing writes and old
versions can leave unreferenced blobs; operators must retain referenced payloads
for the full run retention period and include this private prefix in their
storage lifecycle/cleanup planning. Deleting a run row does not delete blobs.
Delegates/council members do not directly solicit user input: they report gaps
to their parent or in the council verdict. Synchronous specialist calls do not
offer this resumable interface; Cowork continues to enter through `squad_run`.
The protocol records the question and authenticated response, not an independent
attestation of what the client's UI displayed or semantic stakeholder authority.

Offline integration tests run the real pinned cast and skill files through
research, plan/details/critique, council, BRD/quality review, review and handoff
using scripted model responses and durable artifact storage. These prove the
execution plumbing and gates, not factual model quality or a live authenticated
Cowork conversation. Production rollout and live validation are separate steps.

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

Read-only polling reports `run_already_in_flight` while a claim lease is active,
and `queued_for_worker` while waiting for a claim (including an expired lease).
Neither reason requests human approval or proves a deliverable exists.

The live worker gives the shared advisory runtime 30 minutes of active execution,
including delegated research, planning and review. The inline HTTP runtime retains
its 180-second limit: increasing only that limit would exceed the ingress ceiling.
The worker drains one run per scheduled execution, with a 35-minute Job timeout
and a 40-minute claim lease. Keep those bounds ordered (runtime < Job < lease);
otherwise overlapping schedules could reclaim a still-running run. Human waiting
time is excluded, but accumulated active time is preserved across answers.
Model-call, tool-call, cost and artifact guards remain in force. Verify a real
server-produced BRD after enabling the worker; a successful Job exit alone is not
deliverable acceptance.

Each top-level advisory stage has 60 model calls and 160 tool calls, shared with
all its delegated lanes and reviewers. The entire pipeline is capped at 240 model
calls and 640 tool calls, enough for four fully budgeted BRD stages without letting
research consume planning's allowance. Runtime overrides can impose smaller run
or stage ceilings. Model/tool counts do not reset at delegation or human handoff;
only a new top-level stage receives a fresh stage allowance. Legacy checkpoints
without stage counters conservatively charge their saved run usage to the resumed
stage. Deadline, configured cost ceilings, context and artifact limits are unchanged.
Execution-limit failures identify run versus stage scope, actual usage and limit.

Inference uses request-local HTTP settings with 30-minute header/body inactivity
limits, rather than Node fetch's five-minute defaults. The caller's remaining
active-execution deadline still aborts the request (including inline execution).
This does not enlarge model context, change moderation, or extend a run's budget.
Known transport failures retain only their safe error code, such as
`UND_ERR_HEADERS_TIMEOUT`, and are not automatically retried: a dropped connection
does not prove the provider stopped processing the original request.

BRD authoring requests without a profile initialize the focused `brd` roster
(methodology spine, analyst and scribe). The router selects the roster's
`BRD Builder` alternate and schedules it between planning and review, without
unrelated product-profile deliverables or a backlog handoff. Its current draft
must pass the independent BRD Quality Reviewer gate. The BRD is stored in the
run's `brd/` subdirectory, separate from the plan.
An explicit `profile=brd` always schedules that author and review gate, including
follow-up wording such as "Continue from the supplied brief." It does not depend
on repeating a BRD noun and an authoring verb in every request. Without this
invariant, the single-deliverable profile could run only research/plan/review and
complete without ever dispatching the BRD author.
Existing rosters are never silently changed: a BRD request under a roster
without the analyst fails explicitly with `required_deliverable_role_unavailable`.
An operator must obtain approval and update that project's roster before retrying.
The public tool profile selectors include `brd`; existing projects continue to
inherit their persisted roster when the selector is omitted.

An invalid `finish_stage.artifactPaths` receipt returns bounded correction feedback:
the exact missing required paths, required artifacts not written by that actor,
and unowned paths incorrectly listed as outputs. The stage remains incomplete;
the model must correct the receipt or write its missing assigned artifacts and
retry within the existing execution budget. Inputs do not become outputs, and
scope, evidence, structure, durable read-back and independent review checks are
not waived. Explicit blocked outcomes and persistence failures remain terminal.

The independent plan critique receives the plan, phase details, caller input
documents and internal evidence sources actually read by its planning parent.
This exact read allow-list is supplied in the server-owned actor assignment and
cannot expand a restricted parent's scope. It does not grant project-wide
browsing, external retrieval or candidate writes. The critique still writes only
its assigned review and must independently read both candidates. Previously it
could read only the two candidates, contradicting the pinned critique skill's
requirement to assess them against supplied requirements and research.
Out-of-scope reads remain terminal and report the actor, attempted path and
permitted paths; no source content or evidence receipt is released.

Native advisory actors request `tool_choice: required` on every model turn,
including delegates. Their contract requires tool-backed reads/writes and a
verified `finish_stage` receipt; allowing the provider's default optional tool
choice contradicted that contract and could end a stage with plain text.
Ordinary non-runtime completions retain the provider default. Required choice
does not force a particular tool or accept an artifact: blocked/human-input
outcomes, content policy, ownership, evidence and independent review gates remain
unchanged. A provider response without the required receipt still fails closed.

Status projection starts at the persisted run creation timestamp, not the start
of the current HTTP poll. This includes worker artifacts written between polls,
including partial outputs of failed runs. Identity and checkpoint checks still
apply, and the existing 64,000-character projection cap remains in force.
`trackingTruncated` or missing content requires full read-only history retrieval;
an empty/bounded delta is not proof that no artifacts exist. Failed responses
also include bridge receipts and tracking paths in their text machine block for
clients that do not expose `structuredContent`. Mirroring intermediate files
does not make a failed run or an unwritten BRD successful.

For lossless mirroring, discover `squad_history` and use `op=read, offset=0`.
This opt-in form returns a JSON page with exact `content`, UTF-16 `offset` and
`endOffset`, `nextOffset`, full-source UTF-8 `totalBytes` and `sha256`, page
`pageSha256`, `totalChars`, and source `etag`. Continue at `nextOffset` until
it is null; require unchanged source ETag/hash and contiguous ranges across
pages, then verify the assembled UTF-8 byte count and hash before upload.
Preserve BOM, line endings and trailing whitespace. A page never splits a
surrogate pair. `truncated` describes a partial-source page, so the last page
of a multi-page artifact can still have `truncated=true`; completion requires
the final range, null next offset and verified whole-source receipt.
Legacy reads without `offset` remain bounded previews and are not suitable
for copying a truncated artifact. The page JSON is also in the text response
for hosts that discard structured metadata. A small inline result need not
have a local spill file, but copying it is accepted only after its exact bytes
match the server-issued receipt. Re-list actual history when projection is
truncated; its path summary is not a complete artifact inventory.

Research workers may check their assigned lane before creating it. A missing
lane returns `not_created`, not a missing-host-capability error. An in-scope
evidence read before lane creation returns an explicit, retryable
`research_lane_artifact_missing` tool result without releasing evidence or
fetching external content. The worker must create its own lane and retry within
the unchanged shared budgets. Scope violations remain terminal, and research
still cannot complete without a verified delegated artifact.

Canonical research claim labels (`C#`/`X#`) must map to literal tool-issued
evidence receipts (`E#`) in the artifact. When a finish attempt cites retrieved
receipts absent from its persisted primary/lane document, the runtime returns
`missing_artifact_citations` with the exact missing receipts and repair path.
The actor must repair its own document and retry; no successful receipt, sources
sidecar or stage history is issued before the checks pass. Repairs consume the
same call/time/cost budgets. Invented receipts, scope violations, persistence
mismatches and independent-review failures remain terminal.

An absent, in-scope `read_artifact` path returns `unavailable`, `exists: false`,
the exact missing path, and a `list_artifacts` recovery action. It never returns
empty success content or issues an evidence receipt. This supports ordinary
existence checks and correcting a conventional filename to its assigned run
path without abandoning the entire run. Required missing sources must still
be obtained or reported as gaps; evidence and review gates remain unchanged.
Invalid paths, scope violations and storage failures are not recovered this way.

`read_artifact` supports optional UTF-16 `offset` paging for stored artifacts up
to the store's 256,000-character limit. Each page returns at most 64,000 characters,
`nextOffset`, original line numbers, full-source hash and explicit truncation.
Evidence receipts hash only the returned text and record the page range; a
partial read never claims full-document coverage. Invalid offsets return an
explicit correction result without evidence. Lane read scopes, artifact write
limits, cumulative conversation budgets and independent-review gates are unchanged.

Missing or ambiguous pinned-resource lookups likewise return an explicit
`unavailable` / `loaded: false` result with the exact requested relative path.
`list_bundle` discovers skill/instruction entry points; `list_references`
discovers the actual Markdown/declarative files with bounded pagination.
No authority or required-skill credit is installed by a failed lookup.
Missing bundle trees, unsafe paths, disallowed file types and I/O failures
remain terminal. Discovery and correction consume the existing shared budgets.

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

Artifact discovery includes only traversal-safe paths under `.copilot-tracking`,
`docs`, and `outputs`, using the same boundary as artifact reads. Flat memory
records such as `context/bridge`, `state`, and `history/<run>` are retained in the
memory store but excluded from artifact listings, history indexes and agent
discovery. A newly registered project can therefore have a bridge record and no
artifacts. Do not delete or relocate its bridge record to repair a history listing.

Native stage output assignments are server-owned system authority, separate from
untrusted request context. Each actor's `write_artifact` schema advertises only
its own exact paths and run-scoped prefixes. Research parents write their primary
artifact; the lane root is for `delegate_research` workers, not parent writes.
The runtime still validates canonical paths and scope before persistence, even
if a backend ignores the schema. A `stage_write_scope` failure names the actor,
rejected path and allowed scope; use those details to diagnose contract mismatches
without granting broader filesystem access.

For a BRD incident, unit tests and synthetic tool checks are not end-to-end
acceptance. Use an approved authenticated MCP client to call `squad_run` with the
actual authorized source context, poll that same run, and handle any real approval
or human-input request explicitly. Acceptance requires persisted research, plan,
review and BRD artifacts, retrieval of the BRD through `squad_history`, and inspection
of its business objectives, scoped requirements, source traceability, acceptance
criteria and unresolved decisions. A queued/completed status, routing summary,
container health check or hand-written client substitute is insufficient. If
Conditional Access blocks a test client, use an approved client; do not disable
authentication or bypass tenant policy to run the test.

### Optional: let advisory runs proceed unattended (`SQUAD_MCP_ADVISORY_AUTOPILOT_ENABLED`)

`squad_run` holds for operator approval through `squad_approve` or `/admin/approve`.
Use the former for an explicitly human-approved, operator-authorized Cowork
workflow. Without an authorized approval connection, the hold remains; do not
enable autopilot merely to work around missing approval permission.

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

### Optional: run agentic stages on GitHub Copilot (`enableCopilotSandbox`)

A **testing** arrangement that runs tool-enabled stages on the GitHub Copilot
agent runtime instead of the built-in one, so Cowork can exercise Copilot's
model selection, web and file tools, and parallel sub-agents through the same
MCP tools. The runtime runs in a sandbox sidecar; the server keeps project
persistence, evidence, permissions and the GitHub identity. See
`host/sandbox/README.md` for how it works and what it enforces.

Prerequisites: `enableMemory`, `enableMemoryAuto` and `enableArtifacts` set to
`true` (the server refuses to start otherwise), and a GitHub account with a
Copilot seat whose token the server can use.

```bash
# 1. Build the sandbox image (pinned to the Copilot CLI the server's SDK expects).
az acr build --registry "$ACR_NAME" --image "hve-squad-copilot-sandbox:$TAG" \
  --file squad-mcp/host/sandbox/Containerfile squad-mcp/host/sandbox

# 2. Store the GitHub token in the deployment's Key Vault (the app identity reads it).
#    `gh auth token` prints the token of the account signed in to the GitHub CLI.
#    Setting the secret needs a Key Vault data-plane role such as Key Vault Secrets Officer.
az keyvault secret set --vault-name "$KEY_VAULT" --name copilot-github-token \
  --value "$(gh auth token)" --output none

# 3. Rebuild the server image (it now carries the Copilot SDK), then deploy with the sidecar.
az deployment group create \
  --resource-group "$RESOURCE_GROUP" \
  --template-file squad-mcp/host/infra/main.bicep \
  --parameters squad-mcp/host/infra/main.bicepparam \
  --parameters containerImage="$ACR_NAME.azurecr.io/$IMAGE" \
  --parameters containerRegistryServer="$ACR_NAME.azurecr.io" \
  --parameters enableCopilotSandbox=true \
  --parameters copilotSandboxImage="$ACR_NAME.azurecr.io/hve-squad-copilot-sandbox:$TAG"
```

What the deployment adds:

- a `copilot-sandbox` container in the same replica (1 vCPU, 2 GiB), started
  with only a per-deployment connection token. It is reachable from the server
  on loopback (`127.0.0.1:4321`) and never through ingress;
- the server settings `SQUAD_MCP_STAGE_EXECUTOR=copilot`,
  `SQUAD_MCP_COPILOT_CLI_URL`, the connection token, and
  `SQUAD_MCP_COPILOT_GITHUB_TOKEN` from the Key Vault secret
  `copilot-github-token` (read by the app identity; the sandbox never receives
  it);
- a readiness probe on the server's `/readyz`, so the replica receives traffic
  only while the Copilot identity is verified and the sandbox answers; and
- a single replica (`maxReplicas` is forced to 1), because each replica owns
  one sandbox and file-backed session state.

Verify, then test from Cowork:

```bash
# The readiness probe reaches /readyz inside the replica (ACA Easy Auth answers 401 to it from outside).
az containerapp revision list -n "$APP" -g "$RESOURCE_GROUP" \
  --query "[?properties.active].{revision:name, health:properties.healthState, running:properties.runningState}" -o table
az containerapp logs show -n "$APP" -g "$RESOURCE_GROUP" --container hve-squad-mcp --tail 50 | grep -i copilot
```

A `Healthy` revision means the probe passed. The log line
`copilot identity verification {"ready":true,...,"models":N}` confirms the
token; `instance not ready` lines name the failing check. In Cowork, run a
research or planning tool as usual; the stage's `.sources.json` records
`"executor": "copilot-sdk"`, the evidence, and any sub-agent lanes.

Limits of this arrangement:

- **Restart the replica, not one container.** A sandbox serves only the first
  server process that connects to it. If the server container restarts on its
  own, `/readyz` stays 503 and the log says the runtime is still bound to a
  previous server; restart the whole revision with
  `az containerapp revision restart`. Rotating the Key Vault secret restarts
  the replica as a unit.
- **Weaker isolation than a separate sandbox.** The sidecar shares the
  replica's network. The server refuses agent requests to loopback, private
  and metadata addresses, and the sandbox entrypoint strips platform-injected
  identity variables, but a separate sandbox in its own network (which needs a
  VNet-integrated environment) is the production shape.
- **Session state is per replica and lost when the replica restarts.** A stage
  interrupted by a restart starts over instead of resuming.
- **One shared Copilot account.** Quota and attribution are shared, and Copilot
  seats are licensed per person.
- **The background worker is not covered.** Runs driven by `enableWorker`
  keep the built-in runtime. To exercise Copilot from Cowork, deploy with
  `enableWorker=false` (and pause any existing worker Job schedule). A
  `squad_status` poll then claims the run, waits up to 30 seconds, and answers
  `run_already_in_flight` while the run continues inside the replica, so no
  request outlives the 240-second ingress ceiling (which Cowork reports as an
  unreachable connector). A replica restart interrupts that run; the next poll
  after its lease lapses starts it again.

To turn it off, redeploy with `enableCopilotSandbox=false`.


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
  `APP_ID`, and `api://<APP_ID>` as the audience.
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
3. Review the endpoint (https://<mcpFqdn>/mcp), the Entra audience (api://<APP_ID>), and
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
  execution off the status-poll path. The `squadmcp` deployment enables
  `squadmcp-worker` and read-only web polling as of 2026-09-18 (revision 27).
  Other deployments must explicitly enable the optional worker; otherwise the
  180-second inline deadline applies.
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
