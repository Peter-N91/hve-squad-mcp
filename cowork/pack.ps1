#requires -Version 7.0

<#
.SYNOPSIS
  Packs the project-managed Cowork plugin into an uploadable .zip.

.DESCRIPTION
  Run `npm run generate:cowork` first. It validates the v1.29 dynamic MCP
  contract: one orchestrator-first project I/O Agent Skill, no pinned
  mcpToolDescription, and one authenticated remoteMcpServer. This script
  substitutes tenant values and packages the manifest, icons, and skill files.
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

$staging = Join-Path $root ".pack-staging-$([guid]::NewGuid().ToString('N'))"
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

    $declared = $manifest | ConvertFrom-Json
    if ($declared.manifestVersion -ne '1.29') {
        throw "Dynamic MCP discovery requires manifestVersion 1.29."
    }
    if ($null -eq $declared.agentSkills -or @($declared.agentSkills).Count -eq 0) {
        throw "The Cowork package must declare at least one Agent Skill."
    }
    $requiredEntries = @('manifest.json', 'color.png', 'outline.png')
    foreach ($skill in @($declared.agentSkills)) {
        $folder = [string]$skill.folder
        if ($folder -notmatch '^\./skills/[a-z0-9]+(?:-[a-z0-9]+)*$') {
            throw "Invalid Agent Skill folder '$folder'."
        }
        $entry = "$($folder.Substring(2))/SKILL.md"
        $relativeFolder = $folder.Substring(2).Replace('/', [IO.Path]::DirectorySeparatorChar)
        $sourceFolder = Join-Path $root $relativeFolder
        $skillPath = Join-Path $sourceFolder 'SKILL.md'
        if (-not (Test-Path $skillPath)) {
            throw "Agent Skill '$folder' is missing SKILL.md."
        }
        $skillText = Get-Content $skillPath -Raw
        if ($skillText.Length -gt 20000) {
            throw "Agent Skill '$folder'/SKILL.md contains $($skillText.Length) characters; maximum is 20000."
        }
        if ($folder -eq './skills/hve-project-manager') {
            foreach ($reference in @('references/project-contract.md', 'references/execution-protocol.md', 'references/artifact-sync.md', 'references/stakeholder-library.md', 'references/context-preflight.md')) {
                if (-not (Test-Path (Join-Path $sourceFolder $reference) -PathType Leaf)) {
                    throw "Agent Skill '$folder' is missing $reference."
                }
                $requiredEntries += "$($folder.Substring(2))/$reference"
            }
            $requiredContract = @{
                'orchestrator entry' = '(?m)^\s+orchestrator-entry-tool:\s+squad_run\s*$'
                'status control' = '(?m)^\s+status-tool:\s+squad_status\s*$'
                'output retrieval' = '(?m)^\s+output-read-tool:\s+squad_history\s*$'
                'approval control' = '(?m)^\s+approval-tool:\s+squad_approve\s*$'
                'human response control' = '(?m)^\s+human-response-tool:\s+squad_respond\s*$'
                'I/O responsibility' = '(?m)^\s+responsibility:\s+project-io-bridge\s*$'
                'artifact synchronization' = '(?m)^\s+artifact-sync-protocol:\s+references/artifact-sync\.md\s*$'
                'canonical artifact layout' = '(?m)^\s+artifact-layout:\s+server-canonical\s*$'
                'stakeholder library' = '(?m)^\s+stakeholder-library-protocol:\s+references/stakeholder-library\.md\s*$'
                'context preflight' = '(?m)^\s+context-preflight-protocol:\s+references/context-preflight\.md\s*$'
            }
            foreach ($contract in $requiredContract.GetEnumerator()) {
                if ($skillText -notmatch $contract.Value) {
                    throw "Agent Skill '$folder' is missing its $($contract.Key) contract."
                }
            }
        }
        $destinationParent = Split-Path -Parent (Join-Path $staging $relativeFolder)
        New-Item -ItemType Directory -Path $destinationParent -Force | Out-Null
        Copy-Item -Path $sourceFolder -Destination $destinationParent -Recurse -Force
        $requiredEntries += $entry
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
        foreach ($item in $requiredEntries) {
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
    Write-Host "Verified orchestrator-first project I/O skill plus dynamic MCP connector."
    Write-Host "Upload it in Cowork: Customize > Plugins > Upload plugin."
}
finally {
    Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue
}
