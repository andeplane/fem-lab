// Host-only directory capability. The native helper owns the root handle for this lifetime;
// no checked pathname is returned to a caller for a later ambient fs.open/writeFile.
import { FemError, assertInside, MAX_ABAQUS_BYTES } from '@femlab/registry';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { z } from 'zod';

export interface ProjectFiles {
  /** Completes only after the configured root handle is captured; no file I/O warms it. */
  ready(): Promise<void>;
  size(path: string, signal?: AbortSignal): Promise<number>;
  read(path: string, signal?: AbortSignal): Promise<Uint8Array>;
  write(path: string, bytes: Uint8Array, signal?: AbortSignal): Promise<void>;
  close(): void;
}
type Request = { op: 'stat' | 'read'; path: string } | { op: 'write'; path: string; data: string };
export interface ProjectBridge { ready(): Promise<void>; request(value: Request): Promise<unknown>; close(): void }
export type ProjectBridgeFactory = (root: string) => ProjectBridge;
const failure = z.object({ error: z.object({ code: z.enum(['file.scope', 'file.not-found']), cause: z.string(), where: z.string(), suggestion: z.string() }) });
const unavailable = (cause: string) => new FemError('file.scope', cause, 'path', 'install the MCP package for a supported platform, or supply inline input text');

export function helperPath(here: string, platform = process.platform, arch = process.arch): string {
  const suffix = platform === 'win32' ? '.exe' : '';
  if (!['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64'].includes(`${platform}-${arch}`)) {
    throw unavailable(`project filesystem access is unsupported on ${platform}-${arch}`);
  }
  const relative = path.join(`${platform}-${arch}`, `femlab-project-io${suffix}`);
  const candidates = [path.join(here, 'project-io', relative), path.join(here, '../../../tools/project-io', relative)];
  const found = candidates.find(existsSync);
  if (found === undefined) throw unavailable('the project filesystem helper is missing; build it with node tools/build-project-io.mjs');
  return found;
}

/** One sequential bounded IPC channel; concurrent registry callers share the captured root. */
export type SpawnProjectHelper = (root: string) => ChildProcessByStdio<Writable, Readable, null>;
export const spawnProjectHelper: SpawnProjectHelper = root => spawn(helperPath(path.dirname(fileURLToPath(import.meta.url))), [root], { stdio: ['pipe', 'pipe', 'inherit'] });
export function nativeProjectBridge(root: string, launch: SpawnProjectHelper = spawnProjectHelper): ProjectBridge {
  const child = launch(root);
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  let closed = false;
  let pending = 1;
  const lifetime = (active: boolean) => {
    // Node's pipe stdio are net.Socket handles. Keep operations alive; idle capabilities
    // must not keep an otherwise closed stdio server or library process running.
    const handles = [child, child.stdin, child.stdout] as unknown as Array<{ ref(): void; unref(): void }>;
    for (const handle of handles) { if (active) handle.ref(); else handle.unref(); }
  };
  const settled = () => { pending--; if (pending === 0) lifetime(false); };
  let rejectProcess: (error: unknown) => void;
  const failed = new Promise<never>((_, reject) => { rejectProcess = reject; });
  // Always observe startup errors, even when the caller closes before its first operation.
  void failed.catch(() => {});
  child.stdin.on('error', error => rejectProcess(unavailable(`project filesystem request channel failed: ${error.message}`)));
  child.on('error', error => rejectProcess(unavailable(`project filesystem helper could not start: ${error.message}`)));
  // Process exit can precede delivery of its final stdout record. Let readline drain
  // that record; EOF below still rejects a helper that closed without a response.
  const read = async () => {
    const line = await Promise.race([iterator.next(), failed]);
    if (line.done) throw unavailable('the project filesystem helper closed its response channel');
    if (line.value.length > 24 * 1024 * 1024) throw unavailable('the project filesystem helper response exceeds its byte limit');
    return JSON.parse(line.value) as unknown;
  };
  const ready = read().then(value => {
    const error = failure.safeParse(value);
    if (error.success) throw new FemError(error.data.error.code, error.data.error.cause, error.data.error.where, error.data.error.suggestion);
    z.object({ ready: z.literal(true) }).parse(value);
  });
  void ready.finally(settled).catch(() => {});
  let tail: Promise<unknown> = ready;
  return {
    ready: () => ready,
    request: value => {
      pending++;
      lifetime(true);
      const next = tail.then(async () => {
        if (closed) throw unavailable('the project filesystem capability has closed');
        await new Promise<void>((resolve, reject) => child.stdin.write(JSON.stringify(value) + '\n', error => error ? reject(unavailable(`project filesystem request channel failed: ${error.message}`)) : resolve()));
        return read();
      });
      tail = next.catch(() => {});
      return next.finally(settled);
    },
    close: () => { closed = true; child.stdin.end(); lines.close(); child.kill(); },
  };
}

/** Missing authority and cancellation are rejected before admitting any helper operation. */
export function nodeProjectFiles(root: string | undefined, factory: ProjectBridgeFactory = nativeProjectBridge): ProjectFiles {
  let bridge: ProjectBridge | undefined;
  let closed = false;
  const initialized = Promise.resolve().then(async () => {
    if (root === undefined) return;
    if (closed) throw unavailable('the project filesystem capability has closed');
    bridge = factory(root);
    await bridge.ready();
  });
  // Construction starts capture; startup and every registry request await this barrier.
  // A caller that only describes tools must not create an unhandled startup rejection.
  void initialized.catch(() => {});
  const request = async (value: Request, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (closed) throw unavailable('the project filesystem capability has closed');
    if (root === undefined) throw unavailable('this server has no project folder; start it with --project <dir>');
    value.path = assertInside(value.path).join('/');
    await initialized;
    signal?.throwIfAborted();
    if (closed) throw unavailable('the project filesystem capability has closed');
    const result = await bridge!.request(value);
    signal?.throwIfAborted();
    const error = failure.safeParse(result);
    if (error.success) throw new FemError(error.data.error.code, error.data.error.cause, error.data.error.where, error.data.error.suggestion);
    return result;
  };
  return {
    ready: () => initialized,
    size: async (input, signal) => z.object({ size: z.number().int().nonnegative().safe() }).parse(await request({ op: 'stat', path: input }, signal)).size,
    read: async (input, signal) => {
      const { data } = z.object({ data: z.string().max(4 * Math.ceil((MAX_ABAQUS_BYTES + 1) / 3)) }).parse(await request({ op: 'read', path: input }, signal));
      return Buffer.from(data, 'base64');
    },
    write: async (input, bytes, signal) => {
      if (bytes.byteLength > 64 * 1024 * 1024) throw new FemError('file.scope', 'export exceeds the 64 MiB host transfer limit', 'path', 'export a smaller file');
      z.object({ bytes: z.literal(bytes.byteLength) }).parse(await request({ op: 'write', path: input, data: Buffer.from(bytes).toString('base64') }, signal));
    },
    close: () => { closed = true; bridge?.close(); },
  };
}
