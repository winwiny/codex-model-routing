#Requires -Version 5.1
[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [string]$PrivatePipeToken,

  [string]$CredentialPath = (Join-Path $env:LOCALAPPDATA 'ModelTaskRouting/typesafe.dpapi')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { exit 2 }
if (-not [Console]::IsOutputRedirected `
  -or [string]::IsNullOrWhiteSpace($PrivatePipeToken) `
  -or $PrivatePipeToken -cne [Environment]::GetEnvironmentVariable('JEV_DPAPI_PIPE_NONCE', 'Process')) {
  [Console]::Error.WriteLine('This internal credential helper requires a parent-owned redirected pipe.')
  exit 6
}
if ($null -eq ('System.Security.Cryptography.ProtectedData' -as [type])) { Add-Type -AssemblyName System.Security }

$plainBytes = $null
$protectedBytes = $null
try {
  $credentialFile = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($CredentialPath)
  if (-not (Test-Path -LiteralPath $credentialFile -PathType Leaf)) { exit 3 }
  $encrypted = [IO.File]::ReadAllText($credentialFile)
  if (-not $encrypted.StartsWith('dpapi-utf16-v2:')) { exit 4 }
  $protectedBytes = [Convert]::FromBase64String($encrypted.Substring('dpapi-utf16-v2:'.Length))
  $plainBytes = [Security.Cryptography.ProtectedData]::Unprotect(
    $protectedBytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  [Console]::Out.Write([Text.Encoding]::Unicode.GetString($plainBytes))
} catch {
  exit 5
} finally {
  if ($null -ne $plainBytes) { [Array]::Clear($plainBytes, 0, $plainBytes.Length) }
  if ($null -ne $protectedBytes) { [Array]::Clear($protectedBytes, 0, $protectedBytes.Length) }
}
