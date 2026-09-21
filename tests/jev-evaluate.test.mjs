import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { TypeSafeClient } from '@typesafe-ai/sdk';
import { evaluateJev } from '../scripts/jev-core.mjs';
import {
  EnvironmentCredentialStore,
  MacOSKeychainCredentialStore,
  WindowsDpapiCredentialStore
} from '../scripts/jev-credentials.mjs';
import { JevError } from '../scripts/jev-errors.mjs';
import { parseAndNormalizeRequest } from '../scripts/jev-schemas.mjs';
import { runLegacyCli } from '../scripts/jev-evaluate.mjs';
import { runCli } from '../scripts/jev-cli.mjs';

const examplePath = resolve('examples/jev-request.json');
const example = JSON.parse(await readFile(examplePath, 'utf8'));
const fakeCredential = { apiKey: 'unit-test-credential-not-real', source: 'test' };

function responseFor(questions) {
  return {
    model: 'jev-test-model',
    answers: Object.fromEntries(Object.entries(questions).map(([id, question]) => {
      if (question.type === 'noul') return [id, { type: 'noul', noul: 0.75 }];
      if (question.type === 'choice') {
        const labels = Object.keys(question.criteria);
        return [id, { type: 'choice', choice: labels[0], confidence: 0.8, probabilities: Object.fromEntries(labels.map((label, index) => [label, index ? 0.2 / (labels.length - 1) : 0.8])) }];
      }
      return [id, { type: 'score', score: 0.5, confidence: 0.6, legend: Object.fromEntries(question.criteria.map((value, index) => [index, value])), probabilities: Object.fromEntries(question.criteria.map((_value, index) => [index, index ? 0.5 : 0.5])) }];
    })),
    usage: { input_tokens: 7, output_tokens: 3 }
  };
}

test('official schema accepts string/object/array/null entries and normalizes boolean to noul', () => {
  for (const state of ['text', { nested: [1, true, null, { text: 'x' }] }, ['a', { b: 2 }], null]) {
    const request = parseAndNormalizeRequest({
      state,
      questions: {
        yes: { type: 'noul', instructions: null, criteria: { true: { meaning: 'yes' }, false: ['no'] } },
        legacy: { type: 'boolean', instructions: ['compatibility', { only: true }], criteria: null },
        route: { type: 'choice', instructions: { task: 'choose' }, criteria: { a: null, b: ['other'] } },
        degree: { type: 'score', instructions: 'score', criteria: [null, { label: 'high' }] }
      }
    });
    assert.deepEqual(request.state, state);
    assert.equal(request.questions.legacy.type, 'noul');
  }
});

test('shared core maps through official SDK 0.6.0 with jev-latest', async () => {
  let requestBody;
  let requestUrl;
  const result = await evaluateJev({
    state: { text: 'fictional request' },
    questions: {
      legacy: { type: 'boolean', instructions: null },
      route: { type: 'choice', instructions: { choose: 'one' }, criteria: { code: null, review: ['unclear'] } },
      score: { type: 'score', instructions: ['rate'], criteria: [null, { high: true }] }
    },
    maxRetries: 0
  }, {
    credential: fakeCredential,
    clientFactory: ({ apiKey, request }) => new TypeSafeClient({
      apiKey,
      defaultModel: 'jev-latest',
      retry: { maxRetries: 0 },
      logLevel: 'off',
      fetch: async (url, init) => {
        requestUrl = url;
        requestBody = JSON.parse(init.body);
        return new Response(JSON.stringify(responseFor(request.questions)), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
    })
  });
  assert.equal(requestUrl, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(requestBody.model, 'jev-latest');
  assert.equal(requestBody.questions.legacy.type, 'noul');
  assert.equal(result.provider, 'typesafe-direct');
  assert.equal(result.answers.legacy.type, 'noul');
  assert.deepEqual(Object.keys(result.answers.legacy).sort(), ['noul', 'type']);
  assert.deepEqual(result.usage, { inputTokens: 7, outputTokens: 3, totalTokens: 10 });
});

test('rejects sensitive material and limits before creating an SDK client', async () => {
  let created = false;
  const clientFactory = () => { created = true; throw new Error('must not run'); };
  await assert.rejects(() => evaluateJev({
    state: { api_key: 'should-never-be-sent' },
    questions: { yes: { type: 'noul' } }
  }, { credential: fakeCredential, clientFactory }), (error) => error.code === 'sensitive_material_rejected');
  await assert.rejects(() => evaluateJev({
    state: 'x'.repeat(70 * 1024),
    questions: { yes: { type: 'noul' } }
  }, { credential: fakeCredential, clientFactory }), (error) => error.code === 'input_too_large');
  assert.equal(created, false);
});

test('question limits and stable SDK failure codes are enforced', async () => {
  const questions = Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`q${index}`, { type: 'noul' }]));
  await assert.rejects(() => evaluateJev({ state: 'x', questions }, { credential: fakeCredential }), (error) => error.code === 'input_schema_invalid');
  await assert.rejects(() => evaluateJev(example, {
    credential: fakeCredential,
    clientFactory: () => ({ systemOne: async () => { throw new Error('contains unit-test-credential-not-real'); } })
  }), (error) => error.code === 'evaluation_failed' && !error.message.includes(fakeCredential.apiKey));
  await assert.rejects(() => evaluateJev({ state: 'x', questions: { yes: { type: 'noul' } } }, {
    credential: fakeCredential,
    clientFactory: () => ({
      systemOne: async () => ({
        model: 'jev-test',
        answers: { yes: { type: 'noul', noul: 2 } },
        usage: { input_tokens: 1, output_tokens: 1 }
      })
    })
  }), (error) => error.code === 'response_schema_invalid');
});

test('macOS Keychain adapter is injectable and never places a key in arguments', async () => {
  let captured;
  const store = new MacOSKeychainCredentialStore({
    platform: 'darwin',
    account: 'test-user',
    execFileImpl: async (file, args, options) => {
      captured = { file, args, options };
      return { stdout: 'synthetic-key\n' };
    }
  });
  assert.deepEqual(await store.get(), { apiKey: 'synthetic-key', source: 'macos-keychain' });
  assert.equal(captured.file, '/usr/bin/security');
  assert.deepEqual(captured.args, ['find-generic-password', '-a', 'test-user', '-s', 'typesafe-ai-direct', '-w']);
  assert.equal(JSON.stringify(captured).includes('synthetic-key'), false);
});

test('Windows DPAPI adapter is injectable and environment fallback is explicit or CI-only', async () => {
  let argsSeen;
  let optionsSeen;
  const store = new WindowsDpapiCredentialStore({
    platform: 'win32',
    readerPath: resolve('scripts/read-jev-credential-windows.ps1'),
    powershellPath: 'powershell.exe',
    credentialPath: 'C:\\safe\\typesafe.dpapi',
    execFileImpl: async (_file, args, options) => { argsSeen = args; optionsSeen = options; return { stdout: 'synthetic-key' }; }
  });
  assert.equal((await store.get()).source, 'windows-dpapi-current-user');
  assert.deepEqual(argsSeen.slice(-2), ['-CredentialPath', 'C:\\safe\\typesafe.dpapi']);
  const tokenIndex = argsSeen.indexOf('-PrivatePipeToken');
  assert.ok(tokenIndex > 0);
  assert.equal(optionsSeen.env.JEV_DPAPI_PIPE_NONCE, argsSeen[tokenIndex + 1]);
  assert.equal(Object.hasOwn(optionsSeen.env, 'TYPESAFE_API_KEY'), false);
  assert.equal(await new EnvironmentCredentialStore({ env: { TYPESAFE_API_KEY: 'x' } }).get(), undefined);
  assert.equal((await new EnvironmentCredentialStore({ env: { TYPESAFE_API_KEY: 'x', CI: '1' } }).get()).source, 'environment-explicit');
});

test('legacy file wrapper checks offline, preserves encodings, and never overwrites output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jev-wrapper-'));
  const source = JSON.stringify(example);
  for (const [name, data] of [
    ['utf8-bom.json', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(source)])],
    ['utf16-le.json', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(source, 'utf16le')])]
  ]) {
    const path = join(dir, name);
    await writeFile(path, data);
    const result = await runLegacyCli(['--input', path, '--check'], {
      credentialStore: { get: async () => undefined }
    });
    assert.equal(result.check.requestsAttempted, 0);
    assert.equal(result.check.inputValid, true);
  }
  const output = join(dir, 'existing.json');
  await writeFile(output, 'keep');
  await assert.rejects(() => runLegacyCli(['--input', examplePath, '--output', output], {
    credential: fakeCredential,
    clientFactory: () => { throw new Error('must not run'); }
  }), (error) => error.code === 'output_already_exists');
  assert.equal(await readFile(output, 'utf8'), 'keep');
});

test('CLI doctor defaults to zero network requests', async () => {
  const result = await runCli(['doctor'], {
    credentialStore: {
      has: async () => true,
      get: async () => { throw new Error('doctor must not read the credential'); }
    }
  });
  assert.equal(result.requestsAttempted, 0);
  assert.equal(result.liveCheck, false);
});
