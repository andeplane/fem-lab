import { parentPort } from 'node:worker_threads';
import { validateScript } from '@femlab/registry/script-validation';
import declarations from '../../registry/src/generated/script-declarations-mcp.json' with { type: 'json' };
parentPort!.on('message', (code: string) => parentPort!.postMessage(validateScript(code, declarations)));
