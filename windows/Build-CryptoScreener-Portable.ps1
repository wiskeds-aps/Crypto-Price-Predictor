param(
    [string]$PythonVersion = "3.12.8",
    [string]$AppName = "CryptoScreenerPortable"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$BuildRoot = Join-Path $RepoRoot ".build\windows-cryptoskriner"
$DistRoot = Join-Path $RepoRoot "dist"
$PortableRoot = Join-Path $DistRoot $AppName
$PythonDir = Join-Path $PortableRoot "python"
$AppDir = Join-Path $PortableRoot "app"
$DataDir = Join-Path $PortableRoot "data"
$PythonZip = Join-Path $BuildRoot "python-$PythonVersion-embed-amd64.zip"
$GetPip = Join-Path $BuildRoot "get-pip.py"
$PythonUrl = "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip"
$GetPipUrl = "https://bootstrap.pypa.io/get-pip.py"

function Copy-DirectoryClean {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination
    )

    $sourceFull = (Resolve-Path $Source).Path -replace "[\\/]+$", ""
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    Get-ChildItem -Path $Source -Recurse -File |
        Where-Object {
            $_.FullName -notmatch "\\__pycache__\\" -and
            $_.FullName -notmatch "\\\.pytest_cache\\" -and
            $_.Name -notlike "*.pyc" -and
            $_.Name -notlike "*.log" -and
            $_.Name -notlike "*.db" -and
            $_.Name -notlike "*.db-*"
        } |
        ForEach-Object {
            $relative = $_.FullName.Substring($sourceFull.Length) -replace "^[\\/]+", ""
            $target = Join-Path $Destination $relative
            New-Item -ItemType Directory -Force -Path (Split-Path $target -Parent) | Out-Null
            Copy-Item -Path $_.FullName -Destination $target -Force
        }
}

function Invoke-Native {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code ${LASTEXITCODE}: $FilePath $($Arguments -join ' ')"
    }
}

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

New-Item -ItemType Directory -Force -Path $BuildRoot, $DistRoot | Out-Null

if (Test-Path $PortableRoot) {
    Remove-Item -Path $PortableRoot -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $PythonDir, $AppDir, $DataDir | Out-Null

if (-not (Test-Path $PythonZip)) {
    Write-Host "Downloading Python $PythonVersion embeddable package..."
    Invoke-WebRequest -Uri $PythonUrl -OutFile $PythonZip
}

Write-Host "Extracting portable Python..."
Expand-Archive -Path $PythonZip -DestinationPath $PythonDir -Force

$pthFile = Get-ChildItem -Path $PythonDir -Filter "python*._pth" | Select-Object -First 1
if ($null -eq $pthFile) {
    throw "Could not find python ._pth file in $PythonDir"
}

$pthContent = Get-Content $pthFile.FullName
$pthContent = $pthContent | ForEach-Object {
    if ($_ -eq "#import site") { "import site" } else { $_ }
}
Set-Content -Path $pthFile.FullName -Value $pthContent -Encoding ASCII

if (-not (Test-Path $GetPip)) {
    Write-Host "Downloading pip bootstrap..."
    Invoke-WebRequest -Uri $GetPipUrl -OutFile $GetPip
}

Write-Host "Installing pip into portable Python..."
$PythonExe = Join-Path $PythonDir "python.exe"
Invoke-Native -FilePath $PythonExe -Arguments @($GetPip, "--no-warn-script-location")

Write-Host "Copying application files..."
Copy-DirectoryClean -Source (Join-Path $RepoRoot "app") -Destination (Join-Path $AppDir "app")
Copy-DirectoryClean -Source (Join-Path $RepoRoot "static") -Destination (Join-Path $AppDir "static")
Copy-Item -Path (Join-Path $RepoRoot "requirements.txt") -Destination (Join-Path $AppDir "requirements.txt") -Force
Copy-Item -Path (Join-Path $RepoRoot "README.md") -Destination (Join-Path $AppDir "README.md") -Force
Copy-Item -Path (Join-Path $RepoRoot ".env.example") -Destination (Join-Path $PortableRoot ".env.example") -Force
Copy-Item -Path (Join-Path $RepoRoot ".env.example") -Destination (Join-Path $AppDir ".env.example") -Force

Write-Host "Installing Python dependencies. This can take several minutes..."
Invoke-Native -FilePath $PythonExe -Arguments @(
    "-m", "pip", "install",
    "--no-warn-script-location",
    "--upgrade", "pip", "setuptools", "wheel"
)
Invoke-Native -FilePath $PythonExe -Arguments @(
    "-m", "pip", "install",
    "--no-warn-script-location",
    "--only-binary", ":all:",
    "-r", (Join-Path $AppDir "requirements.txt")
)

$StartBat = @"
@echo off
set "APP_ROOT=%~dp0"
set "PYTHONNOUSERSITE=1"
set "CRYPTOSKRINER_DATA_DIR=%APP_ROOT%data"
set "CRYPTOSKRINER_ENV_FILE=%APP_ROOT%.env"
if not exist "%APP_ROOT%data" mkdir "%APP_ROOT%data"
cd /d "%APP_ROOT%app"
echo Starting CryptoScreener on http://127.0.0.1:8000
start "" "http://127.0.0.1:8000"
"%APP_ROOT%python\python.exe" -m uvicorn app.main:app --host 127.0.0.1 --port 8000
pause
"@

Set-Content -Path (Join-Path $PortableRoot "Start CryptoScreener.bat") -Value $StartBat -Encoding ASCII

$Readme = @"
CryptoScreener Portable

Start:
1. Run "Start CryptoScreener.bat".
2. The app opens at http://127.0.0.1:8000.
3. Local data is stored in the data folder.

Telegram alerts:
1. Copy ".env.example" to ".env" in this folder.
2. Fill TELEGRAM_TOKEN and TELEGRAM_CHAT_ID.
3. Restart the app.

The app needs internet access for CoinGecko and Binance data.
"@

Set-Content -Path (Join-Path $PortableRoot "README.txt") -Value $Readme -Encoding ASCII

Write-Host ""
Write-Host "Portable app created:"
Write-Host $PortableRoot
Write-Host "Copy this folder to any Windows 11 PC and run Start CryptoScreener.bat"
