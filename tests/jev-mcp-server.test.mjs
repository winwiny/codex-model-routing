import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import {
  createEvaluationGate,
  createToolHandlers,
  getAuditRecord
} from '../scripts/jev-mcp-server.mjs';

const request = {
  state: { text: 'fictional input' },
  questions: { relevant: { type: 'noul', instructions: null } },
  maxRetries: 0
};

const success = {
  status: 'success',
  provider: 'typesafe-direct',
  model: 'jev-test',
  answers: { relevant: { type: 'noul', noul: 0.9 } },
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
};

test('default stdio MCP exposes only canonical tools', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve('scripts/jev-mcp-server.mjs')],
    stderr: 'pipe'
  });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ['typesafe_check', 'typesafe_evaluate']);
  } finally {
    await client.close();
  }
});

test('STDIO MCP starts when Node receives a real temporary symlink path', {
  skip: process.platform === 'win32' ? 'File symlink creation is privilege-dependent on Windows.' : false
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jev-mcp-symlink-'));
  const entry = join(directory, 'jev-mcp');
  await symlink(resolve('scripts/jev-mcp-server.mjs'), entry);
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], stderr: 'pipe' });
  const client = new Client({ name: 'symlink-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ['typesafe_check', 'typesafe_evaluate']);
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('explicit beta mode exposes legacy evaluate and record aliases', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve('scripts/jev-mcp-server.mjs')],
    env: { ...process.env, JEV_ENABLE_BETA_ALIASES: '1', JEV_ENABLE_RECORDS: '1' },
    stderr: 'pipe'
  });
  const client = new Client({ name: 'beta-list-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
      'jev_check', 'jev_evaluate', 'jev_get_record',
      'typesafe_check', 'typesafe_evaluate', 'typesafe_get_record'
    ]);
  } finally {
    await client.close();
  }
});

test('legacy beta input is converted and evaluated exactly once through the shared gate', async () => {
  let calls = 0;
  let captured;
  const handlers = createToolHandlers({
    evaluateFunction: async (input) => { calls += 1; captured = input; return success; }
  });
  const result = await handlers.evaluateBeta({
    schemaVersion: 'legacy-v1',
    purpose: 'Compatibility test only.',
    ...request
  });
  assert.equal(calls, 1);
  assert.equal(result.structuredContent.status, 'success');
  assert.deepEqual(captured, request);
  assert.equal(Object.hasOwn(captured, 'schemaVersion'), false);
  assert.equal(Object.hasOwn(captured, 'purpose'), false);
});

test('MCP evaluate returns result in structuredContent and does not persist by default', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'jev-mcp-stateless-'));
  let calls = 0;
  const handlers = createToolHandlers({ dataDir, evaluateFunction: async () => { calls += 1; return success; } });
  const result = await handlers.evaluate(request);
  assert.equal(calls, 1);
  assert.deepEqual(result.structuredContent, success);
  assert.deepEqual(JSON.parse(result.content[0].text), success);
  await assert.rejects(() => access(join(dataDir, 'records')));
});

test('single-concurrency gate rejects overlap without a second model call', async () => {
  let calls = 0;
  let release;
  const pending = new Promise((resolvePromise) => { release = resolvePromise; });
  const handlers = createToolHandlers({
    evaluateFunction: async () => { calls += 1; await pending; return success; }
  });
  const first = handlers.evaluate(request);
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  const second = await handlers.evaluate(request);
  assert.equal(second.isError, true);
  assert.equal(second.structuredContent.error.code, 'evaluation_already_in_progress');
  assert.equal(calls, 1);
  release();
  await first;
});

test('twenty-per-minute limiter uses one shared gate', async () => {
  const gate = createEvaluationGate({ now: () => 123_000, maxPerMinute: 2 });
  const handlers = createToolHandlers({ gate, evaluateFunction: async () => success });
  assert.equal((await handlers.evaluate(request)).structuredContent.status, 'success');
  assert.equal((await handlers.evaluate(request)).structuredContent.status, 'success');
  const limited = await handlers.evaluate(request);
  assert.equal(limited.isError, true);
  assert.equal(limited.structuredContent.error.code, 'evaluation_rate_limited');
});

test('optional records contain results only and reject arbitrary paths', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'jev-mcp-records-'));
  const handlers = createToolHandlers({ dataDir, enableRecords: true, evaluateFunction: async () => success });
  const evaluated = await handlers.evaluate(request);
  assert.match(evaluated.structuredContent.recordId, /^jev-/);
  const stored = await getAuditRecord(evaluated.structuredContent.recordId, { dataDir, enableRecords: true });
  assert.deepEqual(stored.result, success);
  assert.equal(JSON.stringify(stored).includes('fictional input'), false);
  assert.equal(JSON.parse(await readFile(join(dataDir, `${stored.recordId}.json`), 'utf8')).recordId, stored.recordId);
  await assert.rejects(() => getAuditRecord('../secret', { dataDir, enableRecords: true }), (error) => error.code === 'record_id_invalid');
});

test('offline check reports zero requests with an injected credential adapter', async () => {
  const handlers = createToolHandlers({
    credentialStore: { get: async () => ({ apiKey: 'synthetic', source: 'test-store' }) }
  });
  const checked = await handlers.check();
  assert.equal(checked.structuredContent.requestsAttempted, 0);
  assert.deepEqual(checked.structuredContent.credential, { configured: true, source: 'test-store' });
  assert.equal(JSON.stringify(checked).includes('synthetic'), false);
});
