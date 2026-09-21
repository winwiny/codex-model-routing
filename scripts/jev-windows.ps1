#Requires -Version 5.1
<#
Stores an optional official TypeSafe API key with Windows DPAPI (CurrentUser), then runs
jev-evaluate.mjs with the key only in its child-process environment.
DPAPI protects the file at rest; other programs running as this Windows user
can also decrypt it. No key is written to the user or machine environment.
#>
[CmdletBinding(DefaultParameterSetName = 'Run')]
param(
  [Parameter(Mandatory, ParameterSetName = 'Setup')]
  [switch]$Setup,

  [Parameter(ParameterSetName = 'Run')]
  [string]$InputPath,

  [Parameter(ParameterSetName = 'Run')]
  [string]$OutputPath,

  [Parameter(ParameterSetName = 'Run')]
  [switch]$Check,

  [string]$CredentialPath = (Join-Path $env:LOCALAPPDATA 'ModelTaskRouting/typesafe.dpapi')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  [Console]::Error.WriteLine('This launcher requires PowerShell 5.1 or newer on Windows.')
  exit 1
}

function ConvertTo-WindowsArgument {
  param([AllowEmptyString()][string]$Value)

  # Windows argv quoting, without a shell: before a quote, n backslashes become
  # 2n+1; before the closing quote, trailing backslashes become 2n.
  $quoted = [Text.StringBuilder]::new()
  [void]$quoted.Append('"')
  $backslashes = 0
  foreach ($character in $Value.ToCharArray()) {
    if ($character -eq '\') {
      $backslashes++
      continue
    }
    if ($character -eq '"') {
      [void]$quoted.Append(('\' * (2 * $backslashes + 1)))
    } else {
      [void]$quoted.Append(('\' * $backslashes))
    }
    [void]$quoted.Append($character)
    $backslashes = 0
  }
  [void]$quoted.Append(('\' * (2 * $backslashes)))
  [void]$quoted.Append('"')
  return $quoted.ToString()
}

$secureKey = $null
$plainKey = $null
$encryptedKey = $null
$secretBstr = [IntPtr]::Zero
$stream = $null
$writer = $null
$process = $null
$startInfo = $null
$originalOutputEncoding = [Console]::OutputEncoding
$exitCode = 1
$failureMessage = 'Unable to resolve CredentialPath as a filesystem path.'

try {
  $credentialFile = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($CredentialPath)

  if ($Setup) {
    $failureMessage = 'The credential file already exists; choose another CredentialPath to avoid overwriting it.'
    if (Test-Path -LiteralPath $credentialFile) {
      throw 'Credential file already exists.'
    }

    $failureMessage = 'Unable to read the hidden credential prompt.'
    $secureKey = Read-Host 'Enter TYPESAFE_API_KEY (hidden)' -AsSecureString
    if ($secureKey.Length -eq 0) {
      $failureMessage = 'The credential key must not be empty.'
      throw 'The key must not be empty.'
    }

    # Omitting -Key selects Windows DPAPI with the current user scope.
    $failureMessage = 'Unable to encrypt the credential with Windows DPAPI for the current user.'
    $encryptedKey = ConvertFrom-SecureString -SecureString $secureKey
    $failureMessage = 'Unable to create the credential file; existing files are not overwritten.'
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($credentialFile)) | Out-Null
    $stream = [IO.File]::Open($credentialFile, [IO.FileMode]::CreateNew,
      [IO.FileAccess]::Write, [IO.FileShare]::None)
    $writer = [IO.StreamWriter]::new($stream, [Text.UTF8Encoding]::new($false))
    $writer.Write($encryptedKey)
    $writer.Flush()
    [Console]::Out.WriteLine('Saved a DPAPI credential for this Windows user. The key was not displayed.')
    $exitCode = 0
  } else {
    $failureMessage = 'The evaluator scripts/jev-evaluate.mjs must be next to this launcher.'
    $entrypoint = Join-Path $PSScriptRoot 'jev-evaluate.mjs'
    if (-not (Test-Path -LiteralPath $entrypoint -PathType Leaf)) {
      throw 'The Jev evaluator is missing.'
    }
    $failureMessage = 'Node.js was not found in PATH or the standard Program Files/nodejs location.'
    $nodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $nodeCommand) {
      $nodePath = $nodeCommand.Source
    } else {
      $nodePath = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'nodejs/node.exe'
      if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
        throw 'Node.js is unavailable.'
      }
    }

    $plainKey = [Environment]::GetEnvironmentVariable('TYPESAFE_API_KEY', 'Process')
    if ([string]::IsNullOrWhiteSpace($plainKey) -and (Test-Path -LiteralPath $credentialFile -PathType Leaf)) {
      $failureMessage = 'Unable to decrypt CredentialPath for this Windows user; use its original user or configure a new file.'
      $encryptedKey = [IO.File]::ReadAllText($credentialFile)
      $secureKey = ConvertTo-SecureString -String $encryptedKey
      $secretBstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
      $plainKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretBstr)
    }

    $failureMessage = 'Unable to prepare the Jev evaluator child process.'
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $nodePath
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
    $startInfo.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
    $startInfo.WorkingDirectory = $PWD.ProviderPath
    $nodeArguments = [Collections.Generic.List[string]]::new()
    $nodeArguments.Add($entrypoint)
    if ($PSBoundParameters.ContainsKey('InputPath')) {
      $nodeArguments.Add('--input')
      $nodeArguments.Add($InputPath)
    }
    if ($PSBoundParameters.ContainsKey('OutputPath')) {
      $nodeArguments.Add('--output')
      $nodeArguments.Add($OutputPath)
    }
    if ($Check) {
      $nodeArguments.Add('--check')
    }
    if ($null -ne $startInfo.PSObject.Properties['ArgumentList']) {
      foreach ($argument in $nodeArguments) { $startInfo.ArgumentList.Add($argument) }
    } else {
      $startInfo.Arguments = ($nodeArguments | ForEach-Object { ConvertTo-WindowsArgument $_ }) -join ' '
    }
    if (-not [string]::IsNullOrWhiteSpace($plainKey)) {
      $startInfo.EnvironmentVariables['TYPESAFE_API_KEY'] = $plainKey
    } else {
      # A missing key is left to the evaluator, which writes structured evidence.
      $startInfo.EnvironmentVariables.Remove('TYPESAFE_API_KEY')
    }

    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    $failureMessage = 'Unable to start Node.js for the Jev evaluator.'
    $process.Start() | Out-Null
    $failureMessage = 'Unable to capture the Jev evaluator output.'
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    [Console]::Out.Write($stdoutTask.GetAwaiter().GetResult())
    [Console]::Error.Write($stderrTask.GetAwaiter().GetResult())
    $exitCode = $process.ExitCode
  }
} catch {
  # Do not expose exception content that might contain credential material.
  [Console]::Error.WriteLine($failureMessage)
} finally {
  if ($null -ne $writer) { $writer.Dispose() }
  if ($null -ne $stream) { $stream.Dispose() }
  if ($null -ne $startInfo) { $startInfo.EnvironmentVariables.Remove('TYPESAFE_API_KEY') }
  if ($null -ne $process) { $process.Dispose() }
  if ($secretBstr -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretBstr)
  }
  if ($null -ne $secureKey) { $secureKey.Dispose() }
  [Console]::OutputEncoding = $originalOutputEncoding
  $plainKey = $null
  $encryptedKey = $null
}

exit $exitCode
