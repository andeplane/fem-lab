// Issue #13: all project/file routes run through the production browser HostContext and Registry.
import { FemError, Registry, type EngineSchema } from '@femlab/registry';
import { describe, expect, it, vi } from 'vitest';
import schema from '../../registry/src/generated/engine.schema.json';
import { fakeHost, fakeTransport, MODEL_FILE } from '../../registry/test/fakes';
import { readHostCaps } from '../src/capabilities';
import { makeHostContext } from '../src/host';
import { Store } from '../src/store';
import { makeProjectHost, retireProjectHost } from '../src/project-host';
import type { DirHandle } from '../src/ai/project';
import { BUILTIN_SKILLS } from '../src/ai/skills';
import { buildSystem, buildTurn, objectIndex } from '../src/ai/context';
import { fakeDir, memoryProjectAccess } from './project-fake';

const skill = (body: string) => `---\nname: write-report\ndescription: Project report instructions.\n---\n\n${body}`;

function setup(files: Record<string, string> = {}) {
  const handle = fakeDir(files);
  const access = memoryProjectAccess(vi.fn(async () => handle));
  const store = new Store();
  const transport = fakeTransport();
  const query = transport.query;
  transport.query = vi.fn(async (q) => q.query === 'query.objects' ? { objects: [] } : query(q));
  const host = makeHostContext(store, transport, { current: null }, readHostCaps({}), undefined, undefined, undefined,
    undefined, undefined, undefined, { projects: {} as never, active: async () => undefined, replay: async () => undefined, captureImport: () => fakeHost().abaqus.capture() },
    undefined, undefined, undefined, undefined, access);
  const registry = new Registry({ schema: schema as unknown as EngineSchema, host });
  return { handle, access, store, transport, host, registry };
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

describe('the production project host', () => {
  it('shares files, project rules and updated skills through Commands and the Assistant context', async () => {
    const { registry, store } = setup({ 'AGENTS.md': 'Check every reaction.', 'skills/write-report/SKILL.md': skill('Use the firm template.') });
    await registry.dispatch({ cmd: 'folder.open', picker: true });
    expect(await registry.query({ query: 'query.folder' })).toMatchObject({ name: 'bridge', agentsMd: 'AGENTS.md', skills: ['write-report'] });
    expect(await registry.dispatch({ cmd: 'skill.invoke', name: 'write-report' })).toMatchObject({ source: 'project', body: 'Use the firm template.' });
    await registry.dispatch({ cmd: 'file.write', path: 'skills/write-report/SKILL.md', text: skill('Use the revised template.') });
    expect(await registry.dispatch({ cmd: 'skill.invoke', name: 'write-report' })).toMatchObject({ body: 'Use the revised template.' });
    await registry.dispatch({ cmd: 'file.write', path: 'AGENTS.md', text: 'Use SI in the model.' });
    const folder = store.state.folder!;
    const system = buildSystem({ registry, skills: store.state.skills, project: { name: folder.name, files: folder.files, agentsMd: folder.agentsMd } });
    expect(system.split('Use SI in the model.')).toHaveLength(2);
    expect(await objectIndex(registry)).toContainEqual(expect.objectContaining({ ref: 'file:AGENTS.md' }));
    const turn = await buildTurn({ text: '@file:AGENTS.md', registry, skills: store.state.skills });
    expect(JSON.stringify(turn.message)).toContain('Use SI in the model.');
    await registry.dispatch({ cmd: 'folder.close' });
    expect(await registry.query({ query: 'query.folder' })).toBeNull();
    expect(store.state.skills).toEqual(BUILTIN_SKILLS);
    await expect(registry.dispatch({ cmd: 'file.read', path: 'AGENTS.md' })).rejects.toMatchObject({ code: 'file.not-found' });
    await expect(registry.dispatch({ cmd: 'folder.refresh' })).rejects.toMatchObject({ code: 'file.not-found' });
  });

  it('saves, reopens and exports via the same scoped text/byte writers; closing restores downloads', async () => {
    const files: Record<string, string> = {};
    const { registry, host, transport } = setup(files);
    host.files.download = vi.fn();
    host.view.screenshot = vi.fn(async () => ({ png: 'data:image/png;base64,AAECAw==' }));
    await registry.dispatch({ cmd: 'folder.open', picker: true });
    expect(await registry.dispatch({ cmd: 'file.save', name: 'models/beam.femlab.json' })).toEqual({ name: 'models/beam.femlab.json', to: 'folder' });
    expect(JSON.parse(files['models/beam.femlab.json']!)).toEqual(MODEL_FILE);
    await registry.dispatch({ cmd: 'file.open', path: 'models/beam.femlab.json' });
    expect(transport.importFile).toHaveBeenCalledWith(MODEL_FILE);
    await registry.dispatch({ cmd: 'file.export', spec: { format: 'script' }, name: 'scripts/beam.ts' });
    expect(files['scripts/beam.ts']).toContain('fem.');
    await registry.dispatch({ cmd: 'file.export', spec: { format: 'png' }, name: 'images/beam.png' });
    expect([...files['images/beam.png']!].map((c) => c.charCodeAt(0))).toEqual([0, 1, 2, 3]);
    expect(host.files.download).not.toHaveBeenCalled();
    await registry.dispatch({ cmd: 'folder.close' });
    expect(await registry.dispatch({ cmd: 'file.save', name: 'download.femlab.json' })).toEqual({ name: 'download.femlab.json', to: 'download' });
    expect(host.files.download).toHaveBeenCalledOnce();
    await expect(host.folder.writeText('x', 'x')).rejects.toMatchObject({ code: 'file.not-found' });
    await expect(host.folder.writeBytes('x', new Uint8Array())).rejects.toMatchObject({ code: 'file.not-found' });
  });

  it('refuses absolute, traversal and control-character paths before any file handle is touched', async () => {
    const { registry, host, handle } = setup();
    await registry.dispatch({ cmd: 'folder.open', handle });
    const file = vi.spyOn(handle, 'getFileHandle');
    const directory = vi.spyOn(handle, 'getDirectoryHandle');
    for (const path of ['../x', '/etc/x', '\\server\\share', 'C:\\x', 'a/../x', 'a\\..\\x', 'x\0y', 'x:y', '.', '']) {
      await expect(registry.dispatch({ cmd: 'file.read', path })).rejects.toMatchObject({ code: 'file.scope' });
      await expect(registry.dispatch({ cmd: 'file.write', path, text: 'x' })).rejects.toMatchObject({ code: 'file.scope' });
      await expect(registry.dispatch({ cmd: 'file.save', name: path })).rejects.toMatchObject({ code: 'file.scope' });
      await expect(host.folder.writeBytes(path, new Uint8Array([1]))).rejects.toMatchObject({ code: 'file.scope' });
    }
    expect(file).not.toHaveBeenCalled();
    expect(directory).not.toHaveBeenCalled();
  });

  it('preserves the active folder on picker cancellation, permission denial and invalid handles', async () => {
    const { registry, host, access, store, handle } = setup({ 'AGENTS.md': 'Keep these rules.' });
    await registry.dispatch({ cmd: 'folder.open', handle });
    const before = store.state.folder;
    const pick = vi.spyOn(access, 'pick').mockRejectedValue(new DOMException('picker cancelled', 'AbortError'));
    await expect(registry.dispatch({ cmd: 'folder.open', picker: true })).rejects.toMatchObject({ code: 'cancelled', cause: 'picker cancelled' });
    expect(pick).toHaveBeenCalledOnce();
    const denied = fakeDir({}, 'denied');
    denied.requestPermission = vi.fn(async () => 'denied' as const);
    const entries = vi.spyOn(denied, 'entries');
    await expect(registry.dispatch({ cmd: 'folder.open', handle: denied })).rejects.toMatchObject({ code: 'file.scope' });
    expect(denied.requestPermission).toHaveBeenCalledWith({ mode: 'readwrite' });
    expect(entries).not.toHaveBeenCalled();
    for (const bad of [null, {}, { kind: 'file' }, { kind: 'directory', name: 'x' }]) {
      await expect(host.folder.open({ handle: bad })).rejects.toHaveProperty('code');
    }
    expect(store.state.folder).toBe(before);
    expect(await registry.query({ query: 'query.folderRecent' })).toEqual({ name: 'bridge' });
    handle.requestPermission = async () => 'denied';
    await expect(registry.dispatch({ cmd: 'folder.open', reopen: true })).rejects.toMatchObject({ code: 'file.scope' });
    expect(store.state.folder).toBe(before);
    handle.requestPermission = async () => { throw new DOMException('permission prompt cancelled', 'AbortError'); };
    await expect(registry.dispatch({ cmd: 'folder.open', reopen: true })).rejects.toMatchObject({ code: 'cancelled' });
    expect(store.state.folder).toBe(before);
  });

  it('retains missing-file and denied-access causes in structured file errors', async () => {
    const { registry, handle, host } = setup();
    await registry.dispatch({ cmd: 'folder.open', handle });
    await expect(registry.dispatch({ cmd: 'file.read', path: 'missing.txt' })).rejects.toMatchObject({ code: 'file.not-found', where: 'missing.txt' });
    vi.spyOn(handle, 'getFileHandle').mockRejectedValue(new DOMException('access revoked', 'NotAllowedError'));
    await expect(host.folder.readText('x.txt')).rejects.toMatchObject({ code: 'file.scope', cause: 'NotAllowedError: access revoked' });
    await expect(host.folder.writeText('x.txt', 'x')).rejects.toMatchObject({ code: 'file.scope' });
    await expect(host.folder.writeBytes('x.txt', new Uint8Array())).rejects.toMatchObject({ code: 'file.scope' });
  });

  it('aborts failed writes, leaves existing content intact and permits a later retry', async () => {
    const files = { 'note.txt': 'old' };
    const { registry, handle } = setup(files);
    await registry.dispatch({ cmd: 'folder.open', handle });
    const abort = vi.fn(async () => { throw new Error('abort also failed'); });
    const close = vi.fn(async () => undefined);
    const file = await handle.getFileHandle('note.txt');
    const get = vi.spyOn(handle, 'getFileHandle').mockResolvedValueOnce({ ...file, createWritable: async () => ({ write: async () => { throw new DOMException('write denied', 'NotAllowedError'); }, close, abort }) });
    await expect(registry.dispatch({ cmd: 'file.write', path: 'note.txt', text: 'new' })).rejects.toMatchObject({ code: 'file.scope' });
    expect(abort).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    expect(files['note.txt']).toBe('old');
    get.mockRestore();
    await registry.dispatch({ cmd: 'file.write', path: 'note.txt', text: 'new' });
    expect(files['note.txt']).toBe('new');
  });

  it('keeps successful text and binary delivery receipts when only the catalog refresh fails', async () => {
    const files: Record<string, string> = { 'note.txt': 'old' };
    const { registry, host, store, handle } = setup(files);
    await registry.dispatch({ cmd: 'folder.open', handle });
    const folder = store.state.folder!;
    const catalog = folder.files;
    const complete = vi.fn();
    vi.spyOn(host.files, 'beginSave').mockReturnValue(complete);
    const entries = vi.spyOn(handle, 'entries').mockImplementation(async function* () { throw new DOMException('catalog access revoked', 'NotAllowedError'); });
    await expect(registry.dispatch({ cmd: 'file.write', path: 'note.txt', text: 'committed' })).resolves.toEqual({ name: 'note.txt', to: 'folder' });
    expect(files['note.txt']).toBe('committed');
    await expect(registry.dispatch({ cmd: 'file.save', name: 'saved.femlab.json' })).resolves.toEqual({ name: 'saved.femlab.json', to: 'folder' });
    expect(JSON.parse(files['saved.femlab.json']!)).toEqual(MODEL_FILE);
    expect(complete).toHaveBeenCalledWith(MODEL_FILE.journal);
    await host.folder.writeBytes('bytes.bin', new Uint8Array([0, 1, 2]));
    expect([...files['bytes.bin']!].map(c => c.charCodeAt(0))).toEqual([0, 1, 2]);
    expect(folder.files).toBe(catalog);
    expect(store.state.console.filter(line => line.text.includes('file saved; project catalog could not refresh'))).toHaveLength(3);
    entries.mockRestore();
    await registry.dispatch({ cmd: 'folder.refresh' });
    expect(folder.files.map(file => file.path)).toEqual(['bytes.bin', 'note.txt', 'saved.femlab.json']);
  });

  it('checks the binary snapshot size before allocating its contents', async () => {
    const { registry, host, handle } = setup({ 'mesh.stl': 'small' });
    await registry.dispatch({ cmd: 'folder.open', handle });
    const file = await handle.getFileHandle('mesh.stl');
    let size = 32 * 1024 * 1024 + 1;
    const arrayBuffer = vi.fn(async () => new Uint8Array([1, 2, 3]).buffer);
    vi.spyOn(handle, 'getFileHandle').mockResolvedValue({ ...file, getFile: async () => ({ size, lastModified: 0, text: async () => '', arrayBuffer }) });
    await expect(host.folder.readBytes('mesh.stl')).rejects.toMatchObject({ code: 'unsupported' });
    expect(arrayBuffer).not.toHaveBeenCalled();
    size--;
    expect(await host.folder.readBytes('mesh.stl')).toEqual(new Uint8Array([1, 2, 3]));
    expect(arrayBuffer).toHaveBeenCalledOnce();
  });

  it('applies the distinct text and model-file byte limits before decoding each folder snapshot', async () => {
    const { registry, transport, handle } = setup({ 'large.femlab.json': 'placeholder' });
    await registry.dispatch({ cmd: 'folder.open', handle });
    const file = await handle.getFileHandle('large.femlab.json');
    let size = 3 * 1024 * 1024;
    const text = vi.fn(async () => JSON.stringify(MODEL_FILE));
    vi.spyOn(handle, 'getFileHandle').mockResolvedValue({ ...file, getFile: async () => ({ size, lastModified: 0, text, arrayBuffer: async () => new ArrayBuffer(0) }) });
    await expect(registry.dispatch({ cmd: 'file.read', path: 'large.femlab.json' })).rejects.toMatchObject({ code: 'unsupported' });
    expect(text).not.toHaveBeenCalled();
    await registry.dispatch({ cmd: 'file.open', path: 'large.femlab.json' });
    expect(transport.importFile).toHaveBeenCalledWith(MODEL_FILE);
    expect(text).toHaveBeenCalledOnce();
    size = 16 * 1024 * 1024 + 1;
    await expect(registry.dispatch({ cmd: 'file.open', path: 'large.femlab.json' })).rejects.toMatchObject({ code: 'unsupported' });
    expect(text).toHaveBeenCalledOnce();
  });

  it('remembers an opaque handle, re-requests permission on reopen, and forgets it on close', async () => {
    const { registry, access, handle } = setup();
    handle.requestPermission = vi.fn(async () => 'granted' as const);
    await expect(registry.query({ query: 'query.folderRecent' })).resolves.toBeNull();
    await expect(registry.dispatch({ cmd: 'folder.open', reopen: true })).rejects.toMatchObject({ code: 'file.not-found' });
    await registry.dispatch({ cmd: 'folder.open', handle });
    const recalled = await access.recall();
    expect(recalled).toBe(handle);
    const recall = vi.spyOn(access, 'recall');
    expect(await registry.query({ query: 'query.folderRecent' })).toEqual({ name: 'bridge' });
    expect(recall).not.toHaveBeenCalled();
    await registry.dispatch({ cmd: 'folder.open', reopen: true });
    expect(handle.requestPermission).toHaveBeenCalledTimes(2);
    await registry.dispatch({ cmd: 'folder.close' });
    expect(await registry.query({ query: 'query.folderRecent' })).toBeNull();
  });

  it.each(['close', 'replace'] as const)('a pending open cannot resurrect a folder after %s', async (action) => {
    const { registry, store, access } = setup();
    const second = makeProjectHost(store, access);
    const delayed = fakeDir({}, 'old');
    const gate = deferred();
    delayed.entries = async function* () { await gate.promise; };
    const pending = registry.dispatch({ cmd: 'folder.open', handle: delayed });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    if (action === 'close') await second.close();
    else await second.open({ handle: fakeDir({}, 'new') });
    gate.release();
    await rejected;
    expect(store.state.folder?.name ?? null).toBe(action === 'close' ? null : 'new');
  });

  it('serializes remembering and forgetting so a slow store cannot restore a closed folder', async () => {
    const { registry, access, store, handle } = setup();
    const gate = deferred();
    const remember = access.remember;
    const started = vi.spyOn(access, 'remember').mockImplementation(async (h: DirHandle) => { await gate.promise; await remember(h); });
    const opening = registry.dispatch({ cmd: 'folder.open', handle });
    const rejected = expect(opening).rejects.toMatchObject({ code: 'cancelled' });
    await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
    const closing = makeProjectHost(store, access).close();
    expect(store.state.folder).toBeNull();
    gate.release();
    await Promise.all([rejected, closing]);
    expect(await access.recall()).toBeNull();
  });

  it('keeps granted file access usable when optional remembering fails', async () => {
    const { registry, access, store, handle } = setup({ 'note.txt': 'readable' });
    vi.spyOn(access, 'remember').mockRejectedValue(new Error('storage blocked'));
    await registry.dispatch({ cmd: 'folder.open', handle });
    expect(await registry.dispatch({ cmd: 'file.read', path: 'note.txt' })).toEqual({ text: 'readable' });
    expect(store.state.console.some((line) => line.text.includes('could not remember'))).toBe(true);
    vi.spyOn(access, 'forget').mockRejectedValue(new DOMException('storage denied', 'SecurityError'));
    await expect(registry.dispatch({ cmd: 'folder.close' })).rejects.toMatchObject({ code: 'file.scope' });
    expect(store.state.folder).toBeNull();
  });
  it('cannot publish or remember an unfinished selection after model activation retires its Store', async () => {
    const { registry, store, access } = setup();
    const delayed = fakeDir({}, 'old');
    const gate = deferred();
    delayed.entries = async function* () { await gate.promise; };
    const pending = registry.dispatch({ cmd: 'folder.open', handle: delayed });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    retireProjectHost(store);
    gate.release();
    await rejected;
    expect(store.state.folder).toBeNull();
    expect(await access.recall()).toBeNull();
  });

  it('requires the captured session admission before publishing or remembering a validated folder', async () => {
    const { store, access, handle } = setup();
    const folder = makeProjectHost(store, access, async () => { throw new FemError('session.expired', 'old activation'); });
    await expect(folder.open({ handle })).rejects.toMatchObject({ code: 'session.expired' });
    expect(store.state.folder).toBeNull();
    expect(await access.recall()).toBeNull();
  });

  it.each(['invalid', 'deleted'] as const)('forgets a remembered %s handle without replacing the open folder or reopening a picker', async kind => {
    const { registry, store, access, handle } = setup({ 'note.txt': 'kept' });
    await registry.dispatch({ cmd: 'folder.open', handle });
    const before = store.state.folder;
    const bad = kind === 'invalid' ? { kind: 'directory', name: 'gone' } as DirHandle : fakeDir({}, 'gone');
    if (kind === 'deleted') bad.entries = async function* () { throw new DOMException('folder removed', 'NotFoundError'); };
    await access.remember(bad);
    await expect(registry.dispatch({ cmd: 'folder.open', reopen: true })).rejects.toMatchObject({ code: kind === 'invalid' ? 'schema' : 'file.not-found' });
    expect(store.state.folder).toBe(before);
    expect(await access.recent()).toBeNull();
    expect(access.pick).not.toHaveBeenCalled();
    expect(await registry.dispatch({ cmd: 'file.read', path: 'note.txt' })).toEqual({ text: 'kept' });
  });

  it('preserves the structured remembered-handle error if optional cleanup storage also fails', async () => {
    const { registry, access, store } = setup();
    vi.spyOn(access, 'recall').mockResolvedValue({ kind: 'directory', name: 'invalid' } as DirHandle);
    vi.spyOn(access, 'forget').mockRejectedValue(new Error('storage blocked'));
    await expect(registry.dispatch({ cmd: 'folder.open', reopen: true })).rejects.toMatchObject({ code: 'schema', where: 'handle' });
    expect(store.state.console.some(line => line.text.includes('could not forget the unavailable project folder'))).toBe(true);
    expect(await registry.query({ query: 'query.folder' })).toBeNull();
  });

});
