#!/usr/bin/env node
import { MAX_INPUT_BYTES, MODEL } from './jev-constants.mjs';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { evaluateJev, getCredentialStatus } from './jev-core.mjs';
import { errorPayload, JevError, stableError } from './jev-errors.mjs';
import { parseAndNormalizeRequest } from './jev-schemas.mjs';
import { assertSafeRequest } from './jev-security.mjs';

function writeJson(stream, value) { stream.write(`${JSON.stringify(value, null, 2)}\n`); }

async function readStdin() {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    total += bytes.length;
    if (total > MAX_INPUT_BYTES) throw new JevError('input_too_large', 'The request exceeds the byte limit.', 2);
    chunks.push(bytes);
  }
  if (!total) throw new JevError('input_missing', 'JSON input is required.', 2);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '')); }
  catch { throw new JevError('input_json_invalid', 'stdin is not valid JSON.', 2); }
}

function parseOptions(args) {
  let live = false;
  let allowEnvironment = false;
  for (const arg of args) {
    if (arg === '--live') live = true;
    else if (arg === '--allow-env') allowEnvironment = true;
    else throw new JevError('arguments_invalid', 'Unknown command option.', 2);
  }
  return { live, allowEnvironment };
}

export async function runCli(argv = process.argv.slice(2), dependencies = {}) {
  const [command = 'help', ...args] = argv;
  if (['help', '--help', '-h'].includes(command)) {
    return { help: 'jev evaluate [--allow-env] < request.json | jev doctor [--live] [--allow-env]' };
  }
  const options = parseOptions(args);
  const runtimeOptions = { ...dependencies, allowEnvironment: options.allowEnvironment || dependencies.allowEnvironment };
  if (command === 'evaluate') {
    if (options.live) throw new JevError('arguments_invalid', 'evaluate does not accept --live.', 2);
    return evaluateJev(await (dependencies.readInput?.() ?? readStdin()), runtimeOptions);
  }
  if (command === 'doctor') {
    const status = await getCredentialStatus(runtimeOptions);
    const report = {
      ok: Number(process.versions.node.split('.')[0]) >= 20 && status.configured,
      node: process.version,
      nodeSupported: Number(process.versions.node.split('.')[0]) >= 20,
      platform: process.platform,
      model: MODEL,
      credential: status,
      liveCheck: false,
      requestsAttempted: 0
    };
    if (options.live) {
      const request = {
        state: { message: 'The customer needs a quote by tomorrow.' },
        questions: { urgent: { type: 'noul', instructions: 'Does `message` contain an explicit near-term deadline?' } },
        maxRetries: 0
      };
      assertSafeRequest(request);
      parseAndNormalizeRequest(request);
      const result = await evaluateJev(request, runtimeOptions);
      report.liveCheck = true;
      report.requestsAttempted = 1;
      report.responseModel = result.model;
      report.usage = result.usage;
    }
    return report;
  }
  throw new JevError('command_unknown', 'Unknown command.', 2);
}

export function isMainModule(argv1 = process.argv[1], moduleUrl = import.meta.url) {
  if (!argv1) return false;
  try { return moduleUrl === pathToFileURL(realpathSync(resolve(argv1))).href; }
  catch { return false; }
}

if (isMainModule()) {
  runCli().then((result) => writeJson(process.stdout, result)).catch((error) => {
    const stable = stableError(error);
    writeJson(process.stderr, errorPayload(stable));
    process.exitCode = stable.exitCode;
  });
}
