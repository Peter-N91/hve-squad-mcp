using './entra-app.bicep'

// Entra resource-server app registration (U2). Run SEPARATELY from
// bootstrap.bicep, by a human holding the Entra Application Developer role, after
// the named security reviewer's sign-off (U5):
//   az deployment group create --resource-group <RG_YOU_CAN_DEPLOY_TO> \
//     --template-file host/infra/bootstrap/entra-app.bicep \
//     --parameters host/infra/bootstrap/entra-app.bicepparam
// The tenant is the one you are signed in to (tenant()). No secret belongs here:
// the template declares no client secret or certificate.

param displayName = 'hve-squad MCP'

// Tenant-unique, immutable alternate key; the identifier URI becomes
// api://<tenantId>/<uniqueName>.
param uniqueName = 'hve-squad-mcp'

// Your own user object id (az ad signed-in-user show --query id -o tsv) and any
// co-owners, so ownership of the registration is explicit.
param ownerObjectIds = [
  '<OWNER_OBJECT_ID>'
]
