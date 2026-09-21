import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { isMainModule } from '../scripts/jev-cli.mjs';

test('CLI main detection resolves argv through realpath before pathToFileURL', async () => {
  const source = await readFile('scripts/jev-cli.mjs', 'utf8');
  assert.match(source, /pathToFileURL\(realpathSync\(resolve\(argv1\)\)\)\.href/);
  assert.doesNotMatch(source, /new URL\(`file:\/\//);
  const cliPath = resolve('scripts/jev-cli.mjs');
  assert.equal(isMainModule(cliPath, pathToFileURL(cliPath).href), true);
});

test('CLI starts when Node receives a real temporary symlink path', {
  skip: process.platform === 'win32' ? 'File symlink creation is privilege-dependent on Windows.' : false
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jev-cli-symlink-'));
  const entry = join(directory, 'jev');
  try {
    await symlink(resolve('scripts/jev-cli.mjs'), entry);
    const child = spawnSync(process.execPath, [entry, 'help'], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(JSON.parse(child.stdout).help.includes('jev evaluate'), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Windows installer only removes launchers created by the current attempt', async () => {
  const source = await readFile('scripts/install-jev-mcp-windows.ps1', 'utf8');
  assert.match(source, /\$jevLauncherCreated = \$false/);
  assert.match(source, /\$mcpLauncherCreated = \$false/);
  assert.match(source, /if \(\$jevLauncherCreated -and \(Test-Path -LiteralPath \$jevCommand\)\)/);
  assert.match(source, /if \(\$mcpLauncherCreated -and \(Test-Path -LiteralPath \$mcpCommand\)\)/);
  assert.ok(source.indexOf('& $npmCommand.Source test --prefix $stageRoot') < source.indexOf('Move-Item -LiteralPath $targetRoot -Destination $backupRoot'));
  assert.doesNotMatch(source, /foreach \(\$pair in .*\$jevCommand.*\$backupJev/);
});

test('Windows DPAPI reader refuses an unredirected or unowned output channel', async () => {
  const source = await readFile('scripts/read-jev-credential-windows.ps1', 'utf8');
  assert.match(source, /\[Console\]::IsOutputRedirected/);
  assert.match(source, /JEV_DPAPI_PIPE_NONCE/);
  assert.match(source, /PrivatePipeToken -cne/);
});
