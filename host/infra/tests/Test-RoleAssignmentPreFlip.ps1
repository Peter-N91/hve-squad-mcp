<#
.SYNOPSIS
  AC-A13 / U4 pre-flip check: confirm no manually-created AcrPull or Cognitive
  Services OpenAI User assignment for the app identity still exists before you
  set manageAcrPullAssignment / manageOpenAiRoleAssignment to true.

.DESCRIPTION
  READ-ONLY. Runs `az role assignment list` only; it never creates or deletes an
  assignment. Run it as an operator (not from CI) after `az login`.

  Why: main.bicep names its role assignments deterministically with guid(). A
  hand-made assignment for the same principal + role + scope has a different
  name, so flipping the flag while it exists fails the deployment with
  RoleAssignmentExists (409). Migration order (RUNBOOK):
    1. run this script; 2. delete each listed manual assignment
    (az role assignment delete --ids <id>); 3. re-run this script until it
    reports none; 4. flip the flag in your .bicepparam; 5. redeploy.

  Exit code 0 = safe to flip; 1 = a conflicting assignment exists; 2 = bad input.

.EXAMPLE
  ./Test-RoleAssignmentPreFlip.ps1 -AppPrincipalId <appPrincipalId output> `
    -ContainerRegistryResourceId /subscriptions/.../registries/<acr> `
    -OpenAiAccountResourceId /subscriptions/.../accounts/<aoai>
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $AppPrincipalId,
  [string] $ContainerRegistryResourceId = '',
  [string] $OpenAiAccountResourceId = ''
)

$ErrorActionPreference = 'Stop'
$checks = @()
if ($ContainerRegistryResourceId) { $checks += @{ Flag = 'manageAcrPullAssignment'; Role = '7f951dda-4ed3-4680-a7ca-43fe172d538d'; Scope = $ContainerRegistryResourceId } }
if ($OpenAiAccountResourceId) { $checks += @{ Flag = 'manageOpenAiRoleAssignment'; Role = '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'; Scope = $OpenAiAccountResourceId } }
if (-not $checks) { Write-Error 'Pass -ContainerRegistryResourceId and/or -OpenAiAccountResourceId.'; exit 2 }

$conflict = $false
foreach ($c in $checks) {
  $json = az role assignment list --assignee $AppPrincipalId --role $c.Role --scope $c.Scope --output json
  if ($LASTEXITCODE -ne 0) { Write-Error "az role assignment list failed for $($c.Scope)"; exit 2 }
  $found = @($json | ConvertFrom-Json | Where-Object { $_.scope -ieq $c.Scope })
  if ($found.Count -eq 0) {
    Write-Host "OK   $($c.Flag): no existing assignment at $($c.Scope) — safe to flip."
  } else {
    $conflict = $true
    foreach ($a in $found) { Write-Host "HOLD $($c.Flag): existing assignment $($a.id) (created $($a.createdOn)) — delete it before flipping." }
  }
}
exit ([int]$conflict)
