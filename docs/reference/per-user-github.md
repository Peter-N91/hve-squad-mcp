---
title: Per-user GitHub on Studio and Cowork
description: Deployment prerequisites, identity boundaries and validation for the opt-in per-user GitHub runtime.
---

# Per-user GitHub on Studio and Cowork

Per-user execution is **off by default**. Keep
`enablePerUserGithub=false` and `stageExecutor='builtin'` to preserve the
existing deployment. Generating a package does not enable a server feature,
provision a tenant or prove that a host accepts an upload.

The first production per-user deployment supports **one Entra tenant only**.
`allowedTenants.length` must be exactly one, and that tenant must match
`linkEntraTenantId`. Browser linking uses a tenant-specific issuer and JWKS;
adding arbitrary tenants to an allowlist does not make that flow multi-tenant.
Both Studio and Cowork use the same resource-tenant `(tid, oid)`. For guests,
`oid` is the guest object's ID in the resource tenant, not their home-tenant ID.
An auth config's **Any Microsoft 365 Organization** reach does not expand this
server-side scope or enable multi-tenant linking.

## Tenant portability and distribution

The source code is reusable across tenants; each deployed per-user server is
deliberately bound to one configured Entra tenant. Installing the npm package or
uploading a host package does not create a Microsoft tenant, provision Azure
resources, register OAuth applications or copy another operator's credentials.
Colleagues testing in another tenant need their own deployment and must complete
the provisioning prerequisites below.

Each installation supplies its own resource and browser-link app registrations,
issuer, tenant, audience/client restrictions, public endpoint, GitHub application,
storage, encryption keys and runtime credentials. Keep the checked-in
`host/infra/main.bicepparam` placeholder-only. Fill a private copy outside the
repository, put secret values in Key Vault, and generate tenant-specific host
packages outside the repository using the generator's strict validation.

A host package generated for one deployment still points to that deployment;
sharing it does not make it an installation in the recipient's tenant. Generate
a new package with the recipient's endpoint and OAuth registration instead.
Choose GitHub App visibility appropriate for the intended test users, and scope
host access, consent and usage-based billing to those users.

Git pushes committed files and history, not Azure CLI sign-in state or live Azure
resources. Nevertheless, tenant IDs, subscription IDs, client/object IDs and
resource endpoints are deployment information and must not be committed to this
public repository. They are not passwords, but they disclose configuration and
can accidentally send users to the wrong deployment. Tokens, private keys,
client secrets, filled-in connection files, browser traces and operator ZIPs
must also remain private.

## Identity and storage boundary

- Both hosts send **inbound delegated Entra tokens**. The verified `(tid, oid)`
  identifies the user. Email, host, `sub` and audience are not owner keys.
- The original tenant remains `authorityTenantId`. Internal storage is partitioned
  by `user-` plus SHA-256 of `JSON.stringify([tid, oid])`. Memory, history,
  resources, project indexes, binary artifacts and run records use that private
  namespace. Run owners retain the raw authority tenant and object ID.
- One person on Studio and Cowork reaches the same namespace, even when the
  hosts have different `sub` claims or use different permitted audience aliases.
  The hosts need not have different audiences. Accept extra aliases only when
  they identify the **same Entra resource app**, never arbitrary unrelated apps.
- This first production mode does not support cross-user project sharing.
  Legacy ownerless records are not adopted. An administrator migrating an older
  deployment must keep the old namespace separate, not relabel it as a user.
- The link broker independently authenticates that same browser user, then obtains
  their GitHub authorization. Tokens, codes and OAuth secrets never belong in
  prompts, package metadata, screenshots or source control.
- **No downstream Entra OBO exchange is implemented.** Inbound SSO and GitHub OAuth
  are separate. Graph memory uses the application's managed identity, not a
  user's delegated OneDrive or SharePoint access. Graph and Graph memory targets
  are disabled in per-user mode; use server-owned Table or durable file storage.

### Link lifetime and cancellation

Every run pins the stable **link generation**, not just the numeric GitHub user
ID. Normal token refresh preserves that generation. Disconnect and relink always
create a new generation, even for the same GitHub account. **Old runs never
silently adopt the new link. Start new work after relinking.**

An identity failure **before execution** leaves the run resumable, subject to
its pinned generation and expiry. A five-minute retry lease prevents a busy
worker loop; a status poll may report `identity_retry_pending`. Restoring the
same valid link can allow a later attempt after that lease. This is not a promise
that every runtime outage is resumable.

Identity loss detected **during execution** aborts the run and fails closed.
Already-started actions are not undone, and there is **no automatic replay**.
Do not restart an aborted run by assuming an outage or reconnect made replay safe.
New per-user async runs have a **seven-day TTL**. Artifact retention is separate;
run expiry is not an artifact-deletion or artifact-access guarantee.

Local unlink takes effect immediately. GitHub-side revocation is a separate
provider operation and can partially fail. The result explicitly reports that
condition with manual revoke guidance. Follow it in GitHub Settings, Applications
for the relevant OAuth or GitHub App authorization, then verify revocation.
Do not interpret a removed local record as proof of provider-side revocation.

Production per-user entitlement verification has **no cache**
(`verifyCacheMs: 0`). Run status asynchronously verifies the exact saved
principal, GitHub account and link generation, not a cached latest-account status.
The session guard rechecks before each model turn, tool action and server command,
and every 15 seconds during an active turn. On each check the token broker reads
the persisted credential source and refreshes it when needed. An authoritative
quota endpoint 401 cannot be overridden by a stale successful models-list result.
A failed guard cancels ongoing execution; this is not an atomic revocation
guarantee and **cannot undo an operation already started**.

### Completing Init and retrieving run output on both hosts

Full upstream `squad_run` pauses for actual Init and can request a human
clarification or confirmation. Poll `squad_status`, show the pending question
unchanged and collect the human's answer. Call `squad_respond` with the saved
`runId`, `questionId` and actual answer, then poll the same run. This lifecycle
uses `Squad.Run`; responding is not operator approval.

Use `squad_history` with `Squad.Memory` to index/list/read persisted artifacts
when memory and artifacts are enabled. Exact text paging uses `offset` and
consistent receipts; binary paging uses `binaryOffset` with byte/hash verification.
`squad_memory_sync` is batch write-back and separately requires `Squad.MemoryWrite`.
Both generated host inventories include these utilities using the live runtime
metadata and scope authority. The generated Studio `/mcp` protocol route supports
their discovery and calls; manual MCP onboarding can also discover them dynamically.
The capability inventory is not a fixed claim about every live enabled surface.

`squad_approve` remains operator-only and is documented separately under
`operatorTools` in the Studio summary manifest. Neither the default Studio
connection nor the Cowork package requests `Squad.Operate`. Approval uses the
separately governed operator channel, never a fabricated human response or
ordinary tool consent.

### Operator-token troubleshooting

Strict per-user authentication accepts a human operator's delegated access token
with `scp` and `oid` plus the assigned `Squad.Operate` app role. An app-only
operator access token must additionally identify itself with `idtyp: 'app'`;
configure the **idtyp optional claim on access tokens** in the relevant Entra
registration, not on ID tokens.

A roles-only, oid-less token without that app-only marker is rejected even if
it contains `Squad.Operate`. ID-token-shaped credentials are also rejected:
an ID token containing roles is not an approval access token. On an operator
authentication failure, verify token type, access-token optional-claim
configuration, delegated claims or app-only marker, role assignment, and the
existing audience/client/tenant restrictions. Never paste full tokens into logs
or chat, enable ID-token acceptance, or add Operate to default host consent to
work around a 401. Token admission does not bypass run ownership or approval
checks. Legacy service-mode authentication remains unchanged.

## Prerequisites before enabling

Complete these in the intended tenant, using private operator files. The committed
examples must remain placeholders. These steps are not executed by generators.

1. **Resource app:** expose every `Squad.*` delegated permission requested in
   `generated/copilot-studio-connector/README.md`, then grant appropriate consent.
   A token must carry delegated `scp`, tenant and object ID. Application roles
   are **not** a substitute. Keep operator approval permissions separate.
2. **Issuer and tenant restrictions:** set `squad.allowedIssuers`,
   `squad.allowedTenants`, `squad.jwksUri`, `authClientId` and
   `authOpenIdIssuer` for the one reviewed tenant. Set exactly one
   `squad.allowedTenants` entry, matching `linkEntraTenantId`. Do not use `common` or
   `organizations` as the browser link tenant. Tenant-specific browser authority
   is `linkEntraTenantId`, and it must match that sole allowed tenant.
3. **Calling clients:** fill `allowedClientsJson` with a nonempty client list
   for **every** accepted audience, even when both hosts share one `aud`.
   Include only reviewed Studio and Cowork clients. The application enforces
   `azp`/`appid`; ACA and application validation accept the same audience set.
   `additionalAudiences` contains only resource-app aliases actually registered
   under that app's `identifierUris`. A decoded token is diagnostic data, not
   validation evidence; do not widen policy to silence a 401.
4. **GitHub registration:** register a GitHub App with user authorization
   (preferred for expiring/refreshable user grants), or the supported OAuth App
   configuration. Users need their own GitHub Copilot access. Set the GitHub
   client ID and server endpoints; store its client secret in Key Vault.
   Configure only the permissions required by the implementation and deployment.
5. **Browser Entra registration:** configure a confidential Web client for the
   link flow and its tenant-specific authority. Store its secret in Key Vault.
   This browser sign-in is an ownership check, not a downstream OBO implementation.
6. **Exact callbacks:** choose one stable public HTTPS origin,
   `publicBaseUrl` with no path. Register:

   | Registration | Exact Web/callback URI |
   | --- | --- |
   | Browser Entra link client | `https://<your-host>/github/link/entra-callback` |
   | GitHub application | `https://<your-host>/github/link/callback` |
   | Studio OAuth client | Exact redirect URL displayed by the saved connector Security page |
   | Cowork resource app | `https://teams.microsoft.com/api/platform/v1.0/oAuthConsentRedirect` |

   Do not interchange these callbacks. Register localhost callbacks separately
   for local-only clients if supported. Never use the production app's secret in
   a local fixture. A custom domain must be bound and verified before using it.
7. **Secrets:** create a 32-byte base64 run/artifact key and an independent
   32-byte base64 GitHub credential/flow key. They must differ. Set
   `runEncryptionKeySecretUri`, `githubLinkKeySecretUri`,
   `githubClientSecretUri`, `linkEntraClientSecretUri` and
   `copilotConnectionTokenSecretUri` to Key Vault secret URIs, preferably pinned
   versions. The user-assigned managed identity needs Key Vault Secrets User on
   each source vault; the template grants it on its own vault only. No secret
   values go into committed parameter files or plaintext container env values.
8. **External runtimes:** provision authenticated, privately reachable headless
   Copilot SDK runtimes and persistent sandbox workspaces. Set `copilotCliUrl`
   for the web process and **distinct** `workerCopilotCliUrl` for the worker.
   One SDK client owns each runtime's session filesystem. A shared endpoint is
   not safe for multiple processes, even with shared Table stores. An identical
   configured endpoint is emitted as empty for the worker so startup fails closed.
   Different aliases of one physical runtime are still unsafe and must not be used.
9. **Durable sessions:** register an existing ACA environment **AzureFile storage
   binding**, then name it in `copilotSessionStorageName`. The template mounts it
   at `copilotSessionStateDir` on web and worker and exports
   `SQUAD_MCP_COPILOT_SESSION_STATE_DIR`. It never creates a share, obtains an
   account key or registers the binding. No storage keys are embedded here.
   An empty binding name fails parameter validation; a nonexistent binding fails
   ACA deployment when the volume is enabled. Do not use an ephemeral directory.
   The external runtime also needs durable workspace/session storage, separately.
10. **Single-owner topology:** the template pins the Copilot web app to **one**
    replica. Run only one active web revision, not two revisions sharing the
    endpoint. The worker has its own endpoint, one replica per execution, no
    retries and an hourly default schedule with a 45-minute execution timeout
    (`workerReplicaTimeoutSeconds=2700`, enforced minimum). The upstream runtime
    deadline is 2,100,000ms (35 minutes) and the server lease is 40 minutes;
    the worker timeout must leave headroom above both.
    Do not overlap scheduled/manual worker executions. A different schedule must
    allow for timeout plus runtime cleanup. Arbitrary multi-replica Copilot
    execution requires separately provisioned per-replica runtimes and is not
    implemented by this template.

Single revision mode prevents a sustained multi-revision topology, but a rolling
deployment can still briefly overlap old and new processes. Drain and stop the old
runtime owner before starting the replacement, or provision a distinct replacement
runtime and switch deliberately. A replica count of one is not an ownership lease.

Copilot web deployments probe `/readyz` every ten seconds. This exercises the SDK
connection during idle periods and removes an unready replica from routing; it is
not just a listening-port check. It does not reset a runtime's filesystem ownership
or replay work. Recover a runtime still bound to a previous client by fully
stopping the old web owner and its runtime, starting a fresh healthy runtime, then
starting the web owner. Independently scaling the web server to zero is not a
paired runtime shutdown; supervised tests with separate runtimes should keep one
web replica active and explicitly stop both components between test sessions.

For a new environment, bootstrap the default deployment first. Read the identity
and vault outputs, grant the operator only the access needed to seed secrets,
populate Key Vault through a private secure channel, register the session binding
on `<prefix>-env`, and verify both external runtime endpoints. Only then redeploy
with per-user features enabled. Do not enable a half-configured revision.

## Production parameter checklist

Copy `host/infra/main.bicepparam` into the operator's private workspace. Set:

| Parameters | Required setting |
| --- | --- |
| `enablePerUserGithub`, `stageExecutor` | `true`, `copilot` |
| `enableRemotePipeline`, `enableWorker` | both `true`; Table run state and background execution |
| `enableMemory`, `memoryBackend`, `enableMemoryAuto`, `enableArtifacts` | `true`, `table`, `true`, `true` |
| `publicBaseUrl`, `githubClientId`, `linkEntraClientId`, `linkEntraTenantId` | registered origin, clients and the sole allowed tenant |
| `githubWebBaseUrl`, `githubApiBaseUrl` | reviewed GitHub host endpoints, default public GitHub |
| `githubLinkTableName`, `githubLinkFlowTableName` | separate shared credential and single-use flow tables |
| `runEncryptionKeySecretUri`, `githubLinkKeySecretUri` | different keys, Key Vault-backed references |
| `githubClientSecretUri`, `linkEntraClientSecretUri` | Key Vault-backed OAuth secret references |
| `copilotCliUrl`, `workerCopilotCliUrl` | distinct authenticated external runtimes |
| `copilotConnectionTokenSecretUri` | runtime control credential, Key Vault-backed |
| `copilotSessionStorageName`, `copilotSessionStateDir` | existing environment binding and durable absolute mount path |
| `copilotModel`, `copilotRouting`, `upstreamRuntimeEnabled` | reviewed model policy; `off` routing preserves fixed/default selection |
| `copilotTools`, `copilotSubagents`, `copilotAllowShell`, `copilotAllowedHosts` | reviewed tool and sandbox network/shell policy |
| `copilotSandboxWorkspace`, `copilotIdentityReverifyMs` | explicit sandbox workspace and entitlement recheck interval |
| `workerReplicaTimeoutSeconds`, `copilotWorkerCron` | at least 2700 seconds; a non-overlapping schedule longer than the timeout plus cleanup |
| `allowedClientsJson`, `additionalAudiences`, `squad` auth fields | complete per-audience client, tenant, issuer and resource policy |

There is **no shared GitHub token fallback** in per-user mode.
`copilotGithubTokenSecretUri` is only for legacy non-per-user Copilot deployments.
The template wires all shared execution/security settings into both web and worker;
only the CLI URL differs by process. The worker also receives the same render
and binary-artifact settings, including the render feature flag, private Blob
container, SAS lifetime and brand-template path, plus the shared storage account.
Thus upstream specialists use the same configured binary destination on either
process; required Blob data permissions are shared through the managed identity.

Credential rotation uses `githubLinkKeyId` for the current key. An optional
`githubLinkOldKeysSecretUri` references a secret holding a JSON object of old
key IDs to base64 keys. This is a secret reference, not JSON to commit.
Keep previous keys available until existing grants are rewritten or explicitly
invalidated and outstanding flows expire. Do not reuse the run encryption key
for any credential key. Key rotation and rollback must preserve decryptability.

The template keeps ingress authentication at **Return401**. Only
`/github/link/start`, `/github/link/entra-callback`, `/github/link/callback` and
`/github/link/confirm` bypass ACA's initial bearer check when the feature is on.
They enforce their own browser ownership, state and CSRF protections. Start GET
is a safe landing page; state-changing actions use the required POST forms.
There is no blanket `AllowAnonymous`, and `/mcp` and admin routes stay protected.

## Studio registration and connection

1. Regenerate `npm run generate:connector`. On private copies, replace the host,
   tenant, **connector client** and **resource client** placeholders. Import the
   Swagger `/mcp` operation with `mcp-streamable-1.0`.
2. Keep `identityProvider: "aad"`, `redirectMode: "Global"`, `IsFirstParty: "False"`
   and the `resourceUri` custom parameter. `aadcertificate` is not this connector's
   auth provider. Supply the secret through the portal, not generated files.
   Save the connector and register its exact displayed redirect URI.
3. Consent the resource-qualified delegated scopes in the generated README
   (plus `offline_access` for connector refresh). Keep scopes aligned with the
   resource app's Expose an API configuration.
4. Configure **end-user credentials** on the agent's tool connection. Never
   select maker-provided/shared credentials. Each test user must establish their
   own connection; otherwise every request would arrive as the maker.
5. Enable generative orchestration and use the generated agent instructions.
   On `github_connection_required`, show the exact `squad_github_connect` browser
   link and stop until the user completes linking. Never request tokens in chat.

Provider schema reference:
[Microsoft PowerPlatformConnectors apiProperties schema](https://github.com/microsoft/PowerPlatformConnectors/blob/dev/schemas/paconn-apiProperties.schema.json).
Tenant consent, redirect acceptance and actual end-user identity still require
live verification; a JSON schema cannot prove them.

## Cowork Entra SSO registration and package

1. Create a Microsoft Entra SSO auth config in Teams developer portal
   (Tools, Microsoft Entra SSO client ID registration), or use Agents Toolkit.
   Supply the secured API base URL, the resource app client ID, the delegated
   scopes listed in `generated/cowork-package/README.md`, and restrict usage to
   the intended organization and app. Keep its auth config ID. Selecting
   **Any Microsoft 365 Organization** does not enable multi-tenant per-user
   execution: the server still accepts only its one configured linking tenant.
2. Add the registration's returned Application ID URI to `identifierUris` on
   that **same resource app**, without removing existing aliases. Add the Cowork
   redirect URI above and authorize the Microsoft Enterprise token store client
   as specified in the official setup guide. Add that calling client to
   `allowedClientsJson` for every audience it actually uses. Add the returned
   audience alias to ACA and application validation using `additionalAudiences`
   only if it is different from the existing audience.
3. Generate in a private operator workspace outside the repository:

   ```powershell
   npm run generate:cowork -- --strict --out-dir ..\hve-cowork-out `
     --mcp-server-url https://<your-host>/mcp --auth-config-id <AUTH_CONFIG_ID> `
     --package-id <STABLE_GUID> --package-version 1.0.0 `
     --website-url https://<your-site>/ `
     --privacy-url https://<your-site>/privacy --terms-url https://<your-site>/terms
   ```

   `OAuthPluginVault.referenceId` is the Entra SSO auth config ID, not a secret.
   The committed package uses operator placeholders and cannot be used as a live
   registration. It contains no tenant data or GitHub client configuration.
4. Upload `hve-squad-cowork.zip` using the target tenant's approved app
   distribution process. Keep the package ID stable and increase the version
   on subsequent uploads. Verify available license, app policy and Cowork
   availability in that tenant. Offline generation does not prove acceptance.

Official instructions:
[Configure Microsoft Entra SSO authentication](https://learn.microsoft.com/microsoft-365/copilot/extensibility/plugin-authentication-entra-sso).

## Validation: local evidence versus live tenant evidence

### Local, no cloud credentials

Run from the repository root. Capture each native command's exit code before
piping or formatting its output; a successful `Tee-Object` is not test success.

```powershell
npm run generate:connector:check
if ($LASTEXITCODE -ne 0) { throw 'Studio output drift' }
npm run generate:cowork:check
if ($LASTEXITCODE -ne 0) { throw 'Cowork output drift' }
node --import tsx --test "test/packaging/**/*.test.ts" "test/connector.test.ts"
if ($LASTEXITCODE -ne 0) { throw 'Packaging tests failed' }
az bicep build --file host\infra\main.bicep --stdout > $null
if ($LASTEXITCODE -ne 0) { throw 'Bicep compile failed' }
az bicep build-params --file host\infra\main.bicepparam --stdout > $null
if ($LASTEXITCODE -ne 0) { throw 'Bicep parameters compile failed' }
```

Packaging tests validate deterministic ZIP/icon bytes, the pinned official 1.28
schema and official Studio OAuth settings schema without network access or skipped
schema tests, safe operator placeholders,
inventory parity and the live optional GitHub tool metadata with injected fakes.
These are not real Entra, GitHub, Azure Storage or SDK calls. Run the runtime
auth/link/isolation suites as part of release verification too.

### Live checklist, required independently on BOTH hosts

- [ ] Preserve the current image digest, ACA revision, private parameter snapshot,
      package version, auth config and encryption key versions for rollback.
      Review the scoped infrastructure diff and what-if in the intended tenant.
- [ ] Verify the session binding exists, mount is writable and survives a real
      restart. Persist a harmless checkpoint at a safe execution boundary, restart
      web, then verify that checkpoint remains readable; repeat for worker using
      its distinct runtime. Verify continuation only where the run state permits
      it, never automatic replay of an aborted turn. Never verify by logging keys.
- [ ] Verify one active web revision/replica, separate runtime endpoint ownership
      for worker, and no overlapping worker executions. Test a worker run longer
      than HTTP ingress allows without keeping a status request open.
- [ ] On Studio verify end-user credentials; on Cowork verify the auth config
      references the reviewed resource app and organization. Capture only
      redacted identity outcomes, never complete tokens.
      A connected authoring connection does not by itself prove that the Preview
      user's runtime binding is ready. If the draft status test shows
      **Connection Required**, use **Set up connection**, select the authorized
      end-user connection and submit it. If it is marked **Stale**, review and
      reauthenticate that connection, then verify **Connected**. Return to Preview
      and retry only the blocked, read-only status call. Do not switch to maker
      credentials, publish the agent, or replay already-started work to resolve
      this setup step.
- [ ] Verify exactly one allowed tenant matching the browser linking tenant.
      Test guests using their resource-tenant object IDs on both hosts, and
      reject home-tenant or unrelated-tenant tokens. Broader auth-config reach
      must not bypass the server's single-tenant restriction.
- [ ] Test Alice and Bob on **each** host. Unlinked execution refuses before work,
      `squad_github_connect` opens a single-use browser flow, mismatched browser
      identity is rejected, and completing authorization enables only that user.
- [ ] Link Alice on one host and use the same `(tid, oid)` on the other: status,
      private project history and approved run ownership are continuous. If
      audiences are identical, test that supported case rather than inventing
      a second audience to match an example.
- [ ] On each host complete a real upstream Init: return the human's answer
      through `squad_respond`, poll the same run and retrieve saved output with
      `squad_history`, using Run+Memory permissions without `Squad.Operate`.
      Verify write-back additionally needs MemoryWrite and operator approval
      remains separate.
- [ ] Bob cannot list/read/poll/approve/download Alice's private runs, resources,
      memory, projects or binary artifacts, even with a guessed identifier.
      Legacy ownerless records remain inaccessible. Missing delegated scope,
      wrong tenant/issuer/audience/client and app-only tokens for normal user
      execution are rejected. Operator access tokens follow the separate rules
      above; role-bearing ID-token-shaped credentials must still fail.
- [ ] Replayed/expired link state, callback errors, missing CSRF, an unsafe Origin
      and unexpected browser sign-in fail closed. A GET cannot mutate a link.
      Confirm `/mcp` without a bearer token still returns 401 at ACA.
- [ ] Verify entitlement failure is actionable, refresh preserves the GitHub
      user identity and link generation, disconnect prevents old grants from
      continuing, and account switching requires explicit browser confirmation.
      Disconnect/relink must reject resuming an old run even for the same GitHub
      numeric ID. A pre-execution identity failure must preserve the eligible run
      with its five-minute retry lease (`identity_retry_pending` when polled),
      without a busy worker loop. Identity loss during execution must abort,
      with no automatic replay or claim to undo started actions. Verify the
      seven-day TTL for new per-user async runs independently of artifact retention.
      Exercise a GitHub revocation failure and its manual revoke guidance.
      Verify held destructive runs still require authorized operator approval.
- [ ] Exercise key rotation with previous keys retained, then an old-version
      rollback. No token, code, secret, complete claim set or key may appear in
      normal logs, generated files, error responses or host chat.
- [ ] Record host/tenant acceptance, consent, callback, two-user isolation,
      restart/resume and rollback evidence privately. Do not mark deployment
      complete on the basis of schema tests alone.

Local quotas are **process-local**, not a durable deployment-wide spend ledger.
The authority tenant cap and a per-user concurrency cap of one are enforced in
each process; each user's cost ceiling is tenant ceiling divided by configured
tenant concurrency. Restart resets counters, and web/worker do not share them.
Table-backed runs do not change that. Put hard global rate/cost controls in a
shared external layer and keep Azure budget alerts as monitoring, not enforcement.

## Rollback

1. Pause new work and disable scheduled/manual worker executions. Drain or
   deliberately hold in-flight runs; do not run old and new web revisions on
   one SDK endpoint at once. Retain encrypted tables, the durable session share
   and all key versions needed for decryption.
   **Drain and stop the worker before changing identity mode.** With per-user
   mode disabled, queued user-owned runs are refused with
   `failureReason: per_user_identity_disabled`, never executed through shared
   credentials. In per-user mode, legacy ownerless queued work is refused with
   `legacy_run_requires_owner_migration`. There is no automatic owner adoption
   or migration. Preserve private records for an explicit operator decision.
   Normal service-owned records remain supported in service mode.
2. Restore the known-good image and compatible private configuration on web and
   worker, including distinct runtime URLs. Revert the Studio connector/agent
   and Cowork package/auth config independently if either host changed.
3. To withdraw the per-user feature, set `enablePerUserGithub=false` and return
   to the reviewed builtin configuration (`stageExecutor='builtin'` unless an
   explicitly approved legacy Copilot setup is being restored). Do not silently
   replace user authorization with a shared maker or GitHub credential.
4. Remove the four callback auth exclusions by redeploying with the feature
   off. Keep `/mcp` protected throughout. Revoke GitHub/Entra grants or rotate
   compromised secrets through their providers as needed; deleting local rows
   alone is not provider-side revocation.
5. Verify on **both** hosts that identity tools disappear when disabled, the
   standard authorized advisory path works, wrong callers are denied, and no
   old per-user records are reassigned or adopted. Preserve key material until
   the retention/migration decision is explicit. Never delete storage as an
   automatic rollback step.
   Verify the worker refuses queued user-owned work in service mode and
   ownerless legacy work in per-user mode with the failure reasons above,
   while ordinary service-owned records still work in service mode.
