param(
    [string]$OutputDirectory = "dist/elgato"
)

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $repo
$pluginDir = "com.slashpaf.audioforge.sdPlugin"
$licensePath = Join-Path $repo "LICENSE"
$cli = Join-Path $repo "node_modules/.bin/streamdeck.cmd"

if (-not (Test-Path $licensePath) -or (Get-Item $licensePath).Length -eq 0) {
    throw "A root LICENSE file is required to package a distributable plugin."
}
if (-not (Test-Path $cli)) {
    throw "Elgato's pinned CLI is missing. Run npm ci, then retry."
}
if (-not [System.IO.Path]::IsPathRooted($OutputDirectory)) {
    $OutputDirectory = Join-Path $repo $OutputDirectory
}

node scripts/verify-manifest.mjs
if ($LASTEXITCODE -ne 0) { throw "Manifest validation failed." }

$stage = Join-Path ([System.IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $stage | Out-Null
try {
    $stagedPlugin = Join-Path $stage $pluginDir
    Copy-Item $pluginDir $stage -Recurse

    $excludedDirectories = @("logs", "node_modules", ".git", ".cache", "coverage", "tmp", "temp")
    Get-ChildItem $stagedPlugin -Directory -Recurse |
        Sort-Object { $_.FullName.Length } -Descending |
        Where-Object { $excludedDirectories -contains $_.Name } |
        Remove-Item -Recurse -Force
    $excludedFileName = '(?i)(\.map|\.log|\.pem|\.key|\.p12|\.pfx|\.tsbuildinfo|^\.env(\..*)?|^\.ds_store$|^thumbs\.db$)$'
    Get-ChildItem $stagedPlugin -File -Recurse |
        Where-Object { $_.Name -match $excludedFileName } |
        Remove-Item -Force

    Copy-Item $licensePath (Join-Path $stagedPlugin "LICENSE")
    $assetLicense = Join-Path $repo "ASSET_LICENSE.md"
    if (Test-Path $assetLicense) { Copy-Item $assetLicense (Join-Path $stagedPlugin "ASSET_LICENSE.md") }
    New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null

    & $cli pack $stagedPlugin --force --output $OutputDirectory --no-update-check --no-file-list
    if ($LASTEXITCODE -ne 0) { throw "Elgato CLI packaging failed." }

    $archive = Join-Path $OutputDirectory "com.slashpaf.audioforge.streamDeckPlugin"
    if (-not (Test-Path $archive) -or (Get-Item $archive).Length -eq 0) {
        throw "Elgato CLI did not create the expected package: $archive"
    }
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant()
    "$hash  $(Split-Path $archive -Leaf)" | Set-Content -Encoding Ascii "$archive.sha256"
    Write-Output "Created $archive"
    Write-Output "SHA-256: $archive.sha256"
}
finally {
    Remove-Item $stage -Recurse -Force
}
