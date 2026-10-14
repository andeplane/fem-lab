import { randomUUID } from 'node:crypto';
import { serviceServer } from './http.js';

const port = Number(process.env.PORT ?? 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535');
// Subsequent service slices inject the verified identity, database and provider adapters.
// Until they are wired, the process is live but explicitly not ready for inference.
const server = serviceServer({ now: () => new Date(), newId: randomUUID, ready: async () => false });
server.listen(port, '0.0.0.0');
