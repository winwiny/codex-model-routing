#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MODEL = 'typesafe-ai/jev';
const ENDPOINT = 'https://ai-gateway.vercel.sh/v1/evaluate';
const TIMEOUT_MS = 25_000;
class ValidationError extends Error {}
const isUnit = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
const scalar = (v) => ['string', 'number', 'boolean'].includes(typeof v) && (typeof v !== 'number' || Number.isFinite(v));
const entries = (input) => Object.entries(input.questions);

export function assertInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.schemaVersion !== 'string' || !input.schemaVersion || typeof input.purpose !== 'string' || input.model !== MODEL || !Object.hasOwn(input, 'state') || !input.questions || typeof input.questions !== 'object' || Array.isArray(input.questions) || Object.keys(input.questions).length === 0) throw new ValidationError('Input must use the documented Jev request object schema.');
  for (const [id, q] of entries(input)) {
    if (!id || !q || typeof q !== 'object' || typeof q.instructions !== 'string' || !['choice', 'boolean', 'score'].includes(q.type)) throw new ValidationError('Each keyed question needs type and instructions.');
    if (q.type === 'choice' && (!q.criteria || typeof q.criteria !== 'object' || Array.isArray(q.criteria) || Object.keys(q.criteria).length === 0)) throw new ValidationError('Choice criteria must be a non-empty keyed object.');
  }
  return input;
}

export function containsCredential(value, key) {
  if (typeof value === 'string') return (key && value.includes(key)) || /vck_[A-Za-z0-9_-]{16,}/.test(value);
  if (Array.isArray(value)) return value.some((v) => containsCredential(v, key));
  return Boolean(value && typeof value === 'object' && Object.entries(value).some(([name, v]) => containsCredential(name, key) || containsCredential(v, key)));
}

function redactText(value, key) {
  const result = value.replace(/vck_[A-Za-z0-9_-]{16,}/g, '[redacted]');
  return key ? result.replaceAll(key, '[redacted]') : result;
}

function safeEvidence(value, key) {
  if (typeof value === 'string') return redactText(value, key);
  if (Array.isArray(value)) return value.map((item) => safeEvidence(item, key));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [redactText(k, key), safeEvidence(v, key)]));
  return value;
}

function validProbabilities(v) { return (Array.isArray(v) && v.every(isUnit)) || (v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every(isUnit)); }
function gatewayEvidence(metadata) {
  const g = metadata?.gateway;
  if (!g || typeof g !== 'object') return { value: null, invalidFields: [] };
  const value = {}; const invalidFields = [];
  for (const key of ['generationId', 'cost', 'marketCost', 'gatewayCost', 'surchargeCost']) {
    if (g[key] !== undefined) { if (scalar(g[key])) value[key] = g[key]; else invalidFields.push(key); }
  }
  if (g.routing && typeof g.routing === 'object') {
    value.routing = {};
    for (const key of ['originalModelId', 'resolvedProvider', 'canonicalSlug', 'finalProvider', 'modelAttemptCount', 'totalProviderAttemptCount']) {
      if (g.routing[key] !== undefined) { if (scalar(g.routing[key])) value.routing[key] = g.routing[key]; else invalidFields.push(`routing.${key}`); }
    }
  }
  return { value: Object.keys(value).length ? value : null, invalidFields };
}

export function validateEvaluationResponse(input, response) {
  if (!response || typeof response !== 'object' || response.model !== MODEL || !response.answers || typeof response.answers !== 'object' || Array.isArray(response.answers)) throw new ValidationError('Response model or answer object is invalid.');
  const expected = entries(input); const ids = new Set(expected.map(([id]) => id));
  if (Object.keys(response.answers).length !== ids.size || Object.keys(response.answers).some((id) => !ids.has(id))) throw new ValidationError('Response answer ids are invalid.');
  const confidenceMap = response.providerMetadata?.typesafe?.confidence ?? {};
  return expected.map(([id, q]) => {
    const answer = response.answers[id]?.answer ?? response.answers[id];
    if (!answer || typeof answer !== 'object' || answer.type !== q.type) throw new ValidationError('Response answer type is invalid.');
    const record = { questionId: id, type: q.type, status: 'accepted', answer: {}, rawConfidence: null, confidence: null, confidenceStatus: 'not_applicable' };
    if (q.type === 'choice') {
      if (!Object.hasOwn(q.criteria, answer.choice) || (answer.probabilities !== undefined && !validProbabilities(answer.probabilities))) throw new ValidationError('Response choice or probabilities are invalid.');
      record.answer = { choice: answer.choice, ...(answer.probabilities === undefined ? {} : { probabilities: answer.probabilities }) };
    } else if (q.type === 'boolean') {
      const pTrue = answer.probability ?? answer.pTrue;
      if (!isUnit(pTrue)) throw new ValidationError('Response boolean probability is invalid.');
      record.answer = { pTrue }; record.confidenceNote = 'N/A (boolean type does not provide confidence)'; return record;
    } else {
      if (typeof answer.score !== 'number' || !Number.isFinite(answer.score) || (answer.probabilities !== undefined && !validProbabilities(answer.probabilities))) throw new ValidationError('Response score or probabilities are invalid.');
      record.answer = { score: answer.score, ...(answer.probabilities === undefined ? {} : { probabilities: answer.probabilities }) };
    }
    const candidate = answer.confidence ?? confidenceMap[id];
    if (candidate === undefined) { record.status = 'review'; record.confidenceStatus = 'missing'; record.confidenceNote = 'Missing confidence.'; }
    else if (!isUnit(candidate)) { record.status = 'review'; record.confidenceStatus = 'invalid'; record.confidenceNote = 'Invalid confidence was returned.'; }
    else { record.rawConfidence = candidate; record.confidence = candidate; record.confidenceStatus = 'provided'; record.status = candidate < 0.8 ? 'review' : 'not_flagged'; record.confidenceNote = 'Temporary uncalibrated review threshold; not authorization or correctness guarantee.'; }
    return record;
  });
}

export async function evaluateRequest(input, { fetchImpl = globalThis.fetch, apiKey = process.env.AI_GATEWAY_API_KEY, timeoutMs = TIMEOUT_MS, now = () => new Date() } = {}) {
  assertInput(input);
  const started = Date.now();
  const evidence = { schemaVersion: input.schemaVersion, inputSha256: createHash('sha256').update(JSON.stringify(input)).digest('hex'), purpose: redactText(input.purpose, apiKey), requestedModel: MODEL, returnedModel: null, startedAt: now().toISOString(), durationMs: 0, requestsAttempted: 0, successfulEvaluations: 0, failedEvaluations: 0, status: 'failed', answers: [], usage: null, gateway: null, gatewayInvalidFields: [], error: null };
  if (!apiKey) { evidence.error = { code: 'missing_api_key', message: 'AI_GATEWAY_API_KEY is not configured.' }; return safeEvidence(evidence, apiKey); }
  if (containsCredential(input, apiKey)) { evidence.error = { code: 'credential_in_input', message: 'Input appears to contain a credential and was not sent.' }; return safeEvidence(evidence, apiKey); }
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs); evidence.requestsAttempted = 1;
  try {
    const response = await fetchImpl(ENDPOINT, { method: 'POST', redirect: 'error', signal: controller.signal, headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: MODEL, state: input.state, questions: input.questions, ...(input.providerOptions === undefined ? {} : { providerOptions: input.providerOptions }) }) });
    if (!response?.ok) throw Object.assign(new Error('HTTP failure'), { kind: 'http', status: response?.status });
    const body = await response.json(); evidence.returnedModel = typeof body?.model === 'string' ? body.model : null; evidence.answers = validateEvaluationResponse(input, body);
    evidence.usage = body.usage && typeof body.usage === 'object' ? Object.fromEntries(['inputTokens', 'outputTokens', 'totalTokens'].filter((key) => typeof body.usage[key] === 'number' && Number.isFinite(body.usage[key]) && body.usage[key] >= 0).map((key) => [key, body.usage[key]])) : null;
    const gateway = gatewayEvidence(body.providerMetadata); evidence.gateway = gateway.value; evidence.gatewayInvalidFields = gateway.invalidFields; evidence.successfulEvaluations = 1; evidence.status = 'success';
  } catch (error) {
    evidence.failedEvaluations = 1;
    if (error instanceof ValidationError) evidence.error = { code: 'validation_failure', message: 'Evaluation response failed validation.' };
    else if (error?.kind === 'http') evidence.error = { code: `http_${error.status ?? 'unknown'}`, message: 'Evaluation service returned an error.' };
    else if (error?.name === 'AbortError') evidence.error = { code: 'timeout', message: 'Evaluation timed out.' };
    else evidence.error = { code: 'request_failed', message: 'Evaluation request failed.' };
  } finally { clearTimeout(timer); evidence.durationMs = Date.now() - started; }
  return safeEvidence(evidence, apiKey);
}

function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 1) { if (args[i] === '--check') options.check = true; else if (args[i] === '--input' || args[i] === '--output') options[args[i].slice(2)] = args[++i]; else throw new Error('Usage: node scripts/jev-evaluate.mjs --input <json> [--output <evidence.json>] [--check]'); }
  if (!options.input || (!options.check && !options.output)) throw new Error('An input is required; output is required except with --check.'); return options;
}

function preflightError(code) {
  return Object.assign(new Error('Jev preflight failed.'), { preflightCode: code });
}

export function parseInputBytes(bytes) {
  let text;
  try {
    // Windows PowerShell 5.1 commonly writes UTF-8 BOM or UTF-16LE BOM JSON.
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
  if (options.check) return { check: { node: process.versions.node, nodeSupported, inputValid: true, apiKeyConfigured: Boolean(dependencies.apiKey ?? process.env.AI_GATEWAY_API_KEY), credentialSource: 'process_environment_only', credentialHint: 'On Windows, use jev-windows.ps1 to load the existing DPAPI credential.', requestsAttempted: 0 } };
  let handle;
  try { handle = await open(options.output, 'wx'); } catch (error) {
    throw preflightError(error.code === 'EEXIST' ? 'output_already_exists' : error.code === 'ENOENT' ? 'output_parent_missing' : 'output_not_writable');
  }
  try { const evidence = await evaluateRequest(input, dependencies); await handle.writeFile(`${JSON.stringify(evidence, null, 2)}\n`); return evidence; } finally { await handle.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) runCli().then((result) => { process.stdout.write(`${JSON.stringify(result)}\n`); if (result.status && result.status !== 'success') process.exitCode = 1; }).catch((error) => {
  process.stderr.write(`${JSON.stringify({ status: error.preflightCode ? 'preflight_failed' : 'local_io_failure', error: { code: error.preflightCode ?? 'local_io_failure' }, requestsAttempted: error.preflightCode ? 0 : null, confidence: null })}\n`);
  process.exitCode = 1;
});
