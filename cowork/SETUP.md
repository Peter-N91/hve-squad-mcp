# Connecting the Cowork plugin to your server

The plugin installs with placeholder values but cannot connect until the Entra
app, the auth config, and the package all agree. Work through these in order.

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
`ab3be6b7-f5df-413d-ac2d-abf1e3fd9c0b` and tick every scope you serve.

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

When you do need to add it, `SQUAD_MCP_AUDIENCE` takes a comma-separated list so
the Copilot Studio connector keeps working:

```text
az containerapp update -n <app> -g <rg> --set-env-vars "SQUAD_MCP_AUDIENCE=api://<CLIENT_ID>,<APP_ID_URI>"
```

Update the ingress too — it rejects before the app is ever reached, and a
mismatch there looks identical to an app-side audience bug:

```text
az containerapp auth update -n <app> -g <rg> --set identityProviders.azureActiveDirectory.validation.allowedAudiences="['api://<CLIENT_ID>','<APP_ID_URI>']"
```

Container Apps' built-in auth also accepts the registered client id implicitly,
which is why a v2 deployment can work even when `allowedAudiences` lists only the
`api://` form.

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

## Cross-tenant: the Cowork user is in a different directory

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

Run Phase 0 of the test plan in [README.md](README.md). If it still fails, the
error text identifies the layer — see *Reading failures* there. The three most
common causes, in order:

1. The package still carries placeholders.
2. The token store was never pre-authorized (step 1a), so consent cannot complete.
3. The scopes requested in the auth config are not all exposed by the app
   registration. A default deployment exposes only `Squad.Research`,
   `Squad.Plan`, `Squad.Review`, and `Squad.Architect`.
