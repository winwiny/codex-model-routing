#Requires -Version 5.1
[CmdletBinding()]
param(
  [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'ModelTaskRouting/jev-bridge'),
  [string]$BinRoot = (Join-Path $env:LOCALAPPDATA 'ModelTaskRouting/bin'),
  [switch]$Upgrade,
  [switch]$SetupCredential,
  [switch]$RegisterCodex
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'This installer supports Windows only.' }

$sourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$targetRoot = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($InstallRoot)
$targetBin = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($BinRoot)
$credentialPath = Join-Path $env:LOCALAPPDATA 'ModelTaskRouting/typesafe.dpapi'
$nodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
$npmCommand = Get-Command npm -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -eq $nodeCommand -or $null -eq $npmCommand) { throw 'Node.js 20 or newer and npm are required.' }
$nodeMajor = [int]((& $nodeCommand.Source --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 20) { throw 'Node.js 20 or newer is required.' }

$requiredFiles = @('package.json', 'package-lock.json', 'LICENSE', 'README.md', 'SKILL.md')
$requiredDirectories = @('scripts', 'tests', 'docs', 'examples')
foreach ($relativePath in $requiredFiles) {
  if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot $relativePath) -PathType Leaf)) {
    throw "The installation package is incomplete: $relativePath"
  }
}
foreach ($relativePath in $requiredDirectories) {
  if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot $relativePath) -PathType Container)) {
    throw "The installation package is incomplete: $relativePath"
  }
}

if ((Test-Path -LiteralPath $targetRoot) -and -not $Upgrade) {
  throw "InstallRoot already exists. Re-run with -Upgrade to stage, test, back up, and replace it: $targetRoot"
}
$jevCommand = Join-Path $targetBin 'jev.cmd'
$mcpCommand = Join-Path $targetBin 'jev-mcp.cmd'
if (-not $Upgrade -and ((Test-Path -LiteralPath $jevCommand) -or (Test-Path -LiteralPath $mcpCommand))) {
  throw "A stable launcher already exists in BinRoot. Use -Upgrade after confirming it belongs to this package: $targetBin"
}

$parent = Split-Path -Parent $targetRoot
[IO.Directory]::CreateDirectory($parent) | Out-Null
$stageRoot = Join-Path $parent ('.jev-bridge.staging-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($stageRoot) | Out-Null
$timestamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')
$backupRoot = $null
$backupJev = $null
$backupMcp = $null
$swapped = $false
$jevBackupCreated = $false
$mcpBackupCreated = $false
$jevLauncherCreated = $false
$mcpLauncherCreated = $false
$jevTemp = $null
$mcpTemp = $null

try {
  foreach ($relativePath in $requiredFiles) {
    Copy-Item -LiteralPath (Join-Path $sourceRoot $relativePath) -Destination (Join-Path $stageRoot $relativePath)
  }
  foreach ($relativePath in $requiredDirectories) {
    Copy-Item -LiteralPath (Join-Path $sourceRoot $relativePath) -Destination (Join-Path $stageRoot $relativePath) -Recurse
  }

  & $npmCommand.Source ci --ignore-scripts --prefix $stageRoot
  if ($LASTEXITCODE -ne 0) { throw 'npm ci failed in staging.' }
  & $npmCommand.Source test --prefix $stageRoot
  if ($LASTEXITCODE -ne 0) { throw 'npm test failed in staging.' }
  & $nodeCommand.Source (Join-Path $stageRoot 'scripts/jev-cli.mjs') help *> $null
  if ($LASTEXITCODE -ne 0) { throw 'The staged CLI smoke check failed.' }

  if ($SetupCredential -and -not (Test-Path -LiteralPath $credentialPath -PathType Leaf)) {
    & (Join-Path $stageRoot 'scripts/jev-windows.ps1') -Setup -CredentialPath $credentialPath
    if ($LASTEXITCODE -ne 0) { throw 'Official TypeSafe credential setup failed.' }
  }

  if (Test-Path -LiteralPath $targetRoot) {
    $backupRoot = $targetRoot + '.backup-' + $timestamp
    if (Test-Path -LiteralPath $backupRoot) { throw "Backup path already exists: $backupRoot" }
    Move-Item -LiteralPath $targetRoot -Destination $backupRoot
  }
  Move-Item -LiteralPath $stageRoot -Destination $targetRoot
  $swapped = $true

  [IO.Directory]::CreateDirectory($targetBin) | Out-Null
  if (Test-Path -LiteralPath $jevCommand) {
    $backupJev = $jevCommand + '.backup-' + $timestamp
    Move-Item -LiteralPath $jevCommand -Destination $backupJev
    $jevBackupCreated = $true
  }
  if (Test-Path -LiteralPath $mcpCommand) {
    $backupMcp = $mcpCommand + '.backup-' + $timestamp
    Move-Item -LiteralPath $mcpCommand -Destination $backupMcp
    $mcpBackupCreated = $true
  }
  $utf8 = [Text.UTF8Encoding]::new($false)
  $jevTemp = $jevCommand + '.new-' + [Guid]::NewGuid().ToString('N')
  $mcpTemp = $mcpCommand + '.new-' + [Guid]::NewGuid().ToString('N')
  [IO.File]::WriteAllText($jevTemp, ('@echo off' + "`r`n" + '"' + $nodeCommand.Source + '" "' + (Join-Path $targetRoot 'scripts/jev-cli.mjs') + '" %*' + "`r`n"), $utf8)
  [IO.File]::WriteAllText($mcpTemp, ('@echo off' + "`r`n" + '"' + $nodeCommand.Source + '" "' + (Join-Path $targetRoot 'scripts/jev-mcp-server.mjs') + '" %*' + "`r`n"), $utf8)
  Move-Item -LiteralPath $jevTemp -Destination $jevCommand
  $jevLauncherCreated = $true
  Move-Item -LiteralPath $mcpTemp -Destination $mcpCommand
  $mcpLauncherCreated = $true

  $registration = 'not-requested'
  if ($RegisterCodex) {
    $codexCommand = Get-Command codex -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $codexCommand) { throw 'Codex CLI was not found; installation was rolled back.' }
    & $codexCommand.Source mcp get typesafe *> $null
    if ($LASTEXITCODE -eq 0) { throw 'An MCP server named typesafe already exists; installation was rolled back without changing it.' }
    & $codexCommand.Source mcp add typesafe -- $nodeCommand.Source (Join-Path $targetRoot 'scripts/jev-mcp-server.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Codex MCP registration failed; installation was rolled back.' }
    $registration = 'registered'
  }

  [pscustomobject]@{
    status = 'installed'
    installRoot = $targetRoot
    backupRoot = $backupRoot
    cli = $jevCommand
    mcp = $mcpCommand
    mcpNodeCommand = $nodeCommand.Source
    mcpScript = (Join-Path $targetRoot 'scripts/jev-mcp-server.mjs')
    credentialPath = $credentialPath
    credentialConfigured = Test-Path -LiteralPath $credentialPath -PathType Leaf
    codexRegistration = $registration
    model = 'jev-latest'
  } | ConvertTo-Json
} catch {
  if ($swapped -and (Test-Path -LiteralPath $targetRoot)) {
    $failedRoot = $targetRoot + '.failed-' + [Guid]::NewGuid().ToString('N')
    Move-Item -LiteralPath $targetRoot -Destination $failedRoot -ErrorAction SilentlyContinue
  }
  if ($null -ne $backupRoot -and (Test-Path -LiteralPath $backupRoot) -and -not (Test-Path -LiteralPath $targetRoot)) {
    Move-Item -LiteralPath $backupRoot -Destination $targetRoot
  }
  if ($jevLauncherCreated -and (Test-Path -LiteralPath $jevCommand)) {
    Remove-Item -LiteralPath $jevCommand -Force
  }
  if ($mcpLauncherCreated -and (Test-Path -LiteralPath $mcpCommand)) {
    Remove-Item -LiteralPath $mcpCommand -Force
  }
  if ($jevBackupCreated -and (Test-Path -LiteralPath $backupJev) -and -not (Test-Path -LiteralPath $jevCommand)) {
    Move-Item -LiteralPath $backupJev -Destination $jevCommand
  }
  if ($mcpBackupCreated -and (Test-Path -LiteralPath $backupMcp) -and -not (Test-Path -LiteralPath $mcpCommand)) {
    Move-Item -LiteralPath $backupMcp -Destination $mcpCommand
  }
  throw
} finally {
  if ($null -ne $jevTemp -and (Test-Path -LiteralPath $jevTemp)) { Remove-Item -LiteralPath $jevTemp -Force }
  if ($null -ne $mcpTemp -and (Test-Path -LiteralPath $mcpTemp)) { Remove-Item -LiteralPath $mcpTemp -Force }
  if (Test-Path -LiteralPath $stageRoot) { Remove-Item -LiteralPath $stageRoot -Recurse -Force }
}
