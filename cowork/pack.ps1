<#
.SYNOPSIS
  Packs the Cowork plugin into an uploadable .zip.

.DESCRIPTION
  Run `npm run generate:cowork` first — it emits tools/hve-squad-tools.json from
  tools.catalog.yml and validates the package against the Agent Skills rules
  Cowork enforces at upload. This script only zips what that produced.

  The .zip is written to cowork/build/ and is git-ignored: it carries whatever
  tenant values you substituted into manifest.json.
#>
[CmdletBinding()]
param(
    # The MCP server host, e.g. "squad.happysea-1234.westeurope.azurecontainerapps.io".
    [string] $Fqdn,
    # The OAuth client registration id from the Enterprise Token Store.
    [string] $OAuthReferenceId,
    [string] $OutputPath = "$PSScriptRoot/build/hve-squad-cowork.zip"
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

$required = @('manifest.json', 'color.png', 'outline.png', 'tools', 'skills')
foreach ($item in $required) {
    if (-not (Test-Path (Join-Path $root $item))) {
        throw "Missing '$item'. Run 'npm run generate:cowork' first."
    }
}

$staging = Join-Path ([System.IO.Path]::GetTempPath()) "cowork-pack-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $staging -Force | Out-Null

try {
    foreach ($item in $required) {
        Copy-Item -Path (Join-Path $root $item) -Destination $staging -Recurse -Force
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

    Set-Content -Path $manifestPath -Value $manifest -NoNewline

    $outDir = Split-Path -Parent $OutputPath
    if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }
    if (Test-Path $OutputPath) { Remove-Item $OutputPath -Force }

    Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $OutputPath -Force

    # Verify every manifest-declared path resolves to a real archive entry.
    # The publish service matches these LITERALLY against zip entry names, so a
    # path that is valid on disk (for example "./tools/x.json") can still fail at
    # publish with "not found in the app package". Assert against the built zip.
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead((Resolve-Path $OutputPath))
    try {
        $entries = $zip.Entries | ForEach-Object { $_.FullName }
        $declared = @($manifest | ConvertFrom-Json)
        $problems = @()

        $toolsFile = $declared.agentConnectors.toolSource.remoteMcpServer.mcpToolDescription.file
        foreach ($file in @($toolsFile)) {
            if ($file -and $entries -notcontains $file) {
                $problems += "mcpToolDescription.file '$file' is not an entry in the archive."
            }
        }
        foreach ($folder in @($declared.agentSkills.folder)) {
            if ($folder -and -not ($entries | Where-Object { $_ -like "$folder/*" })) {
                $problems += "agentSkills folder '$folder' has no entries in the archive."
            }
        }
        if ($problems) {
            throw "Packaged zip does not match manifest:`n  - $($problems -join "`n  - ")"
        }
    }
    finally {
        $zip.Dispose()
    }

    $size = [math]::Round((Get-Item $OutputPath).Length / 1KB, 1)
    Write-Host "Packed $OutputPath ($size KB)."
    Write-Host "Verified every manifest-declared path resolves to an archive entry."
    Write-Host "Upload it in Cowork: Customize > Plugins > Upload plugin."
}
finally {
    Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue
}
