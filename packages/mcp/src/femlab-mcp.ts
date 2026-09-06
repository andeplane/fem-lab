// The `femlab-mcp` binary: stdio in, MCP out. Everything it does lives in `cli.ts` and
// `server.ts`, which is why this file is six lines and excluded from the coverage threshold —
// there is nothing here to test that starting the process does not already exercise.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { start } from './cli';
import { loadEngine } from './engine';

const here = path.dirname(fileURLToPath(import.meta.url));
await start(process.argv.slice(2), here, loadEngine, () => new StdioServerTransport()).catch((e: Error) => {
  process.stderr.write(`${e.message}\n`);
  process.exit(2);
});
