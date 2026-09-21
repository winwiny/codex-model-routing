#Requires -Version 5.1
[CmdletBinding()]
param([string]$InstallerPath)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$installer = if ([string]::IsNullOrWhiteSpace($InstallerPath)) {
  Join-Path $PSScriptRoot '../scripts/install-jev-mcp-windows.ps1'
} else { $InstallerPath }
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Windows is required.' }

$utf8 = [Text.UTF8Encoding]::new($false)
$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('jev-installer-rollback-' + [Guid]::NewGuid().ToString('N'))
$fakeBin = Join-Path $fixtureRoot 'fake-bin'
$installRoot = Join-Path $fixtureRoot 'installed/jev-bridge'
$binRoot = Join-Path $fixtureRoot 'installed/bin'
[IO.Directory]::CreateDirectory($fakeBin) | Out-Null
[IO.Directory]::CreateDirectory($installRoot) | Out-Null
[IO.Directory]::CreateDirectory($binRoot) | Out-Null
[IO.File]::WriteAllText((Join-Path $fakeBin 'node.cmd'), "@echo off`r`necho v20.0.0`r`n", $utf8)
[IO.File]::WriteAllText((Join-Path $fakeBin 'npm.cmd'), "@echo off`r`nexit /b 9`r`n", $utf8)
$jevPath = Join-Path $binRoot 'jev.cmd'
$mcpPath = Join-Path $binRoot 'jev-mcp.cmd'
[IO.File]::WriteAllText($jevPath, 'old-jev', $utf8)
[IO.File]::WriteAllText($mcpPath, 'old-mcp', $utf8)

$hostPath = (Get-Process -Id $PID).Path
$info = [Diagnostics.ProcessStartInfo]::new()
$info.FileName = $hostPath
$info.Arguments = '-NoProfile -NonInteractive -File "' + ([IO.Path]::GetFullPath($installer)) + '" -Upgrade -InstallRoot "' + $installRoot + '" -BinRoot "' + $binRoot + '"'
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$info.RedirectStandardOutput = $true
$info.RedirectStandardError = $true
$info.EnvironmentVariables['PATH'] = $fakeBin + [IO.Path]::PathSeparator + $env:PATH
$child = [Diagnostics.Process]::new()
try {
  $child.StartInfo = $info
  $child.Start() | Out-Null
  $stdout = $child.StandardOutput.ReadToEndAsync()
  $stderr = $child.StandardError.ReadToEndAsync()
  $child.WaitForExit()
  if ($child.ExitCode -eq 0) { throw 'The staged npm failure unexpectedly succeeded.' }
  if ([IO.File]::ReadAllText($jevPath) -cne 'old-jev') { throw 'jev.cmd was changed by a pre-swap failure.' }
  if ([IO.File]::ReadAllText($mcpPath) -cne 'old-mcp') { throw 'jev-mcp.cmd was changed by a pre-swap failure.' }
  [pscustomobject]@{
    status = 'passed'
    installerExitCode = $child.ExitCode
    launchersPreserved = $true
    fixtureRoot = $fixtureRoot
  } | ConvertTo-Json
} finally {
  $child.Dispose()
}
