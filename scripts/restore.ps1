[CmdletBinding()]
param(
    [string]$ResourceDirectory = '',
    [switch]$SkipDependencies,
    [switch]$Build
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $ResourceDirectory) {
    $ResourceDirectory = Join-Path $root 'resource-packs'
}
$ResourceDirectory = (Resolve-Path $ResourceDirectory).Path
$manifest = Get-Content (Join-Path $root 'resource-packs\manifest.json') -Raw | ConvertFrom-Json

function Invoke-Checked {
    param([scriptblock]$Command, [string]$Label)
    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw "$Label failed with exit code $LASTEXITCODE"
    }
}

if (Test-Path (Join-Path $root '.git')) {
    Invoke-Checked { git -C $root submodule update --init --recursive } 'Git submodule update'
}

$expectedHashes = @{}
$checksumFile = Join-Path $ResourceDirectory 'checksums.sha256'
if (Test-Path $checksumFile) {
    foreach ($line in Get-Content $checksumFile) {
        if ($line -match '^([0-9a-fA-F]{64})\s+(.+)$') {
            $expectedHashes[$matches[2].Trim()] = $matches[1].ToLowerInvariant()
        }
    }
}

foreach ($pack in $manifest.packs) {
    $archive = Join-Path $ResourceDirectory $pack.file
    if (-not (Test-Path $archive)) {
        if ($pack.required) {
            throw "Required resource pack not found: $($pack.file)"
        }
        Write-Host "Optional pack skipped: $($pack.file)"
        continue
    }

    if ($expectedHashes.ContainsKey($pack.file)) {
        $actual = (Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -ne $expectedHashes[$pack.file]) {
            throw "SHA-256 mismatch: $($pack.file)"
        }
    }
    else {
        throw "No SHA-256 entry for $($pack.file)"
    }

    Write-Host "Restoring $($pack.file)..."
    Expand-Archive $archive -DestinationPath $root -Force
}

$settingsTarget = Join-Path $env:APPDATA 'RyzaPet\settings.json'
if (-not (Test-Path $settingsTarget)) {
    New-Item (Split-Path $settingsTarget -Parent) -ItemType Directory -Force | Out-Null
    Copy-Item (Join-Path $root 'config\settings.example.json') $settingsTarget
    Write-Host "Seeded settings without API keys: $settingsTarget"
}

if (-not $SkipDependencies) {
    foreach ($command in @('git', 'node', 'npm', 'cargo', 'py')) {
        if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
            throw "Required command not found: $command"
        }
    }

    if (-not (Test-Path (Join-Path $root '.venv\Scripts\python.exe'))) {
        Invoke-Checked { py -3.11 -m venv (Join-Path $root '.venv') } 'Python virtual environment creation'
    }
    $python = Join-Path $root '.venv\Scripts\python.exe'
    Invoke-Checked { & $python -m pip install --upgrade pip } 'pip upgrade'
    Invoke-Checked { & $python -m pip install -e (Join-Path $root 'moka_app') } 'Ryza Moka install'
    Invoke-Checked { & $python -m pip install -e (Join-Path $root 'research\open-source\MOKAMOKA\server') } 'MOKAMOKA install'
    Invoke-Checked { & $python -m pip install -r (Join-Path $root 'research\open-source\Clonoth\requirements.txt') } 'Clonoth dependencies'
    Invoke-Checked { & $python -m pip install pyinstaller pytest pytest-asyncio } 'Build and test dependencies'
    Invoke-Checked { npm --prefix (Join-Path $root 'desktop') ci } 'Desktop npm dependencies'
}

if ($Build) {
    Invoke-Checked { npm --prefix $root run desktop:build } 'Desktop build'
}

Write-Host 'Ryza restore completed. Enter the LLM API key in the Ryza settings page before chatting.'
