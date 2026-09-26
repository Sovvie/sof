# Installs sof for the current user (Windows).
#   irm https://github.com/sovvie/sof/releases/latest/download/install.ps1 | iex
# Set $env:SOF_CLI_REPO to install from a fork, $env:SOF_HOME to change the install folder,
# $env:SOF_SKIP_TOOLS to skip setting up the built-in Rokit.

$ErrorActionPreference = "Stop"

$repo = if ($env:SOF_CLI_REPO) { $env:SOF_CLI_REPO } else { "sovvie/sof" }
$sofHome = if ($env:SOF_HOME) { $env:SOF_HOME } else { Join-Path $HOME ".sof" }

# Node 20.19+ is required.
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host "sof needs Node.js 20.19 or newer. Install it from https://nodejs.org (or: winget install OpenJS.NodeJS.LTS), then run this again." -ForegroundColor Red
    return
}
$nodeVersion = [version]((node --version).TrimStart("v"))
if ($nodeVersion -lt [version]"20.19.0") {
    Write-Host "sof needs Node.js 20.19 or newer (found $nodeVersion). Update from https://nodejs.org, then run this again." -ForegroundColor Red
    return
}

if ($env:SOF_RELEASE_ZIP) {
    # Install from a local release zip (for testing a build before publishing it).
    $localZip = (Resolve-Path $env:SOF_RELEASE_ZIP).Path
    $version = [IO.Path]::GetFileNameWithoutExtension($localZip) -replace '^sof-', ''
} else {
    Write-Host "Finding the latest sof release..."
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest" -Headers @{ "User-Agent" = "sof-installer" }
    $asset = $release.assets | Where-Object { $_.name -match '^sof-.*\.zip$' } | Select-Object -First 1
    if (-not $asset) {
        throw "Release $($release.tag_name) has no sof-<version>.zip asset."
    }
    $version = $release.tag_name.TrimStart("v")
}

$cliDir = Join-Path $sofHome "cli\$version"
$binDir = Join-Path $sofHome "bin"
$zipPath = Join-Path ([IO.Path]::GetTempPath()) "sof-$version.zip"

if ($env:SOF_RELEASE_ZIP) {
    Copy-Item $localZip $zipPath -Force
} else {
    Write-Host "Downloading sof $version..."
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zipPath -UseBasicParsing
}
if (Test-Path $cliDir) { Remove-Item -Recurse -Force $cliDir }
New-Item -ItemType Directory -Force -Path $cliDir | Out-Null
Expand-Archive -Path $zipPath -DestinationPath $cliDir -Force
Remove-Item $zipPath

Write-Host "Installing dependencies..."
Push-Location $cliDir
try {
    npm ci --omit=dev --no-audit --no-fund --loglevel=error
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed." }
} finally {
    Pop-Location
}

New-Item -ItemType Directory -Force -Path $binDir | Out-Null
$entry = Join-Path $cliDir "bin\sof.js"
Set-Content -Path (Join-Path $binDir "sof.cmd") -Value "@echo off`r`nnode `"$entry`" %*" -Encoding ASCII
Set-Content -Path (Join-Path $binDir "sof.ps1") -Value "node `"$entry`" @args" -Encoding ASCII

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (-not $env:SOF_SKIP_PATH -and -not (($userPath -split ";") -contains $binDir)) {
    [Environment]::SetEnvironmentVariable("Path", "$userPath;$binDir", "User")
    Write-Host "Added $binDir to your PATH."
}
$env:Path = "$env:Path;$binDir"

& (Join-Path $binDir "sof.cmd") --version | Out-Null

# sof has Rokit built in: set it up now so `sof run install` can install a project's tools.
if (-not $env:SOF_SKIP_TOOLS) {
    Write-Host "Setting up tools (built-in Rokit)..."
    & (Join-Path $binDir "sof.cmd") run tools setup
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Tool setup failed; it will be retried the first time you run: sof run install" -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "sof $version is installed. Open a new terminal, then run: sof --help" -ForegroundColor Green
Write-Host "Optional features: sof run addon list"
