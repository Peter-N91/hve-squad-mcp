// hve-squad MCP — Microsoft Graph permissions for the SharePoint / OneDrive memory
// backend (`memoryBackend: 'graph'` in main.bicep).
//
// Deliberately a SEPARATE deployment from main.bicep. Granting an application
// permission on Microsoft Graph is a tenant-admin action: it needs a principal with
// `AppRoleAssignment.ReadWrite.All` (and, for the per-site half,
// `Sites.FullControl.All`) — far higher privilege than deploying the Container App.
// Keeping it apart means the day-to-day app deployment never requires Graph admin
// rights, and this template is applied once by an administrator.
//
// It performs the two grants the `graph` memory backend needs, in order:
//
//   1. `Sites.Selected` — the Graph APPLICATION permission, assigned to the app's
//      managed identity. On its own this grants access to NO site; it only makes
//      the identity ELIGIBLE for per-site grants. That is exactly why it is the
//      least-privilege choice over `Files.ReadWrite.All` / `Sites.ReadWrite.All`,
//      which would expose every site in the tenant.
//   2. The per-site `write` grant on the ONE site whose document library holds
//      squad memory (`POST /sites/{siteId}/permissions`).
//
// Both are Microsoft Graph data-plane calls with no ARM resource type, so they run
// through a single deployment script authenticated as an operator-supplied managed
// identity — no secret is passed to, or stored by, this template. The script is
// idempotent: it checks for each grant before writing, so re-running the deployment
// is a no-op rather than stacking duplicate assignments.
//
// After this deployment the server can read and write ONLY the designated library.

@description('Azure region for the deployment-script container instance.')
param location string = resourceGroup().location

@description('Short prefix for resource names (match main.bicep).')
@minLength(3)
@maxLength(12)
param namePrefix string = 'squadmcp'

@description('OBJECT (principal) id of the app managed identity — the appPrincipalId output of main.bicep.')
param appPrincipalId string

@description('CLIENT (application) id of the app managed identity — the appClientId output of main.bicep. The per-site grant identifies the app by client id.')
param appClientId string

@description('Display name recorded on the per-site permission so an administrator can see who holds it.')
param appDisplayName string = 'hve-squad-mcp'

@description('Microsoft Graph application role to assign. Defaults to Sites.Selected — the least-privilege choice, which grants no site access by itself.')
param graphAppRoleId string = '883ea226-0bf2-4a8f-9f9d-92c9162a727d'

@description('SharePoint site id (the "hostname,siteCollectionId,siteId" triple returned by GET /sites/{hostname}:/sites/{path}) whose library holds squad memory. Empty assigns Sites.Selected only, leaving the server with access to nothing.')
param sharePointSiteId string = ''

@description('Resource id of a user-assigned managed identity that already holds AppRoleAssignment.ReadWrite.All and Sites.FullControl.All. It runs the grants; this template stores no credential.')
param grantIdentityResourceId string

@description('How long to retain the deployment-script result before Azure cleans it up.')
param scriptRetentionInterval string = 'PT1H'

// Well-known Microsoft Graph application id — identical in every tenant.
var graphAppId = '00000003-0000-0000-c000-000000000000'

resource graphGrants 'Microsoft.Resources/deploymentScripts@2023-08-01' = {
  name: '${namePrefix}-graph-memory-grants'
  location: location
  kind: 'AzureCLI'
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${grantIdentityResourceId}': {}
    }
  }
  properties: {
    azCliVersion: '2.61.0'
    retentionInterval: scriptRetentionInterval
    timeout: 'PT30M'
    cleanupPreference: 'OnSuccess'
    environmentVariables: [
      { name: 'GRAPH_APP_ID', value: graphAppId }
      { name: 'GRAPH_APP_ROLE_ID', value: graphAppRoleId }
      { name: 'APP_PRINCIPAL_ID', value: appPrincipalId }
      { name: 'APP_CLIENT_ID', value: appClientId }
      { name: 'APP_DISPLAY_NAME', value: appDisplayName }
      { name: 'SITE_ID', value: sharePointSiteId }
    ]
    scriptContent: '''
set -euo pipefail
BASE="https://graph.microsoft.com/v1.0"

# 1. Sites.Selected — the app role assignment on the Microsoft Graph service
#    principal. Grants NO site access on its own; it only makes the identity
#    eligible for the per-site grant below.
graph_sp_id=$(az rest --method GET \
  --url "$BASE/servicePrincipals(appId='$GRAPH_APP_ID')" \
  --query id --output tsv)

role_assignment_id=$(az rest --method GET \
  --url "$BASE/servicePrincipals/$APP_PRINCIPAL_ID/appRoleAssignments" \
  --query "value[?appRoleId=='$GRAPH_APP_ROLE_ID' && resourceId=='$graph_sp_id'].id | [0]" \
  --output tsv 2>/dev/null || true)

if [ -n "$role_assignment_id" ] && [ "$role_assignment_id" != "None" ]; then
  echo "App role $GRAPH_APP_ROLE_ID is already assigned (assignment $role_assignment_id)."
  role_created=false
else
  role_assignment_id=$(az rest --method POST \
    --url "$BASE/servicePrincipals/$APP_PRINCIPAL_ID/appRoleAssignments" \
    --headers "Content-Type=application/json" \
    --body "{\"principalId\":\"$APP_PRINCIPAL_ID\",\"resourceId\":\"$graph_sp_id\",\"appRoleId\":\"$GRAPH_APP_ROLE_ID\"}" \
    --query id --output tsv)
  echo "Assigned app role $GRAPH_APP_ROLE_ID (assignment $role_assignment_id)."
  role_created=true
fi

# 2. The per-site write grant. Skipped when no site was designated — in that case
#    Sites.Selected is held but resolves to no accessible site, which is the safe
#    partial state rather than a broad grant.
permission_id=""
site_created=false
if [ -n "$SITE_ID" ]; then
  permission_id=$(az rest --method GET \
    --url "$BASE/sites/$SITE_ID/permissions" \
    --query "value[?grantedToIdentities[?application.id=='$APP_CLIENT_ID']].id | [0]" \
    --output tsv 2>/dev/null || true)

  if [ -n "$permission_id" ] && [ "$permission_id" != "None" ]; then
    echo "Site $SITE_ID already grants $APP_DISPLAY_NAME (permission $permission_id)."
  else
    body="{\"roles\":[\"write\"],\"grantedToIdentities\":[{\"application\":{\"id\":\"$APP_CLIENT_ID\",\"displayName\":\"$APP_DISPLAY_NAME\"}}]}"
    permission_id=$(az rest --method POST \
      --url "$BASE/sites/$SITE_ID/permissions" \
      --headers "Content-Type=application/json" \
      --body "$body" --query id --output tsv)
    echo "Granted write on site $SITE_ID to $APP_DISPLAY_NAME (permission $permission_id)."
    site_created=true
  fi
else
  echo "No sharePointSiteId supplied: Sites.Selected assigned, but no site is reachable yet."
fi

cat > "$AZ_SCRIPTS_OUTPUT_PATH" <<JSON
{
  "appRoleAssignmentId": "$role_assignment_id",
  "appRoleAssignmentCreated": "$role_created",
  "sitePermissionId": "$permission_id",
  "sitePermissionCreated": "$site_created"
}
JSON
'''
  }
}

@description('The Microsoft Graph app role assignment id held by the app identity.')
output appRoleAssignmentId string = graphGrants.properties.outputs.appRoleAssignmentId

@description('The site permission id, or empty when no sharePointSiteId was supplied (the server can then reach no site).')
output sitePermissionId string = graphGrants.properties.outputs.sitePermissionId

@description('False when Sites.Selected was assigned but no site was designated — the server holds an eligible identity with nothing to read or write.')
output siteGrantApplied bool = !empty(sharePointSiteId)
