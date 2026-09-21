#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { MAX_EVALUATIONS_PER_MINUTE, MODEL, SERVER_VERSION } from './jev-constants.mjs';
import { evaluateJev, getCredentialStatus } from './jev-core.mjs';
import { errorPayload, JevError, stableError } from './jev-errors.mjs';
import { RequestSchema, ResultSchema } from './jev-schemas.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultDataDir = process.platform === 'win32'
  ? join(process.env.LOCALAPPDATA ?? homedir(), 'ModelTaskRouting', 'jev-mcp')
  : join(homedir(), '.local', 'share', 'jev-bridge', 'records');

const ErrorSchema = z.object({
  status: z.literal('error'),
  error: z.object({ code: z.string() }).strict()
}).strict();
const RecordIdSchema = z.string().regex(/^jev-[0-9]{13}-[0-9a-f-]{36}$/);
const ToolOutputSchema = z.union([ResultSchema.extend({ recordId: RecordIdSchema.optional() }), ErrorSchema]);
const BetaRequestSchema = RequestSchema.extend({
  schemaVersion: z.string().min(1).max(120),
  purpose: z.string().min(1).max(2_000)
});

function toolResult(value, isError = false) {
  return {
    ...(isError ? { isError: true } : {}),
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value
  };
}

function toolError(error) {
  return toolResult(errorPayload(error), true);
}

export function createEvaluationGate({ now = Date.now, maxPerMinute = MAX_EVALUATIONS_PER_MINUTE } = {}) {
  const starts = [];
  let inFlight = false;
  return async function run(action) {
    const current = now();
    while (starts.length && starts[0] <= current - 60_000) starts.shift();
    if (inFlight) throw new JevError('evaluation_already_in_progress');
    if (starts.length >= maxPerMinute) throw new JevError('evaluation_rate_limited');
    starts.push(current);
    inFlight = true;
    try { return await action(); }
    finally { inFlight = false; }
  };
}

function auditEnabled(options) {
  return options.enableRecords ?? process.env.JEV_ENABLE_RECORDS === '1';
}

async function writeAuditRecord(result, options) {
  if (!auditEnabled(options)) return result;
  const recordsDir = resolve(options.dataDir ?? process.env.JEV_MCP_DATA_DIR ?? defaultDataDir);
  const recordId = `jev-${Date.now()}-${randomUUID()}`;
  await mkdir(recordsDir, { recursive: true });
  const record = { recordId, createdAt: new Date().toISOString(), result };
  await writeFile(join(recordsDir, `${recordId}.json`), `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return { ...result, recordId };
}

export async function getAuditRecord(recordId, options = {}) {
  if (!auditEnabled(options)) throw new JevError('records_disabled');
  const parsed = RecordIdSchema.safeParse(recordId);
  if (!parsed.success) throw new JevError('record_id_invalid', 'The record ID is invalid.', 2);
  const recordsDir = resolve(options.dataDir ?? process.env.JEV_MCP_DATA_DIR ?? defaultDataDir);
  try { return JSON.parse(await readFile(join(recordsDir, `${parsed.data}.json`), 'utf8')); }
  catch { throw new JevError('record_not_found'); }
}

export function createToolHandlers(options = {}) {
  const gate = options.gate ?? createEvaluationGate(options);
  const evaluate = options.evaluateFunction ?? ((input) => evaluateJev(input, options));
  const runEvaluation = async (input) => {
    try {
      const output = await gate(async () => evaluate(input));
      return toolResult(await writeAuditRecord(output, options));
    } catch (error) { return toolError(stableError(error)); }
  };
  return {
    async check() {
      try {
        const credential = await getCredentialStatus(options);
        return toolResult({
          status: 'ok',
          node: process.version,
          nodeSupported: Number(process.versions.node.split('.')[0]) >= 20,
          platform: process.platform,
          model: MODEL,
          credential,
          recordsEnabled: auditEnabled(options),
          requestsAttempted: 0
        });
      } catch (error) { return toolError(stableError(error)); }
    },
    evaluate: runEvaluation,
    async evaluateBeta(input) {
      const { schemaVersion: _schemaVersion, purpose: _purpose, ...canonical } = input;
      return runEvaluation(canonical);
    },
    async getRecord({ recordId }) {
      try { return toolResult(await getAuditRecord(recordId, options)); }
      catch (error) { return toolError(stableError(error)); }
    }
  };
}

const checkDefinition = {
  title: 'Check local TypeSafe Jev bridge',
  description: 'Offline runtime and credential availability check. It never sends a model request.',
  inputSchema: z.object({}).strict(),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
};

const evaluateDefinition = {
  title: 'Evaluate bounded judgments with TypeSafe Jev',
  description: 'Evaluate one shared string/object/array/null state using official choice, score, and noul questions. Boolean is accepted only as a compatibility input alias and is normalized to noul. Do not send credentials or unnecessary sensitive material. One call produces one external model request (plus SDK retries if configured).',
  inputSchema: RequestSchema,
  outputSchema: ToolOutputSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true }
};

const betaEvaluateDefinition = {
  ...evaluateDefinition,
  title: 'Compatibility alias for typesafe_evaluate',
  description: 'Compatibility input for the former beta jev_evaluate tool. schemaVersion and purpose are accepted locally, removed, and the remaining official request is evaluated exactly once through the shared gate and core.',
  inputSchema: BetaRequestSchema
};

export function createJevMcpServer(options = {}) {
  const handlers = createToolHandlers(options);
  const server = new McpServer({ name: 'typesafe-mcp-server', version: SERVER_VERSION }, {
    instructions: 'Use typesafe_evaluate for bounded semantic classification, relevance screening, scoring, routing, or verification. Code owns exact rules, calculations, and actions. Never send credentials, private keys, passwords, signatures, seed phrases, or unnecessary personal data. typesafe_check is offline. Records and beta aliases are disabled unless the process owner explicitly enables them.'
  });

  server.registerTool('typesafe_check', checkDefinition, handlers.check);
  server.registerTool('typesafe_evaluate', evaluateDefinition, handlers.evaluate);

  const enableAliases = options.enableBetaAliases ?? process.env.JEV_ENABLE_BETA_ALIASES === '1';
  if (enableAliases) {
    // Both names bind to the same handler and gate. Calling an alias is one evaluation,
    // not a chained call through the canonical tool.
    server.registerTool('jev_check', { ...checkDefinition, title: 'Compatibility alias for typesafe_check' }, handlers.check);
    server.registerTool('jev_evaluate', betaEvaluateDefinition, handlers.evaluateBeta);
  }
  if (auditEnabled(options)) {
    server.registerTool('typesafe_get_record', {
      title: 'Read an explicitly enabled redacted Jev audit record',
      description: 'Read one result-only local record. Raw request state and credentials are never recorded.',
      inputSchema: z.object({ recordId: RecordIdSchema }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }, handlers.getRecord);
    if (enableAliases) {
      server.registerTool('jev_get_record', {
        title: 'Compatibility alias for typesafe_get_record',
        description: 'Compatibility result-record lookup; available only while records and beta aliases are both explicitly enabled.',
        inputSchema: z.object({ recordId: RecordIdSchema }).strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      }, handlers.getRecord);
    }
  }
  return server;
}

export function startStdioServer(options = {}) {
  return serveStdio(() => createJevMcpServer(options), {
    onerror: () => process.stderr.write('typesafe-mcp-server transport error\n')
  });
}

export function isMainModule(argv1 = process.argv[1], moduleUrl = import.meta.url) {
  if (!argv1) return false;
  try { return moduleUrl === pathToFileURL(realpathSync(resolve(argv1))).href; }
  catch { return false; }
}

if (isMainModule()) {
  void startStdioServer();
}
