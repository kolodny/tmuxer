#!/usr/bin/env npx tsx
import { writeFileSync } from 'node:fs';
import { generateSchemas } from 'mcp-compiler';

const pathToTools = `${__dirname}/../src/tools.ts`;
const schemas = generateSchemas(pathToTools);

writeFileSync(`${__dirname}/../dist/schemas.json`, JSON.stringify(schemas, null, 2));
console.log('Generated dist/schemas.json');
