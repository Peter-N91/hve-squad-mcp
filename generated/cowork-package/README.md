# Copilot Cowork package (generated)

Regenerate with `npm run generate:cowork`. Never hand-edit the package.

Manifest 1.28, 192x192 color and 32x32 outline icons, a skill, a tools/list-shaped
inventory and a deterministic stored-entry ZIP. The inventory includes optional capabilities;
live tools/list is authoritative. Per-user GitHub, pipeline, memory, render and business tools
require operator flags and are off by default. Remaining utility input schemas are minimal; live schemas govern.

Run lifecycle utilities squad_respond and squad_history share the runtime's exact metadata/schemas;
squad_respond answers actual Init/clarification on the same run (Squad.Run), never approval.
squad_history retrieves persisted artifacts (Squad.Memory); squad_memory_sync is a separate
batch write (Squad.MemoryWrite). Operator squad_approve is documented separately in the Studio
manifest's operatorTools; it is not in this normal inventory or requested scopes.

## Authentication

`OAuthPluginVault.referenceId` is an operator-registered Microsoft Entra SSO auth config ID.
Register the resource app and auth config in the target tenant, configure its returned Application ID URI
as an alias of that SAME resource app, and grant delegated scopes:

- `api://<SQUAD_RESOURCE_CLIENT_ID>/Squad.Research`
- `api://<SQUAD_RESOURCE_CLIENT_ID>/Squad.Plan`
- `api://<SQUAD_RESOURCE_CLIENT_ID>/Squad.Review`
- `api://<SQUAD_RESOURCE_CLIENT_ID>/Squad.Architect`
- `api://<SQUAD_RESOURCE_CLIENT_ID>/Squad.Run`
- `api://<SQUAD_RESOURCE_CLIENT_ID>/Squad.Federate`
- `api://<SQUAD_RESOURCE_CLIENT_ID>/Squad.Render`
- `api://<SQUAD_RESOURCE_CLIENT_ID>/Squad.Memory`
- `api://<SQUAD_RESOURCE_CLIENT_ID>/Squad.MemoryWrite`
- `api://<SQUAD_RESOURCE_CLIENT_ID>/Squad.Business`
- `api://<SQUAD_RESOURCE_CLIENT_ID>/Squad.Backlog`

Both hosts identify the same user by validated `(tid, oid)`. They need not have different `aud` values.
First production per-user scope is one Entra tenant: exactly one allowed tenant matching the
browser linking tenant. Guests use the resource-tenant oid. An auth config's Any Microsoft 365
Organization reach does not enable multi-tenant linking or override the server's restriction.
If different aliases are used, authorize clients for EVERY audience and configure both ACA and the app.
App roles cannot replace delegated scopes. This is inbound SSO, not downstream Entra OBO.
GitHub OAuth is separate; no GitHub app material or credentials belongs in this package.

Runs pin a stable link generation preserved by normal token refresh.
Pre-execution identity failures leave eligible runs resumable under a five-minute retry lease;
polls may report `identity_retry_pending`. The worker does not busy-loop.
Identity loss during execution aborts with no automatic replay and cannot undo started actions.
Not every runtime outage is resumable. New per-user async runs have a seven-day TTL;
artifact retention is separate. Disconnect/relink never transfers an old run to the new link.
After relinking start new work, even with the same GitHub account. Local unlink is immediate;
if provider revocation fails, follow the returned manual GitHub revoke guidance.

## Operator output

Committed values are placeholders and cannot be uploaded as a live deployment. Generate in a private
workspace OUTSIDE this repository, using all flags below and `--strict`:

```powershell
npm run generate:cowork -- --strict --out-dir ..\hve-cowork-out `
  --mcp-server-url https://<your-host>/mcp --auth-config-id <AUTH_CONFIG_ID> `
  --package-id <GUID> --website-url https://<your-site>/ `
  --privacy-url https://<your-site>/privacy --terms-url https://<your-site>/terms
```

Flags also accept HVE_COWORK_MCP_SERVER_URL, HVE_COWORK_AUTH_CONFIG_ID, HVE_COWORK_PACKAGE_ID,
HVE_COWORK_PACKAGE_VERSION, HVE_COWORK_WEBSITE_URL, HVE_COWORK_PRIVACY_URL and HVE_COWORK_TERMS_URL.
Keep the package GUID stable; increase its version for uploads. CLI flags take precedence over environment.

## Verification

`npm run generate:cowork:check` and `node --import tsx --test "test/packaging/**/*.test.ts"`
verify deterministic bytes, inventory parity and the pinned official 1.28 schema offline.
They do NOT prove tenant upload, consent, token exchange or user isolation in a deployed tenant.
See `docs/reference/per-user-github.md` and `host/RUNBOOK.md` for exact live checks and rollback.
Official setup: https://learn.microsoft.com/microsoft-365/copilot/extensibility/plugin-authentication-entra-sso
