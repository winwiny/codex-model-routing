#Requires -Version 5.1
[CmdletBinding()]
param(
  [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'ModelTaskRouting/jev-mcp'),
  [switch]$SkipCredentialSetup,
  [switch]$SkipCodexRegistration
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw 'This installer supports Windows only.'
}

$sourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$targetRoot = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($InstallRoot)
$credentialPath = Join-Path $env:LOCALAPPDATA 'ModelTaskRouting/typesafe.dpapi'
$requiredSourceFiles = @(
  'package.json',
  'package-lock.json',
  'LICENSE',
  'README.md',
  'scripts/jev-evaluate.mjs',
  'scripts/jev-mcp-server.mjs',
  'scripts/jev-windows.ps1',
  'examples/jev-request.json',
  'docs/jev-invocation.md',
  'docs/jev-mcp.md',
  'docs/install-other-computers.md'
)

foreach ($relativePath in $requiredSourceFiles) {
  if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot $relativePath) -PathType Leaf)) {
    throw "The installation package is incomplete: $relativePath"
  }
}
if (Test-Path -LiteralPath $targetRoot) {
  throw "InstallRoot already exists: $targetRoot"
}

$nodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
$npmCommand = Get-Command npm -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -eq $nodeCommand -or $null -eq $npmCommand) {
  throw 'Node.js 22 or newer and npm are required.'
}
$nodeMajor = [int]((& $nodeCommand.Source --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 22) { throw 'Node.js 22 or newer is required.' }

[IO.Directory]::CreateDirectory($targetRoot) | Out-Null
foreach ($relativePath in $requiredSourceFiles) {
  $destination = Join-Path $targetRoot $relativePath
  [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination)) | Out-Null
  Copy-Item -LiteralPath (Join-Path $sourceRoot $relativePath) -Destination $destination
}

& $npmCommand.Source ci --ignore-scripts --omit=dev --prefix $targetRoot
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }

if (-not $SkipCredentialSetup -and -not (Test-Path -LiteralPath $credentialPath -PathType Leaf)) {
  & (Join-Path $targetRoot 'scripts/jev-windows.ps1') -Setup
  if ($LASTEXITCODE -ne 0) { throw 'Official TypeSafe credential setup failed.' }
}

if (-not $SkipCodexRegistration) {
  $codexCommand = Get-Command codex -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $codexCommand) { throw 'Codex CLI was not found.' }
  & $codexCommand.Source mcp get jev *> $null
  if ($LASTEXITCODE -eq 0) {
    throw 'An MCP server named jev already exists. Keep the installed files and update that entry manually.'
  }
  & $codexCommand.Source mcp add jev -- $nodeCommand.Source (Join-Path $targetRoot 'scripts/jev-mcp-server.mjs')
  if ($LASTEXITCODE -ne 0) { throw 'Codex MCP registration failed.' }
}

& (Join-Path $targetRoot 'scripts/jev-windows.ps1') `
  -InputPath (Join-Path $targetRoot 'examples/jev-request.json') -Check
if ($LASTEXITCODE -ne 0) { throw 'Offline Jev check failed.' }

[pscustomobject]@{
  status = 'installed'
  installRoot = $targetRoot
  credentialPath = $credentialPath
  credentialConfigured = Test-Path -LiteralPath $credentialPath -PathType Leaf
  codexRegistrationSkipped = [bool]$SkipCodexRegistration
  provider = 'typesafe-direct'
  model = 'jev-latest'
} | ConvertTo-Json
