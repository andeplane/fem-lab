import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { errorText } from '../src/server';
import { helperPath, nodeProjectFiles, nativeProjectBridge, type ProjectBridge, type ProjectFiles } from '../src/project-files';

const directories: string[] = [];
const capabilities: ProjectFiles[] = [];
afterEach(async () => {
  for (const files of capabilities.splice(0)) files.close();
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});
const scratch = async () => { const dir = await mkdtemp(path.join(tmpdir(), 'femlab-671-')); directories.push(dir); return dir; };
const capture = (root: string) => { const files = nodeProjectFiles(root); capabilities.push(files); return files; };

it('retains the actual root across ambient replacement and serializes concurrent nested exports', async () => {
  const parent = await scratch();
  const root = path.join(parent, 'project');
  await mkdir(root);
  await writeFile(path.join(root, 'input.inp'), 'captured bytes');
  const files = capture(root);
  expect(await files.size('input.inp')).toBe(14);
  await rename(root, path.join(parent, 'original'));
  await mkdir(root);
  await writeFile(path.join(root, 'input.inp'), 'replacement outside authority');
  expect(Buffer.from(await files.read('input.inp')).toString()).toBe('captured bytes');
  await Promise.all(Array.from({ length: 4 }, (_, i) => files.write(`nested/deep/${i}`, Buffer.from(`payload ${i}`))));
  expect(await readFile(path.join(parent, 'original/nested/deep/3'), 'utf8')).toBe('payload 3');
  await expect(readFile(path.join(root, 'nested/deep/3'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('refuses intermediate and final links without reading or changing an outside sentinel', async () => {
  const root = await scratch();
  const outside = await scratch();
  await writeFile(path.join(outside, 'sentinel'), 'OUTSIDE');
  await symlink(path.relative(root, outside), path.join(root, 'linked'), 'dir');
  await symlink(path.join(outside, 'sentinel'), path.join(root, 'leaf'), 'file');
  const files = capture(root);
  for (const input of ['linked/sentinel', 'leaf']) {
    await expect(files.read(input)).rejects.toMatchObject({ code: 'file.scope', where: 'path' });
    await expect(files.write(input, Buffer.from('bad'))).rejects.toMatchObject({ code: 'file.scope', where: 'path' });
  }
  await expect(files.size('missing')).rejects.toMatchObject({ code: 'file.not-found', where: 'path' });
  expect(await readFile(path.join(outside, 'sentinel'), 'utf8')).toBe('OUTSIDE');
});

it('requires authority and rejects cancellation before admitting a disk operation', async () => {
  let factories = 0;
  const bridge: ProjectBridge = { ready: async () => {}, request: async () => { throw new Error('must not admit I/O'); }, close: () => {} };
  const factory = () => { factories++; return bridge; };
  const unscoped = nodeProjectFiles(undefined, factory);
  await expect(unscoped.read('input')).rejects.toMatchObject({ code: 'file.scope' });
  unscoped.close();
  const files = nodeProjectFiles('/unused', factory);
  await files.ready();
  const abort = AbortSignal.abort(new Error('cancelled before admission'));
  await expect(files.read('input', abort)).rejects.toThrow('cancelled before admission');
  await expect(files.write('output', Buffer.from('bad'), abort)).rejects.toThrow('cancelled before admission');
  await expect(files.read('../escape')).rejects.toMatchObject({ code: 'file.scope' });
  await expect(files.write('huge', new Uint8Array(64 * 1024 * 1024 + 1))).rejects.toMatchObject({ code: 'file.scope' });
  files.close();
  await expect(files.size('input')).rejects.toMatchObject({ code: 'file.scope' });
  expect(factories).toBe(1);
});

it('discards cancelled asynchronous reads and preserves typed helper failure details', async () => {
  const abort = new AbortController();
  const replies: unknown[] = [{ size: 3 }, { data: Buffer.from('abc').toString('base64') }, { error: { code: 'file.scope', cause: 'refused link', where: 'path', suggestion: 'regular file' } }];
  let calls = 0;
  let closes = 0;
  const files = nodeProjectFiles('/injected', () => ({
    ready: async () => {},
    request: async () => { calls++; if (calls === 2) abort.abort(new Error('cancelled snapshot')); return replies.shift(); },
    close: () => { closes++; },
  }));
  expect(await files.size('input')).toBe(3);
  await expect(files.read('input', abort.signal)).rejects.toThrow('cancelled snapshot');
  await expect(files.read('linked')).rejects.toMatchObject({ code: 'file.scope', cause: 'refused link', suggestion: 'regular file' });
  files.close();
  expect(closes).toBe(1);
});

it('refuses unsupported or incomplete packaged helper availability explicitly', async () => {
  const here = await scratch();
  await mkdir(path.join(here, 'project-io/win32-x64'), {recursive:true});
  await writeFile(path.join(here, 'project-io/win32-x64/femlab-project-io.exe'), 'staged target');
  expect(helperPath(here, 'win32', 'x64')).toBe(path.join(here, 'project-io/win32-x64/femlab-project-io.exe'));
  expect(() => helperPath('/missing', 'freebsd', 'arm64')).toThrow('unsupported');
  expect(() => helperPath('/definitely-missing', 'linux', 'x64')).toThrow('helper is missing');
});

const controlled = (script: string): ProjectBridge => nativeProjectBridge('/unused', () => spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'inherit'] }));
it('rejects closed capabilities and malformed helper protocols without pathname fallback', async () => {
  const denied = controlled('console.log(JSON.stringify({error:{code:"file.scope",cause:"root refused",where:"path",suggestion:"choose root"}}));');
  await expect(denied.request({op:'stat',path:'x'})).rejects.toMatchObject({code:'file.scope',cause:'root refused'});
  denied.close();
  const invalid = controlled('console.log("invalid JSON");');
  await expect(invalid.request({op:'stat',path:'x'})).rejects.toThrow();
  invalid.close();
  const closed = controlled('console.log(JSON.stringify({ready:true}));setInterval(()=>{},1000);');
  closed.close();
  await expect(closed.request({op:'stat',path:'x'})).rejects.toThrow('closed');
  const absent = nativeProjectBridge('/unused', () => spawn('/definitely-missing-femlab-project-io', [], { stdio: ['pipe', 'pipe', 'inherit'] }));
  await expect(absent.request({op:'stat',path:'x'})).rejects.toThrow('could not start');
  absent.close();
});

it('handles an ended, exited or oversized helper response as failed I/O', async () => {
  const ended = controlled('console.log(JSON.stringify({ready:true}));process.stdout.end();process.stdin.resume();');
  await expect(ended.request({op:'read',path:'x'})).rejects.toThrow('response channel');
  ended.close();
  const exited = controlled('console.log(JSON.stringify({ready:true}));setTimeout(()=>process.exit(1),20);process.stdin.resume();');
  await expect(exited.request({op:'read',path:'x'})).rejects.toThrow('closed');
  exited.close();
  const oversized = controlled('console.log(JSON.stringify({ready:true}));process.stdin.once("data",()=>{process.stdout.write("x".repeat(24*1024*1024+1)+"\\n");});');
  await expect(oversized.request({op:'read',path:'x'})).rejects.toThrow('byte limit');
  oversized.close();
});

it('refuses another operation after a capability closes and propagates a broken request pipe', async () => {
  const root = await scratch();
  await writeFile(path.join(root,'file'),'abc');
  const bridge = nativeProjectBridge(root);
  expect(await bridge.request({op:'stat',path:'file'})).toEqual({size:3});
  bridge.close();
  await expect(bridge.request({op:'stat',path:'file'})).rejects.toThrow('closed');
  const pipe = controlled("require('node:fs').closeSync(0);console.log(JSON.stringify({ready:true}));setTimeout(()=>process.exit(1),200);");
  await new Promise(resolve => setTimeout(resolve,100));
  const failed = await pipe.request({op:'stat',path:'file'}).catch(error => JSON.parse(errorText(error)) as unknown);
  expect(failed).toEqual({ code:'file.scope', cause:expect.stringContaining('request channel failed'), where:'path', suggestion:expect.any(String) });
  pipe.close();
});

it('can close before initialization and never admits a read cancelled during startup', async () => {
  const closed = nodeProjectFiles('/unused', () => { throw new Error('must not capture after close'); });
  closed.close();
  await expect(closed.ready()).rejects.toThrow('closed');
  let initialized!: () => void;
  const gate = new Promise<void>(resolve => { initialized = resolve; });
  let reads = 0;
  const files = nodeProjectFiles('/unused', () => ({ ready: () => gate, request: async () => { reads++; return {data:'YQ=='}; }, close: () => {} }));
  const abort = new AbortController();
  const cancelled = files.read('input', abort.signal);
  abort.abort(new Error('cancelled before startup completed'));
  initialized();
  await expect(cancelled).rejects.toThrow('cancelled before startup completed');
  expect(reads).toBe(0);
  files.close();
  let opened!: () => void;
  const slow = nodeProjectFiles('/unused', () => ({ ready: () => new Promise<void>(resolve => { opened = resolve; }), request: async () => { throw new Error('must not read after close'); }, close: () => {} }));
  const pending = slow.read('input');
  await Promise.resolve();
  slow.close();
  opened();
  await expect(pending).rejects.toThrow('closed');
});
