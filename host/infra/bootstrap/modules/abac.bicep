// ABAC condition for every RBAC Administrator grant bootstrap.bicep makes to
// ciDeployIdentity (S4 / security C1 / C2 / AC-A5).
//
// The expression follows the documented Azure "constrain roles and principal
// types" delegation pattern
// (learn.microsoft.com/azure/role-based-access-control/delegate-role-assignments-examples)
// with the council's stricter formulation:
//   * write: RoleDefinitionId  ForAnyOfAnyValues:GuidEquals   {allowed role GUIDs}
//            PrincipalType     ForAnyOfAnyValues:StringEqualsIgnoreCase {'ServicePrincipal'}
//            PrincipalId       ForAnyOfAllValues:GuidNotEquals {ciDeploy, ciPlan}
//   * delete: the same three clauses against the @Resource (existing assignment)
//            attributes, so the delegate can only remove what it could create.
// Both CI principals are excluded, so neither CI identity can grant itself (or
// the other CI identity) any role, and a 6th role, a User/Group principal, or a
// self-assignment are all denied.
//
// The GUID lists are injected with replace() into a fixed template so the literal
// operator/attribute text stays reviewable in one place (U5 sign-off target).

@export()
@description('Build the conditionVersion 2.0 ABAC expression restricting roleAssignments/write and /delete to the given role-definition GUIDs, ServicePrincipal principals, and principals other than the excluded CI identities.')
func rbacAdminCondition(allowedRoleDefinitionGuids string[], excludedPrincipalIds string[]) string =>
  replace(
    replace(
      '((!(ActionMatches{\'Microsoft.Authorization/roleAssignments/write\'})) OR (@Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {__ALLOWED_ROLE_GUIDS__} AND @Request[Microsoft.Authorization/roleAssignments:PrincipalType] ForAnyOfAnyValues:StringEqualsIgnoreCase {\'ServicePrincipal\'} AND @Request[Microsoft.Authorization/roleAssignments:PrincipalId] ForAnyOfAllValues:GuidNotEquals {__EXCLUDED_PRINCIPAL_IDS__})) AND ((!(ActionMatches{\'Microsoft.Authorization/roleAssignments/delete\'})) OR (@Resource[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {__ALLOWED_ROLE_GUIDS__} AND @Resource[Microsoft.Authorization/roleAssignments:PrincipalType] ForAnyOfAnyValues:StringEqualsIgnoreCase {\'ServicePrincipal\'} AND @Resource[Microsoft.Authorization/roleAssignments:PrincipalId] ForAnyOfAllValues:GuidNotEquals {__EXCLUDED_PRINCIPAL_IDS__}))',
      '__ALLOWED_ROLE_GUIDS__',
      join(allowedRoleDefinitionGuids, ', ')
    ),
    '__EXCLUDED_PRINCIPAL_IDS__',
    join(excludedPrincipalIds, ', ')
  )

// Built-in role GUIDs referenced by bootstrap (confirm against the Azure built-in
// roles reference during the U5 review).
@export()
var builtInRoles = {
  contributor: 'b24988ac-6180-42a0-ab88-20f7382dd24c'
  rbacAdministrator: 'f58310d9-a9f6-439a-9e8d-f62e7b41a168'
  keyVaultSecretsUser: '4633458b-17de-408a-b874-0445c86b69e6'
  storageTableDataContributor: '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'
  storageBlobDataContributor: 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
  acrPull: '7f951dda-4ed3-4680-a7ca-43fe172d538d'
  cognitiveServicesOpenAiUser: '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'
}

// The five role GUIDs main.bicep's modules assign to the app identity (S4).
@export()
var appRoleGuids = [
  builtInRoles.keyVaultSecretsUser
  builtInRoles.storageTableDataContributor
  builtInRoles.storageBlobDataContributor
  builtInRoles.acrPull
  builtInRoles.cognitiveServicesOpenAiUser
]
