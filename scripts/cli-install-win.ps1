param([string]$InstallRoot, [switch]$SkipPathUpdate)

$ErrorActionPreference = 'Stop'
if (-not $InstallRoot) { $InstallRoot = Join-Path $env:LOCALAPPDATA 'a2a-cli' }
$major = [int](node -p "process.versions.node.split('.')[0]")
if ($LASTEXITCODE -ne 0 -or $major -lt 22) { throw 'a2a requires Node.js 22 or newer.' }
$version = (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'package.json') -Raw | ConvertFrom-Json).version
$root = [System.IO.Path]::GetFullPath($InstallRoot)
$release = Join-Path $root "versions/$version"
$bin = Join-Path $root 'bin'
New-Item -ItemType Directory -Path $release, $bin -Force | Out-Null
robocopy $PSScriptRoot $release /E /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -gt 7) { throw "Failed to copy a2a CLI files (robocopy $LASTEXITCODE)." }
$shim = Join-Path $bin 'a2a.cmd'
('@echo off' + "`r`n" + 'node "' + (Join-Path $release 'dist/cli.js') + '" %*' + "`r`n") |
  Set-Content -LiteralPath $shim -Encoding ascii
if (-not $SkipPathUpdate) {
  $current = [Environment]::GetEnvironmentVariable('Path', 'User')
  $entries = @($current -split ';' | ForEach-Object { $_.TrimEnd('\') })
  if ($entries -notcontains $bin.TrimEnd('\')) {
    [Environment]::SetEnvironmentVariable('Path', (($current.TrimEnd(';') + ';' + $bin).TrimStart(';')), 'User')
  }
}
Write-Output "Installed a2a $version at $release"
if ($SkipPathUpdate) { Write-Output "Run $shim from your project folder." }
else { Write-Output 'Open a new terminal, then run a2a setup from your project folder.' }
