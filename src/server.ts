#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { compile, generateSchemas } from 'mcp-compiler';
import * as z from 'zod/v4';

import * as tools from './';
import pkg from '../package.json';

// Use pre-generated schemas in production, generate at runtime in dev
const schemasPath = `${__dirname}/schemas.json`;
const schemas = existsSync(schemasPath)
  ? require(schemasPath)
  : generateSchemas(`${__dirname}/index.ts`);
const compiled = compile({ tools, schemas, z });

export const getServer = async () => {
  const jobs = await tools.listJobs({});
  const instructions = `
tmuxer is an MCP server for managing background jobs via tmux sessions.
It allows LLMs to run long-running commands, monitor their output, and interact with them.

## Typical workflow:
1. Use createJob to start a command (e.g., a build, server, or test suite)
2. Use listJobs to see active jobs and their status
3. Use getJobOutput to view logs/output
4. Use sendInput if the job needs interactive input (or to send Ctrl+C)
5. Use cleanupJobs when dead job windows accumulate (they're kept for auditing)

## Tips:
- Jobs persist after the command exits (remain-on-exit) for auditing, so you can always retrieve output
- Every tool response includes a "jobs" field with the current state of all jobs, so you always have an up-to-date view
- Custom prefixes make tracking easier (e.g., "build", "test")

Current jobs list:

\`\`\`json
${JSON.stringify(jobs, null, 2)}
\`\`\`
`.trim();

  const server = new McpServer(
    { name: pkg.name, version: pkg.version },
    { capabilities: { tools: {} }, instructions },
  );

  for (const { name, description } of compiled.tools) {
    const zodSchemas = compiled.makeZodSchemas(name);
    const fn = compiled.callTool.bind(null, name);
    server.registerTool(name, { ...zodSchemas, description }, fn);
  }
  return server;
};
