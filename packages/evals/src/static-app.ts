import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const TYPES: Record<string, string> = {
  '.css': 'text/css', '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.webp': 'image/webp', '.woff2': 'font/woff2',
};

export interface FrozenAppServer {
  url: string;
  root: string;
  close(): Promise<void>;
}

/** Serve exactly one hashed app directory with the isolation headers its threaded wasm requires. */
export async function serveFrozenApp(directory: string): Promise<FrozenAppServer> {
  const root = await realpath(directory);
  if (!(await stat(root)).isDirectory()) throw new Error(`frozen app path is not a directory: ${directory}`);
  const server = createServer((request, response) => {
    const respond = async () => {
      const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
      const relative = pathname === '/' || pathname === '/fem-lab/' ? 'index.html' : pathname.replace(/^\/fem-lab\//, '');
      const target = path.resolve(root, relative);
      if (target !== root && !target.startsWith(root + path.sep)) {
        response.writeHead(404).end();
        return;
      }
      try {
        const bytes = await readFile(target);
        response.writeHead(200, {
          'Content-Type': TYPES[path.extname(target)] ?? 'application/octet-stream',
          'Cross-Origin-Opener-Policy': 'same-origin',
          'Cross-Origin-Embedder-Policy': 'credentialless',
        }).end(bytes);
      } catch {
        response.writeHead(404).end();
      }
    };
    void respond().catch(() => response.writeHead(400).end());
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('frozen app server did not bind a TCP port');
  return {
    url: `http://127.0.0.1:${address.port}/fem-lab/`,
    root,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

/** Require the executable and wasm used by the MCP lane to come from the hashed package tree. */
export async function assertInFrozenPackage(packageDirectory: string, targets: string[]): Promise<string> {
  const root = await realpath(packageDirectory);
  if (!(await stat(root)).isDirectory()) throw new Error(`frozen MCP package path is not a directory: ${packageDirectory}`);
  for (const target of targets) {
    const resolved = await realpath(target);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error(`${target} is outside frozen MCP package ${root}`);
  }
  return root;
}
