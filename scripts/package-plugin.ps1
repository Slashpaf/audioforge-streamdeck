param(
    [string]$OutputFile,
    [switch]$RequireLicense
)

$ErrorActionPreference = "Stop"
$repo = (Get-Location).Path
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$pluginDir = "com.slashpaf.audioforge.sdPlugin"
if ([string]::IsNullOrWhiteSpace($OutputFile)) {
    $OutputFile = Join-Path "dist/opendeck" "Audio-Forge-v$version-opendeck.zip"
}
if (-not [System.IO.Path]::IsPathRooted($OutputFile)) {
    $OutputFile = Join-Path $repo $OutputFile
}
$licensePath = Join-Path $repo "LICENSE"

if (-not (Test-Path $licensePath) -or (Get-Item $licensePath).Length -eq 0) {
    if ($RequireLicense) {
        throw "A root LICENSE file is required for a distributable release."
    }
    Write-Warning "Packaging without the project license; do not publish this archive."
}

node scripts/verify-manifest.mjs
if ($LASTEXITCODE -ne 0) { throw "Manifest validation failed." }

$stage = Join-Path ([System.IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $stage | Out-Null
try {
    $stagedPlugin = Join-Path $stage $pluginDir
    Copy-Item $pluginDir $stage -Recurse
    # Remove local runtime/debug files from the staged copy before archiving.
    $excludedDirectories = @("logs", "node_modules", ".git", ".cache", "coverage", "tmp", "temp")
    Get-ChildItem $stagedPlugin -Directory -Recurse |
        Sort-Object { $_.FullName.Length } -Descending |
        Where-Object { $excludedDirectories -contains $_.Name } |
        Remove-Item -Recurse -Force
    $excludedFileName = '(?i)(\.map|\.log|\.pem|\.key|\.p12|\.pfx|\.tsbuildinfo|^\.env(\..*)?|^\.ds_store$|^thumbs\.db$)$'
    Get-ChildItem $stagedPlugin -File -Recurse |
        Where-Object { $_.Name -match $excludedFileName } |
        Remove-Item -Force
    if (Test-Path $licensePath) { Copy-Item $licensePath (Join-Path $stagedPlugin "LICENSE") }
    $assetLicense = Join-Path $repo "ASSET_LICENSE.md"
    if (Test-Path $assetLicense) { Copy-Item $assetLicense (Join-Path $stagedPlugin "ASSET_LICENSE.md") }

    $outputDirectory = Split-Path $OutputFile -Parent
    if ($outputDirectory) { New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null }
    if (Test-Path $OutputFile) { Remove-Item $OutputFile -Force }
    if (Test-Path "$OutputFile.sha256") { Remove-Item "$OutputFile.sha256" -Force }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::CreateFromDirectory(
        $stagedPlugin,
        $OutputFile,
        [System.IO.Compression.CompressionLevel]::Optimal,
        $true
    )
    $archive = [System.IO.Compression.ZipFile]::OpenRead($OutputFile)
    try {
        if ($null -eq $archive.GetEntry("$pluginDir/manifest.json")) {
            throw "Installer archive does not contain $pluginDir/manifest.json at its root."
        }
    }
    finally {
        $archive.Dispose()
    }
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $OutputFile).Hash.ToLowerInvariant()
    "$hash  $(Split-Path $OutputFile -Leaf)" | Set-Content -Encoding Ascii "$OutputFile.sha256"
    Write-Output "Created $OutputFile"
    Write-Output "SHA-256: $OutputFile.sha256"
}
finally {
    Remove-Item $stage -Recurse -Force
}
