# host/infra/environments — per-environment parameter files

`prod.bicepparam` is the parameter file the CI/CD pipeline deploys with. It
commits **no values**. Every tenant-specific, environment-specific, or secret
value is read from an environment variable with `readEnvironmentVariable()`.
`host/infra/main.bicepparam` stays the documented template for local/manual
deploys (copy it to an uncommitted `*.local.bicepparam`).

```bash
# what-if / deploy (the SQUAD_INFRA_* variables are exported first)
az deployment group what-if -g "$RG" --template-file host/infra/main.bicep \
  --parameters host/infra/environments/prod.bicepparam --validation-level ProviderNoRbac
az deployment group create  -g "$RG" --name main --mode Incremental \
  --template-file host/infra/main.bicep --parameters host/infra/environments/prod.bicepparam
```

## Conventions

* **Prefix.** Every variable is named `SQUAD_INFRA_*`. The server's runtime
  variables are `SQUAD_MCP_*`; the template sets those on the container, and
  they are not inputs here.
* **Scalars only.** Every variable holds one string. The pipeline never has to
  build JSON.
* **Lists** are comma-separated. Items are trimmed and empty items dropped
  (`split` + `trim` + `filter`). This covers `SQUAD_INFRA_BUDGET_ALERT_EMAILS`.
  `SquadConfig` list fields such as `SQUAD_INFRA_ALLOWED_MODEL_ENDPOINTS`,
  `SQUAD_INFRA_ALLOWED_ORIGINS`, `SQUAD_INFRA_ALLOWED_ISSUERS`, and
  `SQUAD_INFRA_ALLOWED_TENANTS` are comma-separated strings in the template, so
  they pass through as-is; the server trims each item.
* **Objects** are assembled in the file from scalar variables: the `squad`
  object comes from `SQUAD_INFRA_*` fields, and the single create-mode model
  deployment from `SQUAD_INFRA_OPENAI_DEPLOYMENT_*`.
* **Booleans** are `true` / `false` (case-insensitive). **Integers** are
  decimal. Any other value fails the build with `BCP338 Failed to evaluate parameter "<name>"`.
* **Required** variables have no default. If one is unset, `az bicep build-params`,
  what-if, and deploy fail with
  `BCP427 Environment variable "<NAME>" does not exist and there's no default value set`.
  **Conditionally required** variables fail with a named `fail()` message
  (`BCP338 Failed to evaluate parameter "<param>": <message>`). Every `fail()`
  sits in a parameter expression, because a `fail()` inside a `.bicepparam`
  `var` still fails the build but loses its message.
* **Optional** variables, when unset, pass exactly the default `main.bicep`
  declares. Where `main.bicep`'s default is an expression, the file passes `''`,
  and `main.bicep` treats `''` as "use the default" (`openAiResourceGroupName`,
  `openAiLocation`, `budgetStartDate`). `validate.mjs` step 12b proves this parity.
* **`location`** is not a variable. It follows the target resource group.
* **Do not set a variable to an empty value** to mean "unset" for a variable
  with a non-empty default. Unset it instead.

## Env-var contract

Secret = **yes** means: store it as a GitHub **secret**. Otherwise use a
GitHub **variable**. The table below is the whole contract.

| Variable | Parameter | Required | Default | Secret |
| --- | --- | --- | --- | --- |
| `SQUAD_INFRA_CONTAINER_IMAGE` | `containerImage` | **yes** | — | no |
| `SQUAD_INFRA_CONTAINER_REGISTRY_SERVER` | `containerRegistryServer` | **yes** | — | no |
| `SQUAD_INFRA_ENTRA_CLIENT_ID` | `authClientId` (and default `squad.audience`) | **yes** | — | no |
| `SQUAD_INFRA_ENTRA_TENANT_ID` | default issuer / JWKS / `allowedTenants` | **yes** | — | no |
| `SQUAD_INFRA_BUDGET_ALERT_EMAILS` | `budgetAlertEmails` (CSV → array, ≥ 1) | **yes** | — | no |
| `SQUAD_INFRA_MODEL_ENDPOINT` | `squad.modelEndpoint` | **yes in `existing` mode** | create mode: `https://<account>.openai.azure.com` | no |
| `SQUAD_INFRA_MODEL_DEPLOYMENT` | `squad.modelDeployment` | **yes in `existing` mode** | create mode: `SQUAD_INFRA_OPENAI_DEPLOYMENT_NAME` | no |
| `SQUAD_INFRA_ENTRA_AUTHORITY_HOST` | (derivation) | no | `https://login.microsoftonline.com` | no |
| `SQUAD_INFRA_AUDIENCE` | `squad.audience` | no | `SQUAD_INFRA_ENTRA_CLIENT_ID` (the v2 `aud`) | no |
| `SQUAD_INFRA_AUTH_OPENID_ISSUER` | `authOpenIdIssuer` | no | `<authority>/<tenant>/v2.0` | no |
| `SQUAD_INFRA_ALLOWED_ISSUERS` | `squad.allowedIssuers` | no | `<authority>/<tenant>/v2.0` | no |
| `SQUAD_INFRA_ALLOWED_TENANTS` | `squad.allowedTenants` | no | `SQUAD_INFRA_ENTRA_TENANT_ID` | no |
| `SQUAD_INFRA_JWKS_URI` | `squad.jwksUri` | no | `<authority>/<tenant>/discovery/v2.0/keys` | no |
| `SQUAD_INFRA_ALLOWED_ORIGINS` | `squad.allowedOrigins` (never `*`) | no | `https://copilotstudio.microsoft.com` | no |
| `SQUAD_INFRA_ALLOWED_MODEL_ENDPOINTS` | `squad.allowedModelEndpoints` | no | the effective model endpoint | no |
| `SQUAD_INFRA_MODEL_API_VERSION` | `squad.modelApiVersion` | no | `2024-10-21` | no |
| `SQUAD_INFRA_TENANT_CONCURRENCY` | `squad.tenantConcurrency` | no | `4` | no |
| `SQUAD_INFRA_TENANT_COST_CEILING_USD` | `squad.tenantCostCeilingUsd` | no | `500` | no |
| `SQUAD_INFRA_NAME_PREFIX` | `namePrefix` | no | `squadmcp` | no |
| `SQUAD_INFRA_MIN_REPLICAS` | `minReplicas` | no | `0` | no |
| `SQUAD_INFRA_MAX_REPLICAS` | `maxReplicas` | no | `5` | no |
| `SQUAD_INFRA_LOG_RETENTION_DAYS` | `logRetentionDays` | no | `30` | no |
| `SQUAD_INFRA_BUDGET_AMOUNT_USD` | `budgetAmountUsd` | no | `500` | no |
| `SQUAD_INFRA_BUDGET_START_DATE` | `budgetStartDate` | no — **but pin it after the first deploy** (below) | `''` = first day of the current UTC month | no |
| `SQUAD_INFRA_RUN_ENCRYPTION_KEY_B64` | `runEncryptionKeyBase64` (`@secure()`) | no | `''` (platform-only encryption) | **yes** |
| `SQUAD_INFRA_ENABLE_REMOTE_PIPELINE` | `enableRemotePipeline` | no | `false` | no |
| `SQUAD_INFRA_ENABLE_WORKER` | `enableWorker` | no | `false` | no |
| `SQUAD_INFRA_RUN_TABLE_NAME` | `runTableName` | no | `squadruns` | no |
| `SQUAD_INFRA_WORKER_CRON` | `workerCron` | no | `*/5 * * * *` | no |
| `SQUAD_INFRA_ENABLE_RENDER_PPTX` | `enableRenderPptx` | no | `false` | no |
| `SQUAD_INFRA_RENDER_BLOB_CONTAINER` | `renderBlobContainer` | no | `renders` | no |
| `SQUAD_INFRA_RENDER_SAS_TTL_MINUTES` | `renderSasTtlMinutes` | no | `60` | no |
| `SQUAD_INFRA_RENDER_BRAND_TEMPLATE_PATH` | `renderBrandTemplatePath` | no | `''` | no |
| `SQUAD_INFRA_ENABLE_MEMORY` | `enableMemory` | no | `false` | no |
| `SQUAD_INFRA_MEMORY_BACKEND` | `memoryBackend` (`table`\|`graph`) | no | `table` | no |
| `SQUAD_INFRA_MEMORY_TABLE_NAME` | `memoryTableName` | no | `squadmemory` | no |
| `SQUAD_INFRA_ENABLE_MEMORY_AUTO` | `enableMemoryAuto` | no | `false` | no |
| `SQUAD_INFRA_MEMORY_DEFAULT_PROJECT` | `memoryDefaultProject` | no | `default` | no |
| `SQUAD_INFRA_ENABLE_ARTIFACTS` | `enableArtifacts` | no | `false` | no |
| `SQUAD_INFRA_ENABLE_ADVISORY_AUTOPILOT` | `enableAdvisoryAutopilot` | no | `false` | no |
| `SQUAD_INFRA_MEMORY_GRAPH_DRIVE_ID` | `memoryGraphDriveId` | no | `''` | no |
| `SQUAD_INFRA_MEMORY_GRAPH_ROOT_PATH` | `memoryGraphRootPath` | no | `squad-memory` | no |
| `SQUAD_INFRA_MEMORY_GRAPH_ENDPOINT` | `memoryGraphEndpoint` | no | `''` | no |
| `SQUAD_INFRA_MEMORY_GRAPH_ENCRYPT` | `memoryGraphEncrypt` | no | `false` | no |
| `SQUAD_INFRA_MEMORY_TARGETS` | `memoryTargets` (a JSON **string** param in `main.bicep`, passed through) | no | `''` | no |
| `SQUAD_INFRA_MEMORY_DEFAULT_TARGET` | `memoryDefaultTarget` | no | `''` | no |
| `SQUAD_INFRA_ENABLE_MEMORY_OVERFLOW` | `enableMemoryOverflow` | no | `false` | no |
| `SQUAD_INFRA_MEMORY_OVERFLOW_CONTAINER` | `memoryOverflowContainer` | no | `squadmemory` | no |
| `SQUAD_INFRA_ENABLE_BUSINESS_TOOLS` | `enableBusinessTools` | no | `false` | no |
| `SQUAD_INFRA_CONTAINER_REGISTRY_RESOURCE_ID` | `containerRegistryResourceId` | when `MANAGE_ACR_PULL_ASSIGNMENT=true` (`main.bicep` `fail()`) | `''` | no |
| `SQUAD_INFRA_MANAGE_ACR_PULL_ASSIGNMENT` | `manageAcrPullAssignment` | no | `false` (U4) | no |
| `SQUAD_INFRA_MANAGE_OPENAI_ROLE_ASSIGNMENT` | `manageOpenAiRoleAssignment` | no | `false` (U4) | no |
| `SQUAD_INFRA_OPENAI_MODE` | `openAiMode` (`existing`\|`create`) | no | `existing` (D8) | no |
| `SQUAD_INFRA_OPENAI_ACCOUNT_NAME` | `openAiAccountName` | when create mode or `MANAGE_OPENAI_ROLE_ASSIGNMENT=true` (`main.bicep` `fail()`) | `''` | no |
| `SQUAD_INFRA_OPENAI_RESOURCE_GROUP` | `openAiResourceGroupName` | no | `''` = the app resource group | no |
| `SQUAD_INFRA_OPENAI_LOCATION` | `openAiLocation` | no | `''` = the resource group's location | no |
| `SQUAD_INFRA_OPENAI_SKU` | `openAiSkuName` | no | `S0` | no |
| `SQUAD_INFRA_OPENAI_PUBLIC_NETWORK_ACCESS` | `openAiPublicNetworkAccess` | no | `Enabled` | no |
| `SQUAD_INFRA_OPENAI_DEPLOYMENT_NAME` | `openAiDeployments[0].name` (unset = no deployment) | when create mode (`main.bicep` `fail()`) | `''` | no |
| `SQUAD_INFRA_OPENAI_MODEL_NAME` | `openAiDeployments[0].modelName` | when `…DEPLOYMENT_NAME` is set | — | no |
| `SQUAD_INFRA_OPENAI_MODEL_VERSION` | `openAiDeployments[0].modelVersion` | when `…DEPLOYMENT_NAME` is set | — | no |
| `SQUAD_INFRA_OPENAI_MODEL_FORMAT` | `openAiDeployments[0].modelFormat` | no | `OpenAI` | no |
| `SQUAD_INFRA_OPENAI_DEPLOYMENT_SKU` | `openAiDeployments[0].skuName` | no | `GlobalStandard` (K1) | no |
| `SQUAD_INFRA_OPENAI_DEPLOYMENT_CAPACITY` | `openAiDeployments[0].capacity` | no | `10` (K1) | no |

The contract has 64 variables: 5 always required, 2 required in `existing`
mode, and exactly 1 secret. The file sets every `main.bicep` parameter except
`location` (47 of 48). `validate.mjs` step 12i fails if this table and the file
ever disagree.

## Audience (v2 tokens)

`bootstrap/entra-app.bicep` issues v2 access tokens. Their `aud` claim is the
app's **client id GUID**, not the `api://…` identifier URI, and the server
compares `aud` by exact match (`src/auth/entra.ts` `audienceMatches`). So
`squad.audience` (and the ACA `allowedAudiences`, which are fed from it)
defaults to `SQUAD_INFRA_ENTRA_CLIENT_ID`, and the issuer defaults to
`…/v2.0`.

An environment still on a manually registered v1-token app keeps working. It
sets `SQUAD_INFRA_AUDIENCE=api://<client id>`, the value it already uses.

Clients still *request* scopes against the identifier URI
(`api://<tenantId>/<uniqueName>/Squad.X` for an `entra-app.bicep` app).

## Budget start date

This affects both the first deploy and every later one.

* **Create.** `Microsoft.Consumption/budgets` accepts a past start date on
  create only if it falls in the current grain period. For a Monthly budget
  that means the current month. So the old fixed `'2026-07-01'` fails to create
  a budget in any later month.
* **Update.** Azure rejects **any** change to an existing budget's start date:
  `Start date of budgets cannot be updated. Please delete and create a new budget.`
  ([Azure/bicep#7149](https://github.com/Azure/bicep/issues/7149),
  [Azure/azure-quickstart-templates#7095](https://github.com/Azure/azure-quickstart-templates/issues/7095);
  REST `timePeriod` rules in the Consumption Budgets *Create Or Update*
  reference). Complete mode does not help either.

So the design is:

1. `budgetStartDate` defaults to `''`, which means the first day of the current
   UTC month (`utcNow()`, computed in `modules/budget.bicep`). That is correct
   for the **first** deployment only.
2. Every **later** deployment must pin the start date the budget was created
   with. The pipeline resolves it just before what-if and deploy, and passes it
   in `SQUAD_INFRA_BUDGET_START_DATE`. A full ISO timestamp is accepted and
   truncated to its date:

   ```bash
   BUDGET_ID="/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.Consumption/budgets/${NAME_PREFIX:-squadmcp}-budget"
   export SQUAD_INFRA_BUDGET_START_DATE="$(az resource show --ids "$BUDGET_ID" \
     --query properties.timePeriod.startDate -o tsv 2>/dev/null || true)"
   # empty (budget not created yet) -> current month; otherwise e.g. 2026-07-01T00:00:00Z
   ```

   This read needs only `*/read`, which both `ciPlanIdentity` and
   `ciDeployIdentity` have.
3. `main.bicep` rejects a value that is not `YYYY-MM-01` with a named `fail()`.
4. **Existing environments** first deployed from an earlier `main.bicepparam`
   (`'2026-07-01'`) must pin that date, either with the resolver above or
   explicitly. Otherwise a redeploy sends the current month, and Azure rejects
   the update.
5. **Moving** the start date is a deliberate delete-and-recreate of the budget
   (`az consumption budget delete`, then deploy). It resets alert history. It
   is not something to do from CI.

## Secrets

* `SQUAD_INFRA_RUN_ENCRYPTION_KEY_B64` is the only secret. It must be the base64
  encoding of exactly 32 bytes, or empty. `main.bicep` rejects any other value
  without echoing it, and keeps the parameter `@secure()` end to end.
* `az bicep build-params` writes **resolved values in clear text**. Run the
  placeholder preflight on a build made **without** the secret variable set, and
  never upload a built parameters file as an artifact. `az deployment … --parameters prod.bicepparam`
  compiles in memory, and the value stays a `securestring` in ARM.

## Placeholder preflight (CI)

```bash
az bicep build-params --file host/infra/environments/prod.bicepparam --outfile "$RUNNER_TEMP/prod.parameters.json"
node host/infra/tests/check-no-placeholders.mjs "$RUNNER_TEMP/prod.parameters.json"
```

The script exits `0` when clean, `1` when any `<[A-Z][A-Z0-9_]*>` token remains
(a copied `<PLACEHOLDER>` value), and `2` on bad input. It prints only the JSON
path and the token, never the surrounding value.
