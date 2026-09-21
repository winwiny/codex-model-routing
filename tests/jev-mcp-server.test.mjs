import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkJev, evaluateJev, getJevRecord } from '../scripts/jev-mcp-server.mjs';

function successfulEvidence() {
  return {
    schemaVersion: 'test-v1',
    provider: 'typesafe-direct',
    requestedModel: 'jev-latest',
    returnedModel: 'jev-1.13.0',
    status: 'success',
    requestsAttempted: 1,
    successfulEvaluations: 1,
    failedEvaluations: 0,
    answers: []
  };
}

test('jev_check uses the launcher in offline mode and removes raw input', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'jev-mcp-check-'));
  let seenArgs;
  const execFileImpl = async (_file, args) => {
    seenArgs = args;
    return { stdout: JSON.stringify({ check: { inputValid: true, apiKeyConfigured: true, requestsAttempted: 0 } }), stderr: '' };
  };
  try {
    const result = await checkJev({ dataDir, execFileImpl, launcherPath: 'launcher.ps1', powershellPath: 'powershell.exe' });
    assert.equal(result.check.requestsAttempted, 0);
    assert.ok(seenArgs.includes('-Check'));
    assert.deepEqual(await readdir(join(dataDir, 'tmp')), []);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('jev_evaluate fixes the model, keeps sanitized evidence, and removes raw input', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'jev-mcp-eval-'));
  const execFileImpl = async (_file, args) => {
    const inputPath = args[args.indexOf('-InputPath') + 1];
    const outputPath = args[args.indexOf('-OutputPath') + 1];
    const request = JSON.parse(await readFile(inputPath, 'utf8'));
    assert.equal(request.model, 'jev-latest');
    await import('node:fs/promises').then(({ writeFile }) => writeFile(outputPath, JSON.stringify(successfulEvidence())));
    return { stdout: '', stderr: '' };
  };
  try {
    const result = await evaluateJev({
      schemaVersion: 'test-v1',
      purpose: 'test only',
      state: 'fictional state',
      questions: { route: { type: 'choice', instructions: 'Choose.', criteria: { code: 'Exact.', review: 'Unknown.' } } }
    }, { dataDir, execFileImpl, launcherPath: 'launcher.ps1', powershellPath: 'powershell.exe' });
    assert.equal(result.evidence.status, 'success');
    assert.match(result.recordId, /^jev-/);
    assert.deepEqual(await readdir(join(dataDir, 'tmp')), []);
    assert.equal((await getJevRecord(result.recordId, { dataDir })).evidence.status, 'success');
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('jev_evaluate rejects credentials before invoking the launcher', async () => {
  let invoked = false;
  await assert.rejects(() => evaluateJev({
    schemaVersion: 'test-v1',
    purpose: 'test only',
    state: { api_key: 'secret-value' },
    questions: { present: { type: 'noul', instructions: 'Is it present?' } }
  }, { dataDir: join(tmpdir(), `jev-mcp-secret-${Date.now()}`), execFileImpl: async () => { invoked = true; } }), /sensitive_material_rejected/);
  assert.equal(invoked, false);
});

test('jev_evaluate rejects oversized inputs', async () => {
  await assert.rejects(() => evaluateJev({
    schemaVersion: 'test-v1',
    purpose: 'test only',
    state: 'x'.repeat(70 * 1024),
    questions: { present: { type: 'noul', instructions: 'Is it present?' } }
  }, { dataDir: join(tmpdir(), `jev-mcp-large-${Date.now()}`) }), /input_too_large/);
});

test('jev_get_record rejects arbitrary paths', async () => {
  await assert.rejects(() => getJevRecord('..\\config.toml'), /Invalid string/);
});
