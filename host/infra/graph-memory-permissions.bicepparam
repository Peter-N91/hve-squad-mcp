using './graph-memory-permissions.bicep'

// Tenant-admin deployment. Apply this ONCE, after main.bicep, when the memory
// broker uses the SharePoint / OneDrive backend (memoryBackend: 'graph').
//
// Replace every <PLACEHOLDER> with your values. No secret belongs here — the
// grants run as the managed identity named by grantIdentityResourceId.

// From the main.bicep outputs.
param appPrincipalId = '<APP_PRINCIPAL_ID>'
param appClientId = '<APP_CLIENT_ID>'

// The site whose document library holds squad memory. Get the id with:
//   az rest --method GET \
//     --url "https://graph.microsoft.com/v1.0/sites/<TENANT>.sharepoint.com:/sites/<SITE_PATH>" \
//     --query id --output tsv
// Leave empty to assign Sites.Selected only; the server then reaches no site.
param sharePointSiteId = '<SHAREPOINT_SITE_ID>'

// A user-assigned managed identity that ALREADY holds AppRoleAssignment.ReadWrite.All
// and Sites.FullControl.All. The deployment script runs as this identity, so the
// high-privilege grant is auditable to one named principal and no credential is
// stored in this template.
param grantIdentityResourceId = '/subscriptions/<SUB_ID>/resourceGroups/<RG>/providers/Microsoft.ManagedIdentity/userAssignedIdentities/<GRANT_IDENTITY>'
