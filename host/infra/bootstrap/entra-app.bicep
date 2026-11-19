// hve-squad MCP server — Entra resource-server app registration (RUNBOOK Step 2 as
// IaC), a SEPARATE deployment from bootstrap.bicep (U2).
//
// WHO RUNS IT (U2 / security C7): a human holding the Entra **Application
// Developer** directory role (enough to create an app registration + service
// principal they own; with the Graph extension the deployment calls Microsoft
// Graph on that user's behalf). The person who applies bootstrap.bicep
// (subscription Owner / UAA) is deliberately NOT required here. The runner also
// needs `Microsoft.Resources/deployments/*` on the resource group the deployment
// record is written to (e.g. `az deployment group create -g <any RG they can
// deploy to>`); no Azure resource is created. U5: the named security reviewer
// signs off on this definition before the first live run.
//
// Security properties (S8 / security C6):
//   * uniqueName set — the idempotent upsert key for the Graph extension.
//   * identifierUris = api://<tenantId>/<uniqueName>: valid under Entra's default
//     app-ID-URI policy and never self-references the not-yet-assigned appId.
//   * api.requestedAccessTokenVersion = 2 (v2 tokens; issuer
//     https://login.microsoftonline.com/<tenant>/v2.0 as main.bicepparam expects).
//     NOTE: a v2 access token's `aud` is the appId GUID, not the identifier URI,
//     and the server's audience check is an exact match — so squad.audience and
//     the ACA allowedAudiences must be the `tokenAudience` output (the appId).
//   * Every delegated scope declared unconditionally; Squad.Run, Squad.Federate,
//     Squad.MemoryWrite, Squad.Backlog are Admin-consent only.
//   * Squad.Operate app role: allowedMemberTypes ['User'] only (a human operator).
//   * No passwordCredentials / keyCredentials: the server validates tokens; it
//     never authenticates as this app.
//   * A servicePrincipal is declared for the application.
//
// STAYS MANUAL: tenant-admin consent (for the four Admin scopes and for Copilot
// Studio's connector), assigning Squad.Operate to operators, and pre-authorizing
// client applications.
//
// ADOPTION: new-tenant / new-app only. A manually created registration has no
// uniqueName and Microsoft Graph cannot add one later, so this template cannot
// adopt it. Migrating = run this template (a NEW app), repoint
// squad.audience / authClientId / allowedAudiences at its outputs, redeploy
// main.bicep, then retire the old app.

extension microsoftGraphV1

@description('Display name of the app registration.')
param displayName string = 'hve-squad MCP'

@description('Stable, tenant-unique alternate key for the app (the Graph upsert key). Lower-kebab-case.')
@minLength(3)
@maxLength(64)
param uniqueName string = 'hve-squad-mcp'

@description('Object ids of additional owners (users). The Application Developer who runs the deployment should be listed so ownership is explicit.')
param ownerObjectIds string[] = []

var identifierUri = 'api://${tenant().tenantId}/${uniqueName}'

// Deterministic scope/role ids so re-running the template never rotates them.
var delegatedScopes = [
  { value: 'Squad.Research', type: 'User', grants: 'invoke squad_research' }
  { value: 'Squad.Plan', type: 'User', grants: 'invoke squad_plan' }
  { value: 'Squad.Review', type: 'User', grants: 'invoke squad_review' }
  { value: 'Squad.Architect', type: 'User', grants: 'invoke squad_architect' }
  { value: 'Squad.Run', type: 'Admin', grants: 'invoke squad_run and poll squad_status' }
  { value: 'Squad.Federate', type: 'Admin', grants: 'invoke squad_federate (the federation meta layer)' }
  { value: 'Squad.Render', type: 'User', grants: 'invoke squad_render_pptx' }
  { value: 'Squad.Memory', type: 'User', grants: 'read squad memory' }
  { value: 'Squad.MemoryWrite', type: 'Admin', grants: 'write squad memory (compare-and-swap write / batch flush)' }
  { value: 'Squad.Business', type: 'User', grants: 'invoke squad_business_plan' }
  { value: 'Squad.Backlog', type: 'Admin', grants: 'invoke squad_backlog' }
]

resource app 'Microsoft.Graph/applications@v1.0' = {
  uniqueName: uniqueName
  displayName: displayName
  signInAudience: 'AzureADMyOrg'
  identifierUris: [
    identifierUri
  ]
  api: {
    requestedAccessTokenVersion: 2
    oauth2PermissionScopes: [
      for scope in delegatedScopes: {
        id: guid(uniqueName, 'scope', scope.value)
        value: scope.value
        type: scope.type
        isEnabled: true
        adminConsentDisplayName: scope.value
        adminConsentDescription: 'Allows the client to ${scope.grants} on the hve-squad MCP server on behalf of the signed-in user.'
        userConsentDisplayName: scope.type == 'User' ? scope.value : null
        userConsentDescription: scope.type == 'User' ? 'Allows the app to ${scope.grants} on the hve-squad MCP server on your behalf.' : null
      }
    ]
  }
  appRoles: [
    {
      id: guid(uniqueName, 'appRole', 'Squad.Operate')
      value: 'Squad.Operate'
      displayName: 'Squad.Operate'
      description: 'Authorizes the out-of-band operator approval route (POST /admin/approve).'
      allowedMemberTypes: [
        'User'
      ]
      isEnabled: true
    }
  ]
  owners: {
    relationships: ownerObjectIds
  }
}

resource servicePrincipal 'Microsoft.Graph/servicePrincipals@v1.0' = {
  appId: app.appId
}

@description('Application (client) id — use for authClientId.')
output appId string = app.appId

@description('The v2 access-token audience (aud claim) — with requestedAccessTokenVersion 2 Entra puts the appId GUID in aud, NOT the identifier URI. Use this for squad.audience (SQUAD_MCP_AUDIENCE, exact match) and hence the ACA allowedAudiences.')
output tokenAudience string = app.appId

@description('The identifier URI — the prefix clients use when requesting scopes, e.g. <identifierUri>/Squad.Research.')
output identifierUri string = identifierUri

@description('Service principal object id.')
output servicePrincipalId string = servicePrincipal.id
