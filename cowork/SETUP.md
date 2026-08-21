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

By CLI — note this **replaces** the list, so include every existing URI:

```powershell
az ad app update --id <CLIENT_ID> --web-redirect-uris `
  "<existing-uri-1>" "<existing-uri-2>" `
  "https://teams.microsoft.com/api/platform/v1.0/oAuthConsentRedirect"
```

Read the current list first with:

```powershell
az ad app show --id <CLIENT_ID> --query "web.redirectUris" -o json
```

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

```powershell
az ad app update --id <CLIENT_ID> `
  --identifier-uris "api://<CLIENT_ID>" "<APP_ID_URI>"
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

```powershell
az containerapp update -n <app> -g <rg> `
  --set-env-vars "SQUAD_MCP_AUDIENCE=api://<CLIENT_ID>,<APP_ID_URI>"
```

Update the ingress too — it rejects before the app is ever reached, and a
mismatch there looks identical to an app-side audience bug:

```powershell
az containerapp auth update -n <app> -g <rg> `
  --set identityProviders.azureActiveDirectory.validation.allowedAudiences="['api://<CLIENT_ID>','<APP_ID_URI>']"
```

Container Apps' built-in auth also accepts the registered client id implicitly,
which is why a v2 deployment can work even when `allowedAudiences` lists only the
`api://` form.

## Step 5 — pack with real values and upload

```powershell
pwsh -File cowork/pack.ps1 `
  -Fqdn "<FQDN>" `
  -OAuthReferenceId "<AUTH_CONFIG_ID>"
```

If the run prints a placeholder warning, stop — a package carrying placeholders
installs cleanly and then fails on every call with "couldn't complete the
request." Then in Cowork: **Customize → Plugins**, remove the old version, and
**Upload plugin** with `cowork/build/hve-squad-cowork.zip`.

## Verifying

Run Phase 0 of the test plan in [README.md](README.md). If it still fails, the
error text identifies the layer — see *Reading failures* there. The three most
common causes, in order:

1. The package still carries placeholders.
2. The token store was never pre-authorized (step 1a), so consent cannot complete.
3. The scopes requested in the auth config are not all exposed by the app
   registration. A default deployment exposes only `Squad.Research`,
   `Squad.Plan`, `Squad.Review`, and `Squad.Architect`.
