#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';

import { existsSync } from 'node:fs';
import { compile, generateSchemas } from 'mcp-compiler';
import * as tools from './tools';

// Use pre-generated schemas in production, generate at runtime in dev
const schemasPath = `${__dirname}/schemas.json`;
const schemas = existsSync(schemasPath)
  ? require(schemasPath)
  : generateSchemas(`${__dirname}/tools.ts`);
const compiled = compile({ tools, schemas, z });

const instructions = `
tmuxer is an MCP server for managing background jobs via tmux sessions.
It allows LLMs to run long-running commands, monitor their output, and interact with them.

## Typical workflow:
1. Use createJob to start a command (e.g., a build, server, or test suite)
2. Use getJobStatus to check if it's still running
3. Use getJobOutput to view logs/output
4. Use sendInput if the job needs interactive input (or to send Ctrl+C)
5. Use killJob to terminate when done

## Tips:
- Jobs persist after the command exits (remain-on-exit), so you can always retrieve output
- Use listJobs to see all active jobs
- Custom job IDs make tracking easier (e.g., "build-frontend", "test-api")
`.trim();

const server = new McpServer(
  { name: 'tmuxer', version: '1.0.0' },
  { capabilities: { tools: {} }, instructions },
);

for (const { name, description } of compiled.tools) {
  const zodSchemas = compiled.makeZodSchemas(name);
  const fn = compiled.callTool.bind(null, name);
  server.registerTool(name, { ...zodSchemas, description }, fn);
}

async function runServer() {
  await tools.ensureSession();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('MCP Server tmuxer running on stdio');
}

runServer().catch((error) => {
  console.error(`Fatal error running server:`, error);
  process.exit(1);
});
