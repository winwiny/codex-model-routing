#!/usr/bin/env node
import { execFile as execFileCallback } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

const execFile = promisify(execFileCallback);
const MODEL = 'typesafe-ai/jev';
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_QUESTIONS = 16;
const MAX_EVALUATIONS_PER_MINUTE = 20;
const LAUNCH_TIMEOUT_MS = 35_000;
const SERVER_VERSION = '0.1.0';
const scriptDir = dirname(fileURLToPath(import.meta.url));
const launcherPath = join(scriptDir, 'jev-windows.ps1');
const defaultDataDir = join(process.env.LOCALAPPDATA ?? '', 'ModelTaskRouting', 'mcp');

class McpInputError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const questionSchema = z.object({
  type: z.enum(['choice', 'boolean', 'score']),
  instructions: z.string().min(1).max(2_000),
  criteria: z.union([
    z.record(z.string().min(1).max(100), z.string().min(1).max(2_000)),
    z.array(z.string().min(1).max(2_000)).min(2).max(20)
  ]).optional()
}).strict().superRefine((question, context) => {
  if (question.type === 'choice' && (!question.criteria || Array.isArray(question.criteria))) {
    context.addIssue({ code: 'custom', message: 'Choice questions require keyed criteria.' });
  }
  if (question.type === 'score' && (!Array.isArray(question.criteria) || question.criteria.length < 2)) {
    context.addIssue({ code: 'custom', message: 'Score questions require at least two ordered criteria.' });
  }
});

const evaluationInputSchema = z.object({
  schemaVersion: z.string().min(1).max(100),
  purpose: z.string().min(1).max(500),
  state: z.unknown(),
  questions: z.record(z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/), questionSchema)
    .refine((value) => Object.keys(value).length >= 1 && Object.keys(value).length <= MAX_QUESTIONS, {
      message: `Provide between 1 and ${MAX_QUESTIONS} questions.`
    })
}).strict();

const recordInputSchema = z.object({
  recordId: z.string().regex(/^jev-[0-9]{13}-[0-9a-f-]{36}$/)
}).strict();

function hasSensitiveMaterial(value) {
  if (typeof value === 'string') {
    return /\bvck_[A-Za-z0-9_-]{16,}\b/.test(value)
      || /\bsk-[A-Za-z0-9_-]{20,}\b/.test(value)
      || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(value);
  }
  if (Array.isArray(value)) return value.some(hasSensitiveMaterial);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => {
    if (/(?:^|_)(?:api_?key|private_?key|seed_?phrase|mnemonic|authorization|signature|secret)(?:$|_)/i.test(key)) {
      return child !== null && child !== undefined && child !== '';
    }
    return hasSensitiveMaterial(child);
  });
}

function jsonText(value) {
  return JSON.stringify(value, null, 2);
}

function safeToolResult(value, isError = false) {
  return {
    ...(isError ? { isError: true } : {}),
    content: [{ type: 'text', text: jsonText(value) }],
    structuredContent: value
  };
}

function errorResult(code) {
  return safeToolResult({ status: 'error', error: { code } }, true);
}

function parseJsonOutput(stdout) {
  const lines = String(stdout ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(lines[index]); } catch { /* continue */ }
  }
  throw new McpInputError('jev_launcher_output_invalid');
}

function resolveRuntime(options = {}) {
  const dataDir = resolve(options.dataDir ?? process.env.JEV_MCP_DATA_DIR ?? defaultDataDir);
  if (!dataDir || dataDir === resolve(dataDir, '..')) throw new McpInputError('jev_data_directory_invalid');
  const powershell = options.powershellPath
    ?? join(process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return {
    dataDir,
    tempDir: join(dataDir, 'tmp'),
    recordsDir: join(dataDir, 'records'),
    launcher: options.launcherPath ?? launcherPath,
    powershell,
    execFileImpl: options.execFileImpl ?? execFile
  };
}

async function ensureDirectories(runtime) {
  await mkdir(runtime.tempDir, { recursive: true });
  await mkdir(runtime.recordsDir, { recursive: true });
}

async function runLauncher(runtime, args) {
  try {
    return await runtime.execFileImpl(runtime.powershell, ['-NoProfile', '-File', runtime.launcher, ...args], {
      windowsHide: true,
      timeout: LAUNCH_TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024,
      encoding: 'utf8'
    });
  } catch (error) {
    if (error?.stdout) return { stdout: error.stdout, stderr: error.stderr ?? '' };
    throw new McpInputError(error?.code === 'ETIMEDOUT' ? 'jev_launcher_timeout' : 'jev_launcher_failed');
  }
}

async function withTemporaryInput(runtime, request, action) {
  await ensureDirectories(runtime);
  const payload = `${JSON.stringify(request)}\n`;
  if (Buffer.byteLength(payload, 'utf8') > MAX_INPUT_BYTES) throw new McpInputError('input_too_large');
  if (hasSensitiveMaterial(request)) throw new McpInputError('sensitive_material_rejected');
  const inputPath = join(runtime.tempDir, `request-${randomUUID()}.json`);
  await writeFile(inputPath, payload, { encoding: 'utf8', flag: 'wx' });
  try {
    return await action(inputPath);
  } finally {
    await unlink(inputPath).catch(() => {});
  }
}

export async function checkJev(options = {}) {
  const runtime = resolveRuntime(options);
  const request = {
    schemaVersion: 'jev-mcp-check-v1',
    purpose: 'Validate the local Jev MCP launcher without sending a model request.',
    model: MODEL,
    state: 'Local offline check.',
    questions: {
      available: { type: 'boolean', instructions: 'Is this an offline schema check?' }
    }
  };
  return withTemporaryInput(runtime, request, async (inputPath) => {
    const result = await runLauncher(runtime, ['-InputPath', inputPath, '-Check']);
    const parsed = parseJsonOutput(result.stdout);
    return { ...parsed, transport: 'stdio', model: MODEL };
  });
}

export async function evaluateJev(input, options = {}) {
  const parsedInput = evaluationInputSchema.parse(input);
  const runtime = resolveRuntime(options);
  const request = { ...parsedInput, model: MODEL };
  return withTemporaryInput(runtime, request, async (inputPath) => {
    const recordId = `jev-${Date.now()}-${randomUUID()}`;
    const outputPath = join(runtime.recordsDir, `${recordId}.json`);
    await runLauncher(runtime, ['-InputPath', inputPath, '-OutputPath', outputPath]);
    let evidence;
    try { evidence = JSON.parse(await readFile(outputPath, 'utf8')); }
    catch { throw new McpInputError('jev_record_unreadable'); }
    return { recordId, evidence };
  });
}

export async function getJevRecord(recordId, options = {}) {
  const parsed = recordInputSchema.parse({ recordId });
  const runtime = resolveRuntime(options);
  const recordPath = join(runtime.recordsDir, `${parsed.recordId}.json`);
  try {
    return { recordId: parsed.recordId, evidence: JSON.parse(await readFile(recordPath, 'utf8')) };
  } catch {
    throw new McpInputError('record_not_found_or_invalid');
  }
}

export function createJevMcpServer(options = {}) {
  const evaluationStarts = [];
  let evaluationInFlight = false;
  const server = new McpServer(
    { name: 'local-jev', version: SERVER_VERSION },
    {
      instructions: 'Use Jev only for bounded semantic classification, screening, scoring, routing, and simple judgments. Keep calculations, trading, risk, account state, and execution in deterministic code. Never send credentials, private keys, signatures, seed phrases, or unnecessary sensitive data. Jev results are typed judgments, not facts or authorization. Report raw confidence for Choice/Score and p(true) for Boolean; use review or deterministic fallback when evidence is weak or the service fails.'
    }
  );

  server.registerTool('jev_check', {
    title: 'Check local Jev access',
    description: 'Offline check of the local Windows launcher, request schema, Node runtime, and credential availability. Sends no model request.',
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  }, async () => {
    try { return safeToolResult(await checkJev(options)); }
    catch (error) { return errorResult(error?.code ?? 'jev_check_failed'); }
  });

  server.registerTool('jev_evaluate', {
    title: 'Evaluate bounded judgments with Jev',
    description: 'Send one bounded, authorized semantic evaluation to typesafe-ai/jev. Not for calculations, trading decisions, order execution, credentials, or private wallet data. Returns typed answers, probabilities, raw confidence where available, and a private audit record ID.',
    inputSchema: evaluationInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true }
  }, async (input) => {
    const cutoff = Date.now() - 60_000;
    while (evaluationStarts.length && evaluationStarts[0] < cutoff) evaluationStarts.shift();
    if (evaluationInFlight) return errorResult('evaluation_already_in_progress');
    if (evaluationStarts.length >= MAX_EVALUATIONS_PER_MINUTE) return errorResult('evaluation_rate_limited');
    evaluationStarts.push(Date.now());
    evaluationInFlight = true;
    try {
      const result = await evaluateJev(input, options);
      return safeToolResult(result, result.evidence?.status !== 'success');
    } catch (error) {
      return errorResult(error instanceof z.ZodError ? 'input_schema_invalid' : error?.code ?? 'jev_evaluate_failed');
    } finally {
      evaluationInFlight = false;
    }
  });

  server.registerTool('jev_get_record', {
    title: 'Read a Jev audit record',
    description: 'Read one sanitized Jev evidence record by its MCP-issued record ID. Arbitrary file paths are not accepted.',
    inputSchema: recordInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  }, async ({ recordId }) => {
    try { return safeToolResult(await getJevRecord(recordId, options)); }
    catch (error) { return errorResult(error instanceof z.ZodError ? 'record_id_invalid' : error?.code ?? 'record_read_failed'); }
  });

  return server;
}

export function startStdioServer(options = {}) {
  return serveStdio(() => createJevMcpServer(options), {
    onerror: () => process.stderr.write('local-jev MCP transport error\n')
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.platform !== 'win32') {
    process.stderr.write('local-jev MCP currently requires Windows DPAPI and PowerShell.\n');
    process.exitCode = 1;
  } else {
    startStdioServer();
  }
}
