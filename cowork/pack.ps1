<#
.SYNOPSIS
  Packs the connector-only Cowork plugin into an uploadable .zip.

.DESCRIPTION
  Run `npm run generate:cowork` first. It validates the v1.29 dynamic MCP
  contract: no Agent Skills, no pinned mcpToolDescription, and one authenticated
  remoteMcpServer. This script substitutes tenant values and packages the
  manifest plus icons.
#>
[CmdletBinding()]
param(
    [string] $Fqdn,
    [string] $OAuthReferenceId,
    [string] $OutputPath = "$PSScriptRoot/build/hve-squad-cowork.zip"
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$required = @('manifest.json', 'color.png', 'outline.png')

foreach ($item in $required) {
    if (-not (Test-Path (Join-Path $root $item))) {
        throw "Missing '$item'. Run 'npm run generate:cowork' first."
    }
}

$staging = Join-Path ([System.IO.Path]::GetTempPath()) "cowork-pack-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $staging -Force | Out-Null

try {
    foreach ($item in $required) {
        Copy-Item -Path (Join-Path $root $item) -Destination $staging -Force
    }

    $manifestPath = Join-Path $staging 'manifest.json'
    $manifest = Get-Content $manifestPath -Raw

    if ($Fqdn) {
        $manifest = $manifest.Replace('<CONTAINER_APP_FQDN>', $Fqdn.Trim())
    }
    if ($OAuthReferenceId) {
        $manifest = $manifest.Replace('<OAUTH_CLIENT_REGISTRATION_ID>', $OAuthReferenceId.Trim())
    }

    $remaining = [regex]::Matches($manifest, '<[A-Z_]+>') | ForEach-Object { $_.Value } | Sort-Object -Unique
    if ($remaining) {
        Write-Warning "Placeholders left in manifest.json: $($remaining -join ', '). The package will upload but the connector will not authenticate."
    }

    $declared = $manifest | ConvertFrom-Json
    if ($declared.manifestVersion -ne '1.29') {
        throw "Dynamic MCP discovery requires manifestVersion 1.29."
    }
    if ($null -ne $declared.agentSkills) {
        throw "The dynamic Cowork package must not declare agentSkills."
    }
    foreach ($connector in @($declared.agentConnectors)) {
        if ($null -ne $connector.toolSource.remoteMcpServer.mcpToolDescription) {
            throw "Dynamic MCP discovery requires mcpToolDescription to be omitted."
        }
    }

    Set-Content -Path $manifestPath -Value $manifest -NoNewline

    $outDir = Split-Path -Parent $OutputPath
    if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }
    if (Test-Path $OutputPath) { Remove-Item $OutputPath -Force }

    Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $OutputPath -Force

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead((Resolve-Path $OutputPath))
    try {
        $entries = $zip.Entries | ForEach-Object { $_.FullName }
        foreach ($item in $required) {
            if ($entries -notcontains $item) {
                throw "Required archive entry '$item' is missing."
            }
        }
    }
    finally {
        $zip.Dispose()
    }

    $size = [math]::Round((Get-Item $OutputPath).Length / 1KB, 1)
    Write-Host "Packed $OutputPath ($size KB)."
    Write-Host "Verified connector-only package; Cowork discovers tools at runtime."
    Write-Host "Upload it in Cowork: Customize > Plugins > Upload plugin."
}
finally {
    Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue
}
