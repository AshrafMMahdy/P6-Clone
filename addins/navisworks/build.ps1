# OPTIONAL (M7): build the Navisworks add-in and its runner, and install the add-in where Navisworks loads plugins.
# Needs the .NET SDK and a Navisworks Manage/Simulate install.
# Usage: .\build.ps1 [-NavisworksDir "C:\Program Files\Autodesk\Navisworks Manage 2025"]
param([string]$NavisworksDir = "C:\Program Files\Autodesk\Navisworks Manage 2025")
$ErrorActionPreference = 'Stop'
if (-not (Test-Path "$NavisworksDir\Autodesk.Navisworks.Api.dll")) { throw "Navisworks not found in $NavisworksDir; pass -NavisworksDir." }
dotnet build "$PSScriptRoot\P6Clone4D.csproj" -c Release -p:NavisworksDir="$NavisworksDir"
dotnet build "$PSScriptRoot\Runner\P6Clone4DRunner.csproj" -c Release -p:NavisworksDir="$NavisworksDir"
$plugins = Join-Path $NavisworksDir 'Plugins\P6Clone4D.WHIQ'
New-Item -ItemType Directory -Force $plugins | Out-Null
Copy-Item "$PSScriptRoot\bin\Release\net48\P6Clone4D.WHIQ.dll" $plugins -Force
Write-Host "Installed the add-in in $plugins. Run: $PSScriptRoot\Runner\bin\Release\net48\P6Clone4DRunner.exe <package folder>"
