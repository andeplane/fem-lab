import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEngine } from '../../mcp/src/engine';
import { listen, randomSessionToken } from './serve';
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== '--port' || !/^\d+$/.test(args[1]!))) {
  console.error('usage: femlab-serve [--port 7777]'); process.exit(2);
}
const port = Number(args[1] ?? 7777);
if (!Number.isSafeInteger(port) || port < 0 || port > 65535) { console.error('port must be 0..65535'); process.exit(2); }
const here = path.dirname(fileURLToPath(import.meta.url));
const { server, port: bound } = await listen({ engine: () => loadEngine(here), now: () => Date.now(), token: randomSessionToken }, port);
console.log(JSON.stringify({ url: `http://127.0.0.1:${bound}`, protocol: 'femlab-rpc/1' }));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.close(() => process.exit(0)));
