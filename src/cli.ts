#!/usr/bin/env node

import { program } from 'commander';
import { hideFromTools } from '.';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getServer } from './server';

program
  .option('--session [name]', 'tmux session name')
  .option('--keep-alive', 'Keep processes alive even when server exits')
  .action(async (opts) => {
    await hideFromTools.ensureSession(opts.session, opts.keepAlive);
    const transport = new StdioServerTransport();
    const server = await getServer();
    await server.connect(transport);
    console.error('MCP Server tmuxer running on stdio');
  });

program.parse(process.argv);
