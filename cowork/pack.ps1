#requires -Version 7.0

<#
.SYNOPSIS
  Compiles the v1.29 dynamic Microsoft 365 Copilot Cowork + Code plugin into an uploadable .zip.

.DESCRIPTION
  Reads saved deployment parameters from `deploy-output/mcp-deployment.local.json`
  when `-Fqdn` / `-McpServerUrl` / `-OAuthReferenceId` are omitted, validates the
  v1.29 dynamic MCP contract (`hve-project-manager` + `hve-code-implement`, no
  pinned `mcpToolDescription`, one authenticated `remoteMcpServer`), optionally
  updates the local deployment config, and writes `hve-squad-cowork.zip` into
  `deploy-output/` (gitignored).
#>
[CmdletBinding()]
param(
    [string] $Fqdn,
    [string] $McpServerUrl,
    [string] $OAuthReferenceId,
    [string] $TenantId,
    [string] $ResourceClientId,
    [string] $OutputPath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'deploy-output/hve-squad-cowork.zip'),
    [string] $ConfigPath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'deploy-output/mcp-deployment.local.json'),
    [switch] $SaveConfig,
    [switch] $VerifyLive,
    [switch] $AllowPlaceholders
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$outDir = Split-Path -Parent ([IO.Path]::GetFullPath($OutputPath))

$cliArgs = @('scripts/compile-cowork-plugin.ts', '--out-dir', $outDir, '--config', $ConfigPath)
if ($Fqdn) { $cliArgs += @('--fqdn', $Fqdn) }
if ($McpServerUrl) { $cliArgs += @('--mcp-server-url', $McpServerUrl) }
if ($OAuthReferenceId) { $cliArgs += @('--oauth-reference-id', $OAuthReferenceId) }
if ($TenantId) { $cliArgs += @('--tenant-id', $TenantId) }
if ($ResourceClientId) { $cliArgs += @('--resource-client-id', $ResourceClientId) }
if ($SaveConfig) { $cliArgs += '--save-config' }
if ($VerifyLive) { $cliArgs += '--verify-live' }
if ($AllowPlaceholders) { $cliArgs += '--allow-placeholders' }

Push-Location $repoRoot
try {
    & npx tsx @cliArgs
    if ($LASTEXITCODE -ne 0) {
        throw "Cowork plugin compilation failed with exit code $LASTEXITCODE."
    }
    $builtZip = Join-Path $outDir 'hve-squad-cowork.zip'
    $targetZip = [IO.Path]::GetFullPath($OutputPath)
    if ($builtZip -ne $targetZip) {
        Copy-Item -LiteralPath $builtZip -Destination $targetZip -Force
    }
    $size = [math]::Round((Get-Item -LiteralPath $targetZip).Length / 1KB, 1)
    Write-Host "Packed $targetZip ($size KB)."
    Write-Host "Upload it in Cowork: Customize > Plugins > Upload plugin."
}
finally {
    Pop-Location
}
