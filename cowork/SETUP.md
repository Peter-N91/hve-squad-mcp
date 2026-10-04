# Connecting the HVE project-management Cowork plugin to your server

The plugin combines an Agent Skill with a connector that discovers tools from
the server's `tools/list` response. It cannot connect until the Entra app, auth
config, and package all agree. Work through these steps in order.

Placeholders used below:

| Placeholder | Meaning |
| --- | --- |
| `<CLIENT_ID>` | Client id of the Entra app that secures the MCP server |
| `<OBJECT_ID>` | That app's **object** id (not the client id) |
| `<FQDN>` | Your Container App host, e.g. `<app-name>.<suffix>.<region>.azurecontainerapps.io` |
| `<APP_ID_URI>` | The Application ID URI the auth config generates in step 2 |
| `<AUTH_CONFIG_ID>` | The auth config id from step 2 — the manifest `referenceId` |

The Microsoft Enterprise Token Store's client id is fixed for every tenant:
`ab3be6b7-f5df-413d-ac2d-abf1e3fd9c0b`.

## Step 1 — authorize the token store on your Entra app

Cowork does not call your server directly. The Enterprise Token Store mints the
token, so your app must accept it as a client and be able to complete consent.

**1a. Pre-authorize the token store.** In the
[Entra admin center](https://entra.microsoft.com/) → your app → **Expose an
API** → **Add a client application**: enter
`ab3be6b7-f5df-413d-ac2d-abf1e3fd9c0b` and select the scopes intended for this
connection; do not grant all users operator permissions.

The project-manager skill requires `Squad.Run`; `squad_status` uses that same
scope. Direct specialist scopes do not substitute for `Squad.Run`, because the
plugin deliberately sends all managed work through the Squad Coordinator.
Same-run explicit human answers use public `squad_respond` with `Squad.Run`;
they do not require or confer operator `Squad.Operate` permission.
Read-only output retrieval through `squad_history` also requires `Squad.Memory`
and an enabled memory/artifact service. It does not require `Squad.MemoryWrite`.
For actual in-Cowork operator approval, expose and admin-consent delegated
`Squad.Operate` for the intended operator connection. Retain it as operator-only;
`Squad.Run` does not confer approval. Include it in the connection's requested
scopes, reconnect/refresh its token, and verify live discovery. A manifest or
ZIP change cannot grant consent. The local simple OAuth issuer cannot mint
operator scope; use the authorized Entra connection or external operator flow.

Prefer the portal here. A Microsoft Graph `PATCH` on `api` replaces the whole
complex property, so a hand-written patch can silently delete your exposed
scopes. If you must script it, read-modify-write the entire `api` object.

**1b. Add the consent redirect URI.** Under **Authentication → Web → Redirect
URIs**, add:

```text
https://teams.microsoft.com/api/platform/v1.0/oAuthConsentRedirect
```

By CLI — read the current list first, because the update **replaces** it:

```powershell
az ad app show --id <CLIENT_ID> --query "web.redirectUris" -o json
```

Then pass every URI you want to keep, plus the new one. Written on one line so it
works in PowerShell and bash alike — a backtick continuation is PowerShell-only,
and in bash it means command substitution, which makes the shell try to execute
each URL:

```text
az ad app update --id <CLIENT_ID> --web-redirect-uris "<existing-1>" "<existing-2>" "https://teams.microsoft.com/api/platform/v1.0/oAuthConsentRedirect"
```

Quote every URI. One of the Copilot Studio redirect URIs ends in `*`, which an
unquoted shell would try to expand as a glob.

## Step 2 — create the Entra SSO auth config

The server validates Entra tokens and implements no Dynamic Client Registration
or OAuth discovery metadata, so the connector needs an explicit auth config.
**Microsoft Entra SSO** is the matching scheme.

Open the [Teams developer portal](https://dev.teams.microsoft.com/tools) →
**Tools → Microsoft Entra SSO client ID registration** → **Register client ID**:

| Field | Value |
| --- | --- |
| Registration name | anything memorable |
| Base URL | `https://<FQDN>/mcp` |
| Client ID | `<CLIENT_ID>` |
| Scope | the scopes you serve, plus `offline_access` for token refresh |
| Restrict usage by org | your tenant |
| Restrict usage by app | **Any Teams app** unless you have a published app id |

Saving returns two values. Keep both:

- the **auth config ID** (labelled *Microsoft Entra SSO registration ID*) → the
  manifest's `referenceId`;
- the **Application ID URI** → step 3.

The `api://...` Application ID URI is not the MCP network endpoint. Keep
`mcpServerUrl` set to the HTTPS Base URL above; the connector uses
`OAuthPluginVault.referenceId` to select the SSO registration. Repackaging with
the same registration ID does not grant permissions or refresh an existing token.

## Step 3 — add the Application ID URI to the app registration

One line, so it works in PowerShell and bash alike:

```text
az ad app update --id <CLIENT_ID> --identifier-uris "api://<CLIENT_ID>" "<APP_ID_URI>"
```

This replaces the list, so pass every URI you want to keep. The Entra portal UI
shows only the first entry — that is a display limit, not data loss. Verify with:

```powershell
az ad app show --id <CLIENT_ID> --query "identifierUris" -o json
```

## Step 4 — check the audience (often nothing to do)

Whether you must touch `SQUAD_MCP_AUDIENCE` depends on one setting:

```powershell
az ad app show --id <CLIENT_ID> --query "api.requestedAccessTokenVersion" -o tsv
```

| Value | Token `aud` | Action |
| --- | --- | --- |
| `2` | the bare client-id GUID, **whichever** identifier URI the scope was requested through | Usually none — the audience does not change when you add an identifier URI |
| `1` or `null` | the identifier URI the client requested | Add `<APP_ID_URI>` to the accepted audiences |

When you do need aliases, `SQUAD_MCP_AUDIENCE` takes a comma-separated list of
audience forms registered on the **same** resource application:

```text
az containerapp update -n <app> -g <rg> --set-env-vars "SQUAD_MCP_AUDIENCE=<CLIENT_ID>,<APP_ID_URI>"
```

Update the ingress too — it rejects before the app is ever reached, and a
mismatch there looks identical to an app-side audience bug:

```text
az containerapp auth update -n <app> -g <rg> --set identityProviders.azureActiveDirectory.validation.allowedAudiences="['api://<CLIENT_ID>','<APP_ID_URI>']"
```

Container Apps' built-in auth also accepts the registered client id implicitly,
which is why a v2 deployment can work even when `allowedAudiences` lists only the
`api://` form.

Never add an audience owned by a different app registration. In particular, the
HVE Microsoft/Cowork production resource
`c98eb224-95c3-42fe-b44f-3fe7a035272a` and the VentureDSMaven test resource
`37283524-358a-4a59-b6f5-1e66efa46151` must not share one deployment. Production
uses only the Microsoft resource with MISE enabled. Venture testing uses a
separate deployment with MISE disabled.

## Step 5 — pack with real values and upload

`pack.ps1` is a PowerShell script, so run it with `pwsh` (this one line works
from bash too):

```text
pwsh -File cowork/pack.ps1 -Fqdn "<FQDN>" -OAuthReferenceId "<AUTH_CONFIG_ID>"
```

If the run prints a placeholder warning, stop — a package carrying placeholders
installs cleanly and then fails on every call with "couldn't complete the
request." Then in Cowork: **Customize → Plugins**, remove the old version, and
**Upload plugin** with `cowork/build/hve-squad-cowork.zip`.

## Step 6 — enable the orchestrator and project context bridge

For pre-model task-context checks, install plugin 11.0.20 (skill 1.21) together
with the corresponding backend preflight update. The
[context selection protocol](skills/hve-project-manager/references/context-preflight.md)
uses the existing string `context` argument, not a new MCP tool. Verify a
blocked preflight reports that no provider call was made. Do not use a live
content-policy replay as an installation smoke test; validate locally first.
Plugin installation alone does not update the backend or intercept Cowork's
internal model context.

The plugin requires the remote `squad_run` pipeline. Keep the selected OneDrive
or SharePoint folder authoritative while enabling that entry point,
tenant/project-partitioned continuity, and the server's `.copilot-tracking`
ledger:

```text
SQUAD_MCP_REMOTE_PIPELINE_ENABLED=true
SQUAD_MCP_RUN_STATE_BACKEND=table
SQUAD_MCP_ENABLE_MEMORY=true
SQUAD_MCP_MEMORY_BACKEND=table
SQUAD_MCP_MEMORY_AUTO_ENABLED=true
SQUAD_MCP_ENABLE_ARTIFACTS=true
SQUAD_MCP_MEMORY_OVERFLOW_ENABLED=true
```

For unattended advisory runs, also set
`SQUAD_MCP_ADVISORY_AUTOPILOT_ENABLED=true`. Otherwise `squad_run` can pause at
its Human Gate until an operator approves it through an authorized channel,
preferably discovered `squad_approve`, or the external operator workflow.

Plugin 11.0.18 / skill 1.19 adds the packaged
`references/stakeholder-library.md` protocol: root `START-HERE.md` and
`library/deliverables.md`, `library/decisions.md`, `library/next-steps.md` provide
stakeholder navigation on both OneDrive and SharePoint. The views link verified
original files, distinguish unapproved drafts from accepted work, and separate
real server questions from review findings and operator blockers. They use the
same conditional-write/user-edit protections as other managed metadata.
Installing the ZIP does not modify existing cloud folders. Request an authorized
navigation-only refresh to create missing pages from the existing checkpoint,
without a new squad run. See [library setup and acceptance checks](README.md#stakeholder-project-library).

It retains the required
`references/artifact-sync.md` protocol after every run/status response, including
queued/running/held/failed runs. Native M365 file capabilities must support exact
full reads, byte hashing, stable ids/eTags, and safe conditional writes; otherwise
the affected synchronization stays pending. The plugin mirrors HVE's persisted
storage structure at exact canonical relative paths, creating artifact parents
only on demand. No generic category scaffold or duplicate tree is created.
Preserve existing folders and mark known category copies as legacy without
deleting, relocating, or multiplying them. `artifact-index.md` consolidates
minimal PM metadata with verified server inventory and links real mirrors and their
partial/unaccepted or verified status. Uploading the package does not backfill
existing folders automatically: resume the known run through read-only
status/history, not a replacement work run. Existing user edits are never
overwritten to force synchronization. See the
[mapping and receipt contract](skills/hve-project-manager/references/artifact-sync.md).

The skill sends an explicit lower-kebab `project` plus a versioned
`projectContext` envelope on the `squad_run` entry call and status polls whose
live schema accepts it. Later-turn polls use the current checkpoint, not the
run's original revision. Choose bridge schema `2` only when the live schema
advertises it; retain schema `1` compatibility otherwise. The local manifest's
schemaVersion remains `2`. Bridge `2` requires actual M365 `provider`, `driveId`,
and `folderItemId` bound to its immutable project UUID. Never fabricate ids or
downgrade to evade binding checks. Display names/slugs are human labels, not
identity. Same-folder renames retain the UUID; copied/new folders get new UUIDs.
Matching GUID/storage on legacy projects preserves history through server mapping;
never regenerate an existing UUID to bypass conflicts.

Verify and save server `ack.project` in `contextBridge.project` before subsequent
polls/history. It is the canonical (typically GUID-derived) partition or a
preserved mapped legacy partition, not necessarily the submitted slug. Read
back that write even if tracking projection is incomplete. The server rejects
identity/storage conflicts and stale revisions, and returns changed tracking
files through `structuredContent.contextBridge.trackingUpdates`. The project
manager persists those results and uses `squad_status` only for the returned
run id. It retrieves referenced files with read-only `squad_history` and
preserves their relative paths in the selected project folder.

### Same-run human questions

When the server returns `held` with reason `awaiting human input`, expect
`humanInput: {questionId, question, purpose, choices?, notice?}`. The question id
is a UUID and purpose is `clarification` or `confirmation`. Cowork displays any
notice and the question verbatim, shows supplied choices, waits for the actual
explicit answer, then saves/reads back the answer bound to run/question/project.
Before presenting, save/read back a minimal bound hold using current identity
and eTag checks; retain bulk artifact mirroring as pending rather than blocking
the question on upload approvals. Do not advance projection acknowledgments.
Discover the host's native selectable-question tool and inspect its live schema.
When it can represent the question/choices losslessly, invoke it, even when asked
to "surface immediately". For an exposed `core-AskUserQuestion` with maximum four
questions and 2-4 label/description options, send only one server question, exact
choice labels, and exact choice text again if descriptions are required. Preserve
the exact caution visibly, and do not invent choices or multi-select permission.
Absent choices, incompatible counts/text/response constraints, or actual tool
unavailability need a concrete recorded/displayed reason for chat fallback;
explicit user preference also permits chat. Convenience does not.
Verify the native card actually appeared; capture its unchanged user-answer
payload and exact selected choice, not merely a prose announcement of options.
It invokes discovered `squad_respond({runId, questionId, answer, projectContext?})`
under `Squad.Run`, verifies `accepted: true`, matching run/question ids and
`respondedAt`/`respondedBy`, saves the receipt, and polls the SAME run.

Verify actual user-visible presentation; loading a notice is not showing it.
Answered records resume only with the same questionId and actual matching receipt.
If the action is missing, blocked, or uncertain, retain the answer honestly as
blocked/unknown; never manufacture an answer, receipt, or phase signoff, start a
replacement run, or substitute operator approval. This does not permit native
code execution/deployment or prove all provider integrations exist.

### Collaboration and deferred answers

The server already holds the run durably until a response; no new deferral action
is required. If the user needs help or time, save the shared pending decision
with unchanged runId/questionId/project identity, awaiting-input/deferred status,
and no answer. Stop polling/model work and tell them they may collaborate and
return later. A deferral is not failure, cancellation, or an answered decision.
Do not submit empty/placeholder answers or "ask later"/"I don't know" unless
explicitly confirmed as the substantive requested decision.

On return by the original user or an authorized collaborator, reload the pending
record and same-run status, verify the current question and project, explicitly
confirm the completed answer, then submit via `squad_respond` and verify its
receipt. Do not require the original user to answer or expand existing tenant/
project permissions. Keep reported decision author separate from authenticated
submitter `respondedBy`; this is not server-verified stakeholder authority.
Use status top-level `expiresAt` in epoch milliseconds when provided, save it
as `collaboration.runExpiresAt`, and show the actual ISO deadline (also rendered
by the server). If absent or invalid, report unknown expiry; do not invent one.
Never promise
indefinite resumption or start a replacement for an expired/unavailable run
without explicit user choice.

### Separate operator approval

Operator choices are surfaced and recorded in Cowork. The plugin saves and reads
back the approval contract, then prefers discovered `squad_approve`. This actual
HTTP MCP tool is exposed only with pipeline enabled and a token containing
`Squad.Operate`. Send UUID `runId` from saved `sourceRunId`, required
`decision: "approve"`, saved UUID `projectId`, and optional local UUID `decisionId`.
Although optional in the input schema, `projectId` MUST match persisted
`projectContext.projectId` for a project-bound run. No claimed approver is sent:
the server uses authenticated tenant/subject. Require `structuredContent` with
`approved: true`, matching run id, `approver`, and `at`; persist optional
`decisionId`. Repeat same-run approvals return the original receipt without new
run/model work. Rejection and ambiguous answers are never approvals.

Missing discovery can mean an old server, disabled pipeline, or missing
permission. Deploy the compatible server separately, ensure admin-consented
delegated `Squad.Operate` on the operator's Entra connection, then reconnect/token
refresh and verify rediscovery. The plugin does not deploy the server, grant
consent, provision an external action, or request credentials in chat. If still
unavailable, retain the verified saved contract as blocked. `POST /admin/approve`
remains an authorized alternative with its own schema; a configured action may
submit saved `sourceRunId` as `runId`. The current status tool polls only.

Never reuse `squad` as the project key; it selects a federation sub-squad.

Start a new Cowork session and ask the HVE project-manager skill to create or
open a project. Confirm that its schema-2 `hve-project.json`, activity record,
first artifact, and `.copilot-tracking/squad/` projection appear in the selected
folder before testing a second session.

## Step 7 — keep the session alive across turns

Two independent timers must both outlast the think-time between turns. Setting
only one of them still breaks a conversation mid-session:

| Setting | Where | What it protects |
| --- | --- | --- |
| `scaleCooldownSeconds` (1800) | `main.local.bicepparam` | Keeps the replica from scaling to zero while the user reads the previous artifact. |
| `sessionIdleSeconds` (1800) → `SQUAD_MCP_SESSION_IDLE_MS` | `main.local.bicepparam` | Keeps the MCP session id valid. Sessions are held in the replica's memory. |

The failure mode when the session timer is too short is easy to misread as a
cold start, but it is the opposite: the app is awake and answering in
milliseconds while rejecting `POST /mcp` with **404 — "Missing or invalid
session; re-initialize."** Cowork surfaces that as every HVE tool disappearing
at once, part-way through a working session.

This is exactly what happened on 2026-08-26: the last good turn was 14:37:37Z
and the next turn at 14:43:44Z was refused 6m07s later, just past the
**5-minute** `DEFAULT_SESSION_IDLE_MS`, even though the 30-minute cooldown had
kept the container running.

To confirm which timer fired, check whether the container was awake at the time
of the failure:

```bash
az monitor log-analytics query --workspace <workspace-guid> --analytics-query \
  'ContainerAppConsoleLogs_CL | where TimeGenerated > ago(1h) | where Log_s has "Request finished" | project TimeGenerated, Log_s | order by TimeGenerated desc'
```

A 404 with millisecond latency means the session expired. No log line at all
means the replica was asleep and it really is a cold start.

Because a session can never outlive the replica holding it, keep
`sessionIdleSeconds` less than or equal to `scaleCooldownSeconds`.

## Cross-tenant alternative (not used by HVE production)

HVE production uses the Microsoft-owned resource registration and trusts only
the Microsoft tenant. The VentureDSMaven registration remains single-tenant in
a separate test deployment with MISE disabled, so its requests cannot be
reported as production MISE telemetry.

If the account you use Cowork with lives in a **different tenant** from the app
registration, sign-in fails before any token is minted:

```text
AADSTS700016: Application with identifier '<CLIENT_ID>' was not found in the
directory '<COWORK_TENANT_ID>'.
```

A single-tenant app (`signInAudience: AzureADMyOrg`) has no service principal in
a foreign directory. There are two walls here, and both must come down.

**Wall 1 — the app must be multi-tenant and provisioned in that directory.**

```text
az ad app update --id <CLIENT_ID> --sign-in-audience AzureADMultipleOrgs
```

Then an administrator **of the Cowork tenant** must consent, which is what
creates the service principal there:

```text
https://login.microsoftonline.com/<COWORK_TENANT_ID>/adminconsent?client_id=<CLIENT_ID>
```

This is a governance step, not a technical one. Consenting an externally
registered app into a managed corporate directory usually goes through that
organization's app-approval process, and may be refused. Nothing else in this
guide can substitute for it.

**Wall 2 — the server must accept that tenant's tokens.** All four values are
plain strings in `main.bicepparam`, and `allowedIssuers` / `allowedTenants`
accept comma-separated lists:

| Setting | Value |
| --- | --- |
| `SQUAD_MCP_ALLOWED_TENANTS` | `<HOME_TENANT>,<COWORK_TENANT>` |
| `SQUAD_MCP_ALLOWED_ISSUERS` | both `https://login.microsoftonline.com/<tenant>/v2.0` |
| `SQUAD_MCP_JWKS_URI` | `https://login.microsoftonline.com/common/discovery/v2.0/keys` |
| ingress `openIdIssuer` | `https://login.microsoftonline.com/common/v2.0` |

The `common` endpoints are what make a multi-tenant deployment possible at all,
and they deliberately widen only the *signature* check. Trust stays bounded by
three allow-lists that are still exact: the issuer list, the `tid` tenant list,
and the audience. Losing any one of those would matter; `common` on its own does
not admit a foreign tenant.

Be aware this weakens the ingress specifically: with `common`, Container Apps
built-in auth no longer binds a tenant, so the app's `allowedTenants` check
becomes the only tenant boundary. That check is enforced server-side and covered
by conformance tests, but it is now load-bearing on its own rather than as
defence-in-depth.

Applying these with `az` **drifts from the Bicep** — a later
`az deployment group create` reverts them. Put the same values in
`main.bicepparam` so the deployment is the source of truth:

```bicep
param authOpenIdIssuer = 'https://login.microsoftonline.com/common/v2.0'
  allowedIssuers: 'https://login.microsoftonline.com/<HOME_TENANT>/v2.0,https://login.microsoftonline.com/<COWORK_TENANT>/v2.0'
  allowedTenants: '<HOME_TENANT>,<COWORK_TENANT>'
  jwksUri: 'https://login.microsoftonline.com/common/discovery/v2.0/keys'
```

**The simpler alternative**, when it is available to you: use Cowork with an
account in the same tenant as the app registration. That needs a Microsoft 365
Copilot licence in that tenant and no changes at all to the app, the server, or
the package.

## Verifying

Run Phase 0 of the test plan in [README.md](README.md). Confirm that the server
receives `initialize`, `tools/list`, and then the expected `tools/call`. The most
common causes of an empty or unavailable tool surface are:

1. The package still carries placeholders.
2. The token store was never pre-authorized (step 1a), so consent cannot complete.
3. The scopes requested in the auth config are not all exposed by the app
   registration. The project-manager skill requires `Squad.Run`; a deployment
   exposing only `Squad.Research`, `Squad.Plan`, `Squad.Review`, and
   `Squad.Architect` is intentionally insufficient.
4. The server returned an invalid `tools/list` descriptor or runtime validation
   rejected a newly added or modified tool.
