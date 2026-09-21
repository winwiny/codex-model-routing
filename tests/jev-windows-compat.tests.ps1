#Requires -Version 5.1
[CmdletBinding()]
param(
  [string]$WrapperPath,
  [string[]]$HostPaths
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$WrapperPath = if ([string]::IsNullOrWhiteSpace($WrapperPath)) {
  Join-Path $PSScriptRoot '../scripts/jev-windows.ps1'
} else {
  $WrapperPath
}
if ($null -eq $HostPaths -or $HostPaths.Count -eq 0) {
  $detectedHosts = [Collections.Generic.List[string]]::new()
  $windowsPowerShell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
  if (Test-Path -LiteralPath $windowsPowerShell -PathType Leaf) {
    $detectedHosts.Add($windowsPowerShell)
  }
  $powerShellCore = Get-Command pwsh -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -ne $powerShellCore -and -not $detectedHosts.Contains($powerShellCore.Source)) {
    $detectedHosts.Add($powerShellCore.Source)
  }
  $HostPaths = $detectedHosts.ToArray()
}
if ($HostPaths.Count -eq 0) { throw 'No supported PowerShell host was found.' }
$utf8 = [Text.UTF8Encoding]::new($false)
$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('jev-windows-compat-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($fixtureRoot) | Out-Null
$wrapperSource = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($WrapperPath)
$results = [Collections.Generic.List[object]]::new()

function Assert-Case([bool]$Passed, [string]$Message) {
  if (-not $Passed) { throw $Message }
}

# This is deliberately a local Node fixture. It has no network code and never
# reads default credential locations. Every child loses any inherited real key.
$stub = @'
const key = process.env.TYPESAFE_API_KEY;
const keySource = key === 'jev-compat-fake-key-do-not-use' ? 'dpapi'
  : key === 'jev-compat-fake-env-key' ? 'environment' : key ? 'unexpected' : 'missing';
console.log(JSON.stringify({ keySource, args: process.argv.slice(2), networkRequests: 0 }));
console.error('fixture-stderr');
process.exit(process.argv.includes('--check') ? 0 : 7);
'@
$runner = @'
#Requires -Version 5.1
$ErrorActionPreference = 'Stop'
$config = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'case.json')) | ConvertFrom-Json
Set-Location -LiteralPath $PSScriptRoot
function Read-Host {
  param([string]$Prompt, [switch]$AsSecureString)
  if (-not $AsSecureString) { throw 'Setup must use a secure prompt.' }
  ConvertTo-SecureString 'jev-compat-fake-key-do-not-use' -AsPlainText -Force
}
$beforeKey = [Environment]::GetEnvironmentVariable('TYPESAFE_API_KEY', 'Process')
$beforeEncoding = [Console]::OutputEncoding.CodePage
if ($config.Mode -eq 'setup') {
  & $config.Wrapper -Setup -CredentialPath $config.CredentialPath
} else {
  $parameters = @{ CredentialPath = $config.CredentialPath }
  if ($config.HasInput) { $parameters.InputPath = [string]$config.InputPath }
  if ($config.HasOutput) { $parameters.OutputPath = [string]$config.OutputPath }
  if ($config.Check) { $parameters.Check = $true }
  & $config.Wrapper @parameters
}
$code = $LASTEXITCODE
if ([Environment]::GetEnvironmentVariable('TYPESAFE_API_KEY', 'Process') -cne $beforeKey) { exit 101 }
if ([Console]::OutputEncoding.CodePage -ne $beforeEncoding) { exit 102 }
exit $code
'@

function Invoke-Case {
  param(
    [hashtable]$Fixture,
    [string]$Name,
    [hashtable]$Options,
    [string]$FakeKey = '',
    [switch]$WithoutNodePath
  )
  $caseDirectory = Join-Path $Fixture.Root $Name
  [IO.Directory]::CreateDirectory($caseDirectory) | Out-Null
  $config = @{
    Mode = 'run'; Wrapper = $Fixture.Wrapper; CredentialPath = $Fixture.Credential;
    Check = $true; HasInput = $false; HasOutput = $false; InputPath = ''; OutputPath = ''
  }
  foreach ($entry in $Options.GetEnumerator()) { $config[$entry.Key] = $entry.Value }
  [IO.File]::WriteAllText((Join-Path $caseDirectory 'case.json'), ($config | ConvertTo-Json), $utf8)
  $runnerPath = Join-Path $caseDirectory 'runner.ps1'
  [IO.File]::WriteAllText($runnerPath, $runner, $utf8)
  $info = [Diagnostics.ProcessStartInfo]::new()
  $info.FileName = $Fixture.Host
  # The generated path is a normal Windows file path, with no embedded quotes
  # or trailing slash. Test data goes through JSON, not the host command line.
  $info.Arguments = '-NoProfile -NonInteractive -File "' + $runnerPath + '"'
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $info.StandardOutputEncoding = $utf8
  $info.StandardErrorEncoding = $utf8
  # Let each host rebuild its own module paths; a .NET-launched Windows
  # PowerShell must not inherit incompatible bundled PowerShell 7 modules.
  $info.EnvironmentVariables.Remove('PSModulePath')
  $info.EnvironmentVariables.Remove('TYPESAFE_API_KEY')
  if ($FakeKey) { $info.EnvironmentVariables['TYPESAFE_API_KEY'] = $FakeKey }
  if ($WithoutNodePath) { $info.EnvironmentVariables['PATH'] = '' }
  $child = [Diagnostics.Process]::new()
  try {
    $child.StartInfo = $info
    $child.Start() | Out-Null
    $stdout = $child.StandardOutput.ReadToEndAsync()
    $stderr = $child.StandardError.ReadToEndAsync()
    $child.WaitForExit()
    $result = @{ Code = $child.ExitCode; Out = $stdout.GetAwaiter().GetResult(); Err = $stderr.GetAwaiter().GetResult() }
    Assert-Case (-not (($result.Out + $result.Err) -match 'jev-compat-fake-')) ($Name + ': fake key leaked')
    Assert-Case ($result.Code -ne 101 -and $result.Code -ne 102) ($Name + ': parent state changed')
    return $result
  } finally {
    $info.EnvironmentVariables.Remove('TYPESAFE_API_KEY')
    $child.Dispose()
  }
}

function Assert-Run([hashtable]$Result, [string]$Source, [string[]]$ExpectedArguments, [int]$ExitCode = 0) {
  Assert-Case ($Result.Code -eq $ExitCode) 'Unexpected child exit code.'
  $data = $Result.Out | ConvertFrom-Json
  Assert-Case ($data.keySource -ceq $Source) 'Unexpected credential source.'
  Assert-Case ($data.networkRequests -eq 0) 'The fixture must stay offline.'
  Assert-Case ($data.args.Count -eq $ExpectedArguments.Count) 'Wrong argument count.'
  for ($index = 0; $index -lt $ExpectedArguments.Count; $index++) {
    Assert-Case ($data.args[$index] -ceq $ExpectedArguments[$index]) ('Argument mismatch at index ' + $index)
  }
  Assert-Case ($Result.Err.Trim() -ceq 'fixture-stderr') 'stderr was not forwarded.'
}

$fixtures = [Collections.Generic.List[hashtable]]::new()
for ($hostIndex = 0; $hostIndex -lt $HostPaths.Count; $hostIndex++) {
  Assert-Case (Test-Path -LiteralPath $HostPaths[$hostIndex] -PathType Leaf) ('Test host is missing: ' + $HostPaths[$hostIndex])
  $hostRoot = Join-Path $fixtureRoot ('host-' + $hostIndex)
  $launcherDirectory = Join-Path $hostRoot 'launcher with spaces'
  [IO.Directory]::CreateDirectory($launcherDirectory) | Out-Null
  $fixtureWrapper = Join-Path $launcherDirectory 'jev-windows.ps1'
  Copy-Item -LiteralPath $wrapperSource -Destination $fixtureWrapper
  [IO.File]::WriteAllText((Join-Path $launcherDirectory 'jev-evaluate.mjs'), $stub, $utf8)
  $fixture = @{ Host = $HostPaths[$hostIndex]; Root = $hostRoot; Wrapper = $fixtureWrapper; Credential = (Join-Path $hostRoot 'credentials/key.dpapi') }
  $fixtures.Add($fixture)
  $setup = Invoke-Case $fixture 'setup' @{ Mode = 'setup' }
  Assert-Case ($setup.Code -eq 0) ('Fake DPAPI setup failed (exit ' + $setup.Code + '): ' + $setup.Err.Trim())
  $encrypted = [IO.File]::ReadAllText($fixture.Credential)
  Assert-Case ($encrypted.Length -gt 0 -and -not $encrypted.Contains('jev-compat-fake-key-do-not-use')) 'Credential storage is plaintext.'
  Assert-Case $encrypted.StartsWith('dpapi-utf16-v2:') 'Credential storage is not the expected DPAPI format.'
  $repeat = Invoke-Case $fixture 'setup-again' @{ Mode = 'setup' }
  Assert-Case ($repeat.Code -eq 1 -and [IO.File]::ReadAllText($fixture.Credential) -ceq $encrypted) 'Setup overwrote an existing credential.'
}

$unicode = -join ([char[]]@(0x6570, 0x636e))
for ($hostIndex = 0; $hostIndex -lt $fixtures.Count; $hostIndex++) {
  $fixture = $fixtures[$hostIndex]
  $inputValue = $unicode + ' input folder\'
  $outputValue = 'C:\valid folder with spaces\'
  $arguments = @('--input', $inputValue, '--output', $outputValue, '--check')
  $run = Invoke-Case $fixture 'unicode-trailing-slash' @{ HasInput = $true; InputPath = $inputValue; HasOutput = $true; OutputPath = $outputValue }
  Assert-Run $run 'dpapi' $arguments

  for ($slashes = 0; $slashes -le 3; $slashes++) {
    $inputValue = 'literal $ & (text) ' + ('\' * $slashes) + '"quoted"'
    $outputValue = 'C:\valid folder' + ('\' * $slashes)
    $run = Invoke-Case $fixture ('quote-' + $slashes) @{ HasInput = $true; InputPath = $inputValue; HasOutput = $true; OutputPath = $outputValue }
    Assert-Run $run 'dpapi' @('--input', $inputValue, '--output', $outputValue, '--check')
  }
  $empty = Invoke-Case $fixture 'empty-arguments' @{ HasInput = $true; HasOutput = $true }
  Assert-Run $empty 'dpapi' @('--input', '', '--output', '', '--check')
  $relative = Invoke-Case $fixture 'relative-credential' @{ CredentialPath = '../credentials/key.dpapi' }
  Assert-Run $relative 'dpapi' @('--check')
  $crossHost = Invoke-Case $fixture 'cross-host-dpapi' @{ CredentialPath = $fixtures[($hostIndex + 1) % $fixtures.Count].Credential }
  Assert-Run $crossHost 'dpapi' @('--check')
  $priority = Invoke-Case $fixture 'environment-priority' @{} 'jev-compat-fake-env-key'
  Assert-Run $priority 'environment' @('--check')
  $missingPath = Join-Path $fixture.Root 'never-created/key.dpapi'
  $missingCheck = Invoke-Case $fixture 'missing-check' @{ CredentialPath = $missingPath }
  Assert-Run $missingCheck 'missing' @('--check')
  $missingRun = Invoke-Case $fixture 'missing-run' @{ CredentialPath = $missingPath; Check = $false }
  Assert-Run $missingRun 'missing' @() 7
  Assert-Case (-not (Test-Path -LiteralPath (Split-Path -Parent $missingPath))) 'Run mode created a credential directory.'
  $fallback = Invoke-Case $fixture 'node-without-path' @{} -WithoutNodePath
  Assert-Run $fallback 'dpapi' @('--check')
  $results.Add(@{ host = $fixture.Host; cases = 14; status = 'passed' })
}

# Keep the synthetic fixtures for inspection; no recursive deletion is used.
@{ status = 'passed'; hosts = $results.ToArray(); networkRequests = 0; fixtureRoot = $fixtureRoot } | ConvertTo-Json -Depth 4
