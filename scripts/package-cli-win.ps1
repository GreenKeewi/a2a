param([string]$OutputDirectory, [string]$ArchivePath)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$source = Join-Path $repo 'packages/sidecar'
$protocolSource = Join-Path $repo 'packages/protocol'
if (-not $OutputDirectory) {
  $OutputDirectory = Join-Path $repo ('test-results/a2a-cli-win-' + [guid]::NewGuid().ToString('N'))
}
$target = [System.IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $target) { throw "Output directory already exists: $target" }
if (-not $ArchivePath) {
  $ArchivePath = Join-Path $repo ('test-results/a2a-cli-win-' + [guid]::NewGuid().ToString('N') + '.zip')
}
$archive = [System.IO.Path]::GetFullPath($ArchivePath)
if (Test-Path -LiteralPath $archive) { throw "Archive already exists: $archive" }
New-Item -ItemType Directory -Path $target | Out-Null
$protocol = Join-Path $target 'protocol-package'
New-Item -ItemType Directory -Path (Join-Path $protocol 'dist') -Force | Out-Null

Push-Location $repo
try {
  node node_modules/typescript/bin/tsc -p packages/sidecar/tsconfig.build.json
  if ($LASTEXITCODE -ne 0) { throw 'Sidecar compilation failed' }
  node node_modules/typescript/bin/tsc packages/protocol/src/index.ts --target ES2022 --module NodeNext --moduleResolution NodeNext --outDir (Join-Path $protocol 'dist') --skipLibCheck --esModuleInterop
  if ($LASTEXITCODE -ne 0) { throw 'Protocol compilation failed' }

  $protocolManifest = Get-Content -LiteralPath (Join-Path $protocolSource 'package.json') -Raw | ConvertFrom-Json -AsHashtable
  $protocolManifest['exports'] = @{ '.' = './dist/index.js' }
  $protocolManifest.Remove('scripts')
  $protocolManifest.Remove('devDependencies')
  $protocolManifest | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $protocol 'package.json') -Encoding utf8
  $archiveName = npm pack $protocol --pack-destination $target --silent
  if ($LASTEXITCODE -ne 0) { throw 'Protocol packing failed' }
  $archiveName = ($archiveName | Select-Object -Last 1).Trim()

  $sidecarManifest = Get-Content -LiteralPath (Join-Path $source 'package.json') -Raw | ConvertFrom-Json -AsHashtable
  $sidecarManifest['name'] = 'a2a-cli'
  $sidecarManifest['version'] = '0.1.0'
  $sidecarManifest['dependencies']['@a2a/protocol'] = "file:./$archiveName"
  $sidecarManifest.Remove('scripts')
  $sidecarManifest.Remove('devDependencies')
  $sidecarManifest | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $target 'package.json') -Encoding utf8
  Copy-Item -LiteralPath (Join-Path $source 'dist') -Destination (Join-Path $target 'dist') -Recurse
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'cli-install-win.ps1') -Destination (Join-Path $target 'install.ps1')
  npm install --prefix $target --omit=dev --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'Production dependency installation failed' }
  '@echo off' + "`r`n" + 'node "%~dp0dist\cli.js" %*' + "`r`n" | Set-Content -LiteralPath (Join-Path $target 'a2a.cmd') -Encoding ascii
  node (Join-Path $target 'dist/cli.js')
  if ($LASTEXITCODE -ne 0) { throw 'Packaged CLI smoke check failed' }
  tar -a -cf $archive -C $target .
  if ($LASTEXITCODE -ne 0) { throw 'CLI archive creation failed' }
  Write-Output $archive
} finally {
  Pop-Location
}
