// Argument parsing and start-up, kept out of the entry point so both are testable with fakes.
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import path from 'node:path';
import type { EngineProvider } from './engine';
import { createServer } from './server';

/** `--project <dir>` as an absolute path, or nothing. The only flag this server takes. */
export function projectFrom(argv: string[]): string | undefined {
  const at = argv.indexOf('--project');
  if (at < 0) return undefined;
  const dir = argv[at + 1];
  if (dir === undefined || dir.startsWith('--')) throw new Error('--project needs a directory');
  return path.resolve(dir);
}

/**
 * Load the engine, build the server and hand it the transport. `load` and `transport` are
 * arguments so a test can start the whole server without a wasm build and without stdio.
 */
export async function start(
  argv: string[],
  here: string,
  load: (here: string) => EngineProvider,
  transport: () => Transport,
): Promise<void> {
  const { server } = createServer({ engine: load(here), project: projectFrom(argv) });
  await server.connect(transport());
}
