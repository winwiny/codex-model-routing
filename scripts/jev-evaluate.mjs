#!/usr/bin/env node
// Compatibility file-based launcher used by the Windows PowerShell wrapper.
// New callers should use `jev evaluate < request.json`.
import { open, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { evaluateJev, getCredentialStatus } from './jev-core.mjs';
import { errorPayload, JevError, stableError } from './jev-errors.mjs';
import { parseAndNormalizeRequest } from './jev-schemas.mjs';
import { assertSafeRequest } from './jev-security.mjs';

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--check') options.check = true;
    else if (arg === '--allow-env') options.allowEnvironment = true;
    else if (arg === '--input' || arg === '--output') options[arg.slice(2)] = args[++index];
    else throw new JevError('arguments_invalid', 'Invalid compatibility launcher arguments.', 2);
  }
  if (!options.input || (!options.check && !options.output)) {
    throw new JevError('arguments_invalid', 'Input is required; output is required outside check mode.', 2);
  }
  return options;
}

export function parseInputBytes(bytes) {
  try {
    const text = bytes[0] === 0xff && bytes[1] === 0xfe
      ? new TextDecoder('utf-16le', { fatal: true }).decode(bytes.subarray(2))
      : new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw new JevError('input_json_or_encoding_invalid', 'Input is not valid supported JSON.', 2);
  }
}

function coreRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const { schemaVersion: _schemaVersion, purpose: _purpose, ...request } = input;
  return request;
}

export async function runLegacyCli(args = process.argv.slice(2), dependencies = {}) {
  const options = parseArgs(args);
  let bytes;
  try { bytes = await readFile(options.input); }
  catch { throw new JevError('input_not_readable', 'Input could not be read.', 2); }
  const input = coreRequest(parseInputBytes(bytes));
  assertSafeRequest(input);
  parseAndNormalizeRequest(input);
  const runtimeOptions = {
    ...dependencies,
    allowEnvironment: options.allowEnvironment || dependencies.allowEnvironment
      || process.env.JEV_CREDENTIAL_SOURCE === 'windows-dpapi'
  };
  if (options.check) {
    const credential = await getCredentialStatus(runtimeOptions);
    return {
      check: {
        node: process.versions.node,
        nodeSupported: Number(process.versions.node.split('.')[0]) >= 20,
        inputValid: true,
        model: 'jev-latest',
        credential,
        requestsAttempted: 0
      }
    };
  }
  let handle;
  try { handle = await open(options.output, 'wx', 0o600); }
  catch (error) {
    const code = error?.code === 'EEXIST' ? 'output_already_exists'
      : error?.code === 'ENOENT' ? 'output_parent_missing' : 'output_not_writable';
    throw new JevError(code, 'Output could not be created.', 2);
  }
  try {
    const result = await evaluateJev(input, runtimeOptions);
    await handle.writeFile(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  } finally {
    await handle.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runLegacyCli().then((result) => process.stdout.write(`${JSON.stringify(result)}\n`)).catch((error) => {
    const stable = stableError(error);
    process.stderr.write(`${JSON.stringify(errorPayload(stable))}\n`);
    process.exitCode = stable.exitCode;
  });
}
