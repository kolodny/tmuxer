#!/usr/bin/env node

import { program } from 'commander';
import { hideFromTools } from '.';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { server } from './server';

program
  .option('--session [name]', 'tmux session name')
  .option('--keep-alive', 'Keep processes alive even when server exits')
  .action(async (opts) => {
    await hideFromTools.ensureSession(opts.session, opts.keepAlive);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('MCP Server tmuxer running on stdio');
  });

program.parse(process.argv);
