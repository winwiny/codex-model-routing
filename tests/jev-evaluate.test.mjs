import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { evaluateRequest, runCli } from '../scripts/jev-evaluate.mjs';

const examplePath = resolve('examples/jev-request.json');
const request = JSON.parse(await readFile(examplePath, 'utf8'));
const answerBody = {
  model: 'jev-1.13.0',
  answers: {
    task_route: {
      type: 'choice',
      choice: 'code',
      probabilities: { code: 0.8, reasoning: 0.1, review: 0.05, jev: 0.05 },
      confidence: 0.5
    },
    missing_price_guess: { type: 'noul', noul: 0.01 }
  },
  usage: { input_tokens: 3, output_tokens: 1 }
};

test('reads documented object-schema example and posts it unchanged', async () => {
  let captured;
  const result = await evaluateRequest(request, { apiKey: 'safe-test-key', fetchImpl: async (_url, options) => { captured = options; return { ok: true, status: 200, json: async () => answerBody }; } });
  assert.deepEqual(JSON.parse(captured.body), { model: 'jev-latest', state: request.state, questions: request.questions });
  assert.equal(captured.headers.authorization, 'Bearer safe-test-key');
  assert.equal(result.answers[0].status, 'review'); assert.equal(result.answers[1].answer.pTrue, 0.01); assert.equal(result.answers[1].confidence, null);
  assert.equal(result.provider, 'typesafe-direct');
  assert.equal(result.endpoint, 'https://api.typesafe.ai/v1/systemone');
  assert.deepEqual(result.usage, { inputTokens: 3, outputTokens: 1, totalTokens: 4 });
});

test('marks missing confidence and bad structures for review or validation fallback', async () => {
  const scoreInput = { ...request, questions: { score: { type: 'score', instructions: 'Score only.', criteria: ['low', 'high'] } } };
  const good = await evaluateRequest(scoreInput, { apiKey: 'safe-test-key', fetchImpl: async () => ({ ok: true, json: async () => ({ model: 'jev-1.13.0', answers: { score: { type: 'score', score: 0.5, legend: { 0: 'low', 1: 'high' }, probabilities: { 0: 0.5, 1: 0.5 } } } }) }) });
  assert.equal(good.answers[0].confidenceStatus, 'missing');
  const bad = await evaluateRequest(request, { apiKey: 'safe-test-key', fetchImpl: async () => ({ ok: true, json: async () => ({ ...answerBody, model: 'other' }) }) });
  assert.equal(bad.error.code, 'validation_failure');
});

test('does not retry failures and rejects a credential before producing evidence', async () => {
  let calls = 0;
  const unauthorized = await evaluateRequest(request, { apiKey: 'safe-test-key', fetchImpl: async () => { calls += 1; return { ok: false, status: 401 }; } });
  assert.equal(calls, 1); assert.equal(unauthorized.error.code, 'http_401');
  const timeout = await evaluateRequest(request, { apiKey: 'safe-test-key', timeoutMs: 1, fetchImpl: async (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error(), { name: 'AbortError' })))) });
  assert.equal(timeout.error.code, 'timeout');
  const secret = await evaluateRequest({ ...request, purpose: 'prefix safe-test-key suffix', state: { 'safe-test-key': 'present' } }, { apiKey: 'safe-test-key', fetchImpl: async () => { throw new Error('must not call'); } });
  assert.equal(secret.requestsAttempted, 0); assert.equal(JSON.stringify(secret).includes('safe-test-key'), false);
});

test('actual CLI check needs no output and output collision makes no request', async () => {
  const checked = spawnSync(process.execPath, ['scripts/jev-evaluate.mjs', '--input', examplePath, '--check'], { encoding: 'utf8' });
  assert.equal(checked.status, 0); assert.equal(JSON.parse(checked.stdout).check.requestsAttempted, 0);
  const dir = await mkdtemp(join(tmpdir(), 'jev-test-')); const output = join(dir, 'out.json'); await writeFile(output, 'exists');
  await assert.rejects(() => runCli(['--input', examplePath, '--output', output], { apiKey: 'safe-test-key', fetchImpl: async () => { throw new Error('must not call'); } }));
  assert.equal(await readFile(output, 'utf8'), 'exists');
});

test('missing credential keeps readable evidence and response metadata cannot leak a credential', async () => {
  const missing = await evaluateRequest(request, { apiKey: '' });
  assert.equal(missing.purpose, request.purpose);
  assert.equal(missing.requestsAttempted, 0);
  const body = structuredClone(answerBody);
  body.model = 'prefix safe-test-key suffix';
  body.usage = { input_tokens: 12, output_tokens: 4, secret: 'safe-test-key' };
  const result = await evaluateRequest(request, { apiKey: 'safe-test-key', fetchImpl: async () => ({ ok: true, json: async () => body }) });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'validation_failure');
  assert.equal(JSON.stringify(result).includes('safe-test-key'), false);
});

test('actual CLI accepts Windows PowerShell UTF-8 BOM and UTF-16LE JSON without a request', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jev-encoding-'));
  const source = JSON.stringify(request);
  for (const [name, data] of [
    ['utf8-bom.json', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(source, 'utf8')])],
    ['utf16-le.json', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(source, 'utf16le')])]
  ]) {
    const path = join(dir, name);
    await writeFile(path, data);
    const child = spawnSync(process.execPath, ['scripts/jev-evaluate.mjs', '--input', path, '--check'], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(JSON.parse(child.stdout).check.requestsAttempted, 0);
  }
});

test('preflight errors distinguish malformed JSON from absent output directories without leaking input', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jev-errors-'));
  const invalid = join(dir, 'invalid.json');
  await writeFile(invalid, '{sensitive invalid body');
  const child = spawnSync(process.execPath, ['scripts/jev-evaluate.mjs', '--input', invalid, '--check'], { encoding: 'utf8' });
  assert.equal(child.status, 1);
  const diagnostic = JSON.parse(child.stderr);
  assert.equal(diagnostic.error.code, 'input_json_or_encoding_invalid');
  assert.equal(diagnostic.requestsAttempted, 0);
  assert.equal(child.stderr.includes('sensitive'), false);
  await assert.rejects(() => runCli(['--input', examplePath, '--output', join(dir, 'missing', 'out.json')], { fetchImpl: () => { throw new Error('No request expected'); } }), { preflightCode: 'output_parent_missing' });
});
