#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MODEL = 'jev-latest';
const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const TIMEOUT_MS = 25_000;
class ValidationError extends Error {}
const isUnit = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const entries = (input) => Object.entries(input.questions);

export function assertInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || typeof input.schemaVersion !== 'string' || !input.schemaVersion
    || typeof input.purpose !== 'string' || input.model !== MODEL
    || !Object.hasOwn(input, 'state') || !input.questions
    || typeof input.questions !== 'object' || Array.isArray(input.questions)
    || Object.keys(input.questions).length === 0) {
    throw new ValidationError('Input must use the documented Jev request object schema.');
  }
  for (const [id, question] of entries(input)) {
    if (!id || !question || typeof question !== 'object'
      || typeof question.instructions !== 'string'
      || !['choice', 'noul', 'score'].includes(question.type)) {
      throw new ValidationError('Each keyed question needs a supported type and instructions.');
    }
    if (question.type === 'choice'
      && (!question.criteria || typeof question.criteria !== 'object'
        || Array.isArray(question.criteria) || Object.keys(question.criteria).length === 0)) {
      throw new ValidationError('Choice criteria must be a non-empty keyed object.');
    }
    if (question.type === 'score'
      && (!Array.isArray(question.criteria) || question.criteria.length < 2 || question.criteria.length > 10)) {
      throw new ValidationError('Score criteria must contain between 2 and 10 ordered levels.');
    }
  }
  return input;
}

export function containsCredential(value, key) {
  if (typeof value === 'string') {
    return (key && value.includes(key))
      || /\bvck_[A-Za-z0-9_-]{16,}\b/.test(value)
      || /\bsk-[A-Za-z0-9_-]{20,}\b/.test(value)
      || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(value);
  }
  if (Array.isArray(value)) return value.some((item) => containsCredential(item, key));
  return Boolean(value && typeof value === 'object' && Object.entries(value).some(([name, child]) => {
    if (/(?:^|_)(?:api_?key|private_?key|seed_?phrase|mnemonic|authorization|signature|secret)(?:$|_)/i.test(name)) {
      return child !== null && child !== undefined && child !== '';
    }
    return containsCredential(child, key);
  }));
}

function redactText(value, key) {
  let result = value
    .replace(/\bvck_[A-Za-z0-9_-]{16,}\b/g, '[redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, '[redacted]');
  if (key) result = result.replaceAll(key, '[redacted]');
  return result;
}

function safeEvidence(value, key) {
  if (typeof value === 'string') return redactText(value, key);
  if (Array.isArray(value)) return value.map((item) => safeEvidence(item, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, child]) => [redactText(name, key), safeEvidence(child, key)]));
  }
  return value;
}

function validProbabilities(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length > 0 && Object.values(value).every(isUnit);
}

function validReturnedModel(value) {
  return typeof value === 'string' && /^jev(?:-|$)/.test(value);
}

export function validateEvaluationResponse(input, response) {
  if (!response || typeof response !== 'object' || !validReturnedModel(response.model)
    || !response.answers || typeof response.answers !== 'object' || Array.isArray(response.answers)) {
    throw new ValidationError('Response model or answer object is invalid.');
  }
  const expected = entries(input);
  const ids = new Set(expected.map(([id]) => id));
  if (Object.keys(response.answers).length !== ids.size
    || Object.keys(response.answers).some((id) => !ids.has(id))) {
    throw new ValidationError('Response answer ids are invalid.');
  }
  return expected.map(([id, question]) => {
    const answer = response.answers[id];
    if (!answer || typeof answer !== 'object' || answer.type !== question.type) {
      throw new ValidationError('Response answer type is invalid.');
    }
    const record = {
      questionId: id,
      type: question.type,
      status: 'accepted',
      answer: {},
      rawConfidence: null,
      confidence: null,
      confidenceStatus: 'not_applicable'
    };
    if (question.type === 'choice') {
      if (!Object.hasOwn(question.criteria, answer.choice) || !validProbabilities(answer.probabilities)) {
        throw new ValidationError('Response choice or probabilities are invalid.');
      }
      record.answer = { choice: answer.choice, probabilities: answer.probabilities };
    } else if (question.type === 'noul') {
      if (!isUnit(answer.noul)) throw new ValidationError('Response noul probability is invalid.');
      record.answer = { pTrue: answer.noul };
      record.confidenceNote = 'N/A (Noul does not provide a separate confidence value).';
      return record;
    } else {
      if (typeof answer.score !== 'number' || !Number.isFinite(answer.score)
        || !validProbabilities(answer.probabilities)
        || !answer.legend || typeof answer.legend !== 'object' || Array.isArray(answer.legend)) {
        throw new ValidationError('Response score, legend, or probabilities are invalid.');
      }
      record.answer = { score: answer.score, legend: answer.legend, probabilities: answer.probabilities };
    }
    if (!isUnit(answer.confidence)) {
      record.status = 'review';
      record.confidenceStatus = answer.confidence === undefined ? 'missing' : 'invalid';
      record.confidenceNote = answer.confidence === undefined ? 'Missing confidence.' : 'Invalid confidence was returned.';
    } else {
      record.rawConfidence = answer.confidence;
      record.confidence = answer.confidence;
      record.confidenceStatus = 'provided';
      record.status = answer.confidence < 0.8 ? 'review' : 'not_flagged';
      record.confidenceNote = 'Temporary uncalibrated review threshold; not authorization or correctness guarantee.';
    }
    return record;
  });
}

function usageEvidence(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const normalized = {};
  for (const [source, target] of [['input_tokens', 'inputTokens'], ['output_tokens', 'outputTokens']]) {
    if (typeof usage[source] === 'number' && Number.isInteger(usage[source]) && usage[source] >= 0) {
      normalized[target] = usage[source];
    }
  }
  if (normalized.inputTokens !== undefined && normalized.outputTokens !== undefined) {
    normalized.totalTokens = normalized.inputTokens + normalized.outputTokens;
  }
  return Object.keys(normalized).length ? normalized : null;
}

export async function evaluateRequest(input, {
  fetchImpl = globalThis.fetch,
  apiKey = process.env.TYPESAFE_API_KEY,
  timeoutMs = TIMEOUT_MS,
  now = () => new Date()
} = {}) {
  assertInput(input);
  const started = Date.now();
  const evidence = {
    schemaVersion: input.schemaVersion,
    inputSha256: createHash('sha256').update(JSON.stringify(input)).digest('hex'),
    purpose: redactText(input.purpose, apiKey),
    provider: 'typesafe-direct',
    endpoint: ENDPOINT,
    requestedModel: MODEL,
    returnedModel: null,
    startedAt: now().toISOString(),
    durationMs: 0,
    requestsAttempted: 0,
    successfulEvaluations: 0,
    failedEvaluations: 0,
    status: 'failed',
    answers: [],
    usage: null,
    error: null
  };
  if (!apiKey) {
    evidence.error = { code: 'missing_api_key', message: 'TYPESAFE_API_KEY is not configured.' };
    return safeEvidence(evidence, apiKey);
  }
  if (containsCredential(input, apiKey)) {
    evidence.error = { code: 'credential_in_input', message: 'Input appears to contain a credential and was not sent.' };
    return safeEvidence(evidence, apiKey);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  evidence.requestsAttempted = 1;
  try {
    const response = await fetchImpl(ENDPOINT, {
      method: 'POST',
      redirect: 'error',
      signal: controller.signal,
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, state: input.state, questions: input.questions })
    });
    if (!response?.ok) throw Object.assign(new Error('HTTP failure'), { kind: 'http', status: response?.status });
    const body = await response.json();
    evidence.returnedModel = typeof body?.model === 'string' ? body.model : null;
    evidence.answers = validateEvaluationResponse(input, body);
    evidence.usage = usageEvidence(body.usage);
    evidence.successfulEvaluations = 1;
    evidence.status = 'success';
  } catch (error) {
    evidence.failedEvaluations = 1;
    if (error instanceof ValidationError) {
      evidence.error = { code: 'validation_failure', message: 'Evaluation response failed validation.' };
    } else if (error?.kind === 'http') {
      evidence.error = { code: `http_${error.status ?? 'unknown'}`, message: 'TypeSafe API returned an error.' };
    } else if (error?.name === 'AbortError') {
      evidence.error = { code: 'timeout', message: 'Evaluation timed out.' };
    } else {
      evidence.error = { code: 'request_failed', message: 'Evaluation request failed.' };
    }
  } finally {
    clearTimeout(timer);
    evidence.durationMs = Date.now() - started;
  }
  return safeEvidence(evidence, apiKey);
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--check') options.check = true;
    else if (args[index] === '--input' || args[index] === '--output') options[args[index].slice(2)] = args[++index];
    else throw new Error('Usage: node scripts/jev-evaluate.mjs --input <json> [--output <evidence.json>] [--check]');
  }
  if (!options.input || (!options.check && !options.output)) {
    throw new Error('An input is required; output is required except with --check.');
  }
  return options;
}

function preflightError(code) {
  return Object.assign(new Error('Jev preflight failed.'), { preflightCode: code });
}

export function parseInputBytes(bytes) {
  let text;
  try {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      text = new TextDecoder('utf-16le', { fatal: true }).decode(bytes.subarray(2));
    } else {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    }
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw preflightError('input_json_or_encoding_invalid');
  }
}

export async function runCli(args = process.argv.slice(2), dependencies = {}) {
  let options;
  try { options = parseArgs(args); } catch { throw preflightError('arguments_invalid'); }
  let bytes;
  try { bytes = await readFile(options.input); } catch { throw preflightError('input_not_readable'); }
  let input = parseInputBytes(bytes);
  try { input = assertInput(input); } catch { throw preflightError('input_schema_invalid'); }
  const nodeSupported = Number(process.versions.node.split('.')[0]) >= 22;
  if (!nodeSupported) throw preflightError('node_version_unsupported');
  if (options.check) {
    return {
      check: {
        node: process.versions.node,
        nodeSupported,
        inputValid: true,
        provider: 'typesafe-direct',
        endpoint: ENDPOINT,
        model: MODEL,
        apiKeyConfigured: Boolean(dependencies.apiKey ?? process.env.TYPESAFE_API_KEY),
        credentialSource: 'process_environment_only',
        credentialHint: 'On Windows, use jev-windows.ps1 to load the existing DPAPI credential.',
        requestsAttempted: 0
      }
    };
  }
  let handle;
  try { handle = await open(options.output, 'wx'); } catch (error) {
    throw preflightError(error.code === 'EEXIST' ? 'output_already_exists'
      : error.code === 'ENOENT' ? 'output_parent_missing' : 'output_not_writable');
  }
  try {
    const evidence = await evaluateRequest(input, dependencies);
    await handle.writeFile(`${JSON.stringify(evidence, null, 2)}\n`);
    return evidence;
  } finally {
    await handle.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli().then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status && result.status !== 'success') process.exitCode = 1;
  }).catch((error) => {
    process.stderr.write(`${JSON.stringify({
      status: error.preflightCode ? 'preflight_failed' : 'local_io_failure',
      error: { code: error.preflightCode ?? 'local_io_failure' },
      requestsAttempted: error.preflightCode ? 0 : null,
      confidence: null
    })}\n`);
    process.exitCode = 1;
  });
}
