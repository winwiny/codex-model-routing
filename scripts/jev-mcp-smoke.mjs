#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

function parseArgs(args) {
  const options = { live: false, listOnly: false, record: null };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--live') options.live = true;
    else if (args[index] === '--list-only') options.listOnly = true;
    else if (args[index] === '--server') options.server = args[++index];
    else if (args[index] === '--output') options.output = args[++index];
    else if (args[index] === '--record') options.record = args[++index];
    else throw new Error('Usage: node scripts/jev-mcp-smoke.mjs --server <path> [--list-only] [--live] [--record <id>] --output <path>');
  }
  if (!options.server) throw new Error('--server is required.');
  if (options.output === undefined) throw new Error('--output is required.');
  return options;
}

const options = parseArgs(process.argv.slice(2));
const nodePath = process.execPath;
const transport = new StdioClientTransport({ command: nodePath, args: [resolve(options.server)] });
const client = new Client({ name: 'local-jev-smoke', version: '0.1.0' });

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const check = options.listOnly ? null : await client.callTool({ name: 'typesafe_check', arguments: {} });
  const result = {
    toolNames: listed.tools.map((tool) => tool.name).sort(),
    check: check?.structuredContent ?? null,
    live: null,
    record: null
  };
  if (options.live) {
    const live = await client.callTool({
      name: 'typesafe_evaluate',
      arguments: {
        state: 'A customer asks whether a fixed arithmetic formula should be handled by code or by a semantic classifier.',
        questions: {
          handler: {
            type: 'choice',
            instructions: 'Choose the appropriate handler for this fictional request.',
            criteria: {
              code: 'Deterministic calculation or exact rule.',
              jev: 'Bounded semantic classification or screening.',
              reasoning: 'Complex architecture or conflicting evidence.',
              review: 'The information is insufficient.'
            }
          }
        }
      }
    });
    result.live = live.structuredContent ?? null;
  }
  if (options.record) {
    const record = await client.callTool({ name: 'typesafe_get_record', arguments: { recordId: options.record } });
    result.record = record.structuredContent ?? null;
  }
  await writeFile(resolve(options.output), `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await client.close();
}
