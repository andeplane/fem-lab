// Issue #13: all project/file routes run through the production browser HostContext and Registry.
import { Registry, type EngineSchema } from '@femlab/registry';
import { describe, expect, it, vi } from 'vitest';
import schema from '../../registry/src/generated/engine.schema.json';
import { fakeTransport, MODEL_FILE } from '../../registry/test/fakes';
import { readHostCaps } from '../src/capabilities';
import { makeHostContext } from '../src/host';
import { Store } from '../src/store';
import type { WorkerTransport } from '../src/worker-transport';
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
  const host = makeHostContext(store, transport as WorkerTransport, { current: null }, readHostCaps({}), undefined, undefined, access);
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
    await registry.dispatch({ cmd: 'project.open', picker: true });
    expect(await registry.query({ query: 'query.project' })).toMatchObject({ name: 'bridge', agentsMd: 'AGENTS.md', skills: ['write-report'] });
    expect(await registry.dispatch({ cmd: 'skill.invoke', name: 'write-report' })).toMatchObject({ source: 'project', body: 'Use the firm template.' });
    await registry.dispatch({ cmd: 'file.write', path: 'skills/write-report/SKILL.md', text: skill('Use the revised template.') });
    expect(await registry.dispatch({ cmd: 'skill.invoke', name: 'write-report' })).toMatchObject({ body: 'Use the revised template.' });
    await registry.dispatch({ cmd: 'file.write', path: 'AGENTS.md', text: 'Use SI in the model.' });
    const folder = store.state.project!;
    const system = buildSystem({ registry, skills: store.state.skills, project: { name: folder.name, files: folder.files, agentsMd: folder.agentsMd } });
    expect(system.split('Use SI in the model.')).toHaveLength(2);
    expect(await objectIndex(registry)).toContainEqual(expect.objectContaining({ ref: 'file:AGENTS.md' }));
    const turn = await buildTurn({ text: '@file:AGENTS.md', registry, skills: store.state.skills });
    expect(JSON.stringify(turn.message)).toContain('Use SI in the model.');
    await registry.dispatch({ cmd: 'project.close' });
    expect(await registry.query({ query: 'query.project' })).toBeNull();
    expect(store.state.skills).toEqual(BUILTIN_SKILLS);
    await expect(registry.dispatch({ cmd: 'file.read', path: 'AGENTS.md' })).rejects.toMatchObject({ code: 'file.not-found' });
    await expect(registry.dispatch({ cmd: 'project.refresh' })).rejects.toMatchObject({ code: 'file.not-found' });
  });

  it('saves, reopens and exports via the same scoped text/byte writers; closing restores downloads', async () => {
    const files: Record<string, string> = {};
    const { registry, host, transport } = setup(files);
    host.files.download = vi.fn();
    host.view.screenshot = vi.fn(async () => ({ png: 'data:image/png;base64,AAECAw==' }));
    await registry.dispatch({ cmd: 'project.open', picker: true });
    expect(await registry.dispatch({ cmd: 'file.save', name: 'models/beam.femlab.json' })).toEqual({ name: 'models/beam.femlab.json', to: 'project' });
    expect(JSON.parse(files['models/beam.femlab.json']!)).toEqual(MODEL_FILE);
    await registry.dispatch({ cmd: 'file.open', path: 'models/beam.femlab.json' });
    expect(transport.importFile).toHaveBeenCalledWith(MODEL_FILE);
    await registry.dispatch({ cmd: 'file.export', spec: { format: 'script' }, name: 'scripts/beam.ts' });
    expect(files['scripts/beam.ts']).toContain('fem.');
    await registry.dispatch({ cmd: 'file.export', spec: { format: 'png' }, name: 'images/beam.png' });
    expect([...files['images/beam.png']!].map((c) => c.charCodeAt(0))).toEqual([0, 1, 2, 3]);
    expect(host.files.download).not.toHaveBeenCalled();
    await registry.dispatch({ cmd: 'project.close' });
    expect(await registry.dispatch({ cmd: 'file.save', name: 'download.femlab.json' })).toEqual({ name: 'download.femlab.json', to: 'download' });
    expect(host.files.download).toHaveBeenCalledOnce();
    await expect(host.project.writeText('x', 'x')).rejects.toMatchObject({ code: 'file.not-found' });
    await expect(host.project.writeBytes('x', new Uint8Array())).rejects.toMatchObject({ code: 'file.not-found' });
  });

  it('refuses absolute, traversal and control-character paths before any file handle is touched', async () => {
    const { registry, host, handle } = setup();
    await registry.dispatch({ cmd: 'project.open', handle });
    const file = vi.spyOn(handle, 'getFileHandle');
    const directory = vi.spyOn(handle, 'getDirectoryHandle');
    for (const path of ['../x', '/etc/x', '\\server\\share', 'C:\\x', 'a/../x', 'a\\..\\x', 'x\0y', 'x:y', '.', '']) {
      await expect(registry.dispatch({ cmd: 'file.read', path })).rejects.toMatchObject({ code: 'file.scope' });
      await expect(registry.dispatch({ cmd: 'file.write', path, text: 'x' })).rejects.toMatchObject({ code: 'file.scope' });
      await expect(registry.dispatch({ cmd: 'file.save', name: path })).rejects.toMatchObject({ code: 'file.scope' });
      await expect(host.project.writeBytes(path, new Uint8Array([1]))).rejects.toMatchObject({ code: 'file.scope' });
    }
    expect(file).not.toHaveBeenCalled();
    expect(directory).not.toHaveBeenCalled();
  });

  it('preserves the active folder on picker cancellation, permission denial and invalid handles', async () => {
    const { registry, host, access, store, handle } = setup({ 'AGENTS.md': 'Keep these rules.' });
    await registry.dispatch({ cmd: 'project.open', handle });
    const before = store.state.project;
    const pick = vi.spyOn(access, 'pick').mockRejectedValue(new DOMException('picker cancelled', 'AbortError'));
    await expect(registry.dispatch({ cmd: 'project.open', picker: true })).rejects.toMatchObject({ code: 'cancelled', cause: 'picker cancelled' });
    expect(pick).toHaveBeenCalledOnce();
    const denied = fakeDir({}, 'denied');
    denied.requestPermission = vi.fn(async () => 'denied' as const);
    const entries = vi.spyOn(denied, 'entries');
    await expect(registry.dispatch({ cmd: 'project.open', handle: denied })).rejects.toMatchObject({ code: 'file.scope' });
    expect(denied.requestPermission).toHaveBeenCalledWith({ mode: 'readwrite' });
    expect(entries).not.toHaveBeenCalled();
    for (const bad of [null, {}, { kind: 'file' }, { kind: 'directory', name: 'x' }]) {
      await expect(host.project.open({ handle: bad })).rejects.toHaveProperty('code');
    }
    expect(store.state.project).toBe(before);
    expect(await registry.query({ query: 'query.projectRecent' })).toEqual({ name: 'bridge' });
    handle.requestPermission = async () => 'denied';
    await expect(registry.dispatch({ cmd: 'project.open', reopen: true })).rejects.toMatchObject({ code: 'file.scope' });
    expect(store.state.project).toBe(before);
    handle.requestPermission = async () => { throw new DOMException('permission prompt cancelled', 'AbortError'); };
    await expect(registry.dispatch({ cmd: 'project.open', reopen: true })).rejects.toMatchObject({ code: 'cancelled' });
    expect(store.state.project).toBe(before);
  });

  it('retains missing-file and denied-access causes in structured file errors', async () => {
    const { registry, handle, host } = setup();
    await registry.dispatch({ cmd: 'project.open', handle });
    await expect(registry.dispatch({ cmd: 'file.read', path: 'missing.txt' })).rejects.toMatchObject({ code: 'file.not-found', where: 'missing.txt' });
    vi.spyOn(handle, 'getFileHandle').mockRejectedValue(new DOMException('access revoked', 'NotAllowedError'));
    await expect(host.project.readText('x.txt')).rejects.toMatchObject({ code: 'file.scope', cause: 'NotAllowedError: access revoked' });
    await expect(host.project.writeText('x.txt', 'x')).rejects.toMatchObject({ code: 'file.scope' });
    await expect(host.project.writeBytes('x.txt', new Uint8Array())).rejects.toMatchObject({ code: 'file.scope' });
  });

  it('aborts failed writes, leaves existing content intact and permits a later retry', async () => {
    const files = { 'note.txt': 'old' };
    const { registry, handle } = setup(files);
    await registry.dispatch({ cmd: 'project.open', handle });
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

  it('remembers an opaque handle, re-requests permission on reopen, and forgets it on close', async () => {
    const { registry, access, handle } = setup();
    handle.requestPermission = vi.fn(async () => 'granted' as const);
    await expect(registry.query({ query: 'query.projectRecent' })).resolves.toBeNull();
    await expect(registry.dispatch({ cmd: 'project.open', reopen: true })).rejects.toMatchObject({ code: 'file.not-found' });
    await registry.dispatch({ cmd: 'project.open', handle });
    const recalled = await access.recall();
    expect(recalled).toBe(handle);
    const recall = vi.spyOn(access, 'recall');
    expect(await registry.query({ query: 'query.projectRecent' })).toEqual({ name: 'bridge' });
    expect(recall).not.toHaveBeenCalled();
    await registry.dispatch({ cmd: 'project.open', reopen: true });
    expect(handle.requestPermission).toHaveBeenCalledTimes(2);
    await registry.dispatch({ cmd: 'project.close' });
    expect(await registry.query({ query: 'query.projectRecent' })).toBeNull();
  });

  it.each(['close', 'replace'] as const)('a pending open cannot resurrect a folder after %s', async (action) => {
    const { registry, store } = setup();
    const delayed = fakeDir({}, 'old');
    const gate = deferred();
    delayed.entries = async function* () { await gate.promise; };
    const pending = registry.dispatch({ cmd: 'project.open', handle: delayed });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    if (action === 'close') await registry.dispatch({ cmd: 'project.close' });
    else await registry.dispatch({ cmd: 'project.open', handle: fakeDir({}, 'new') });
    gate.release();
    await rejected;
    expect(store.state.project?.name ?? null).toBe(action === 'close' ? null : 'new');
  });

  it('serializes remembering and forgetting so a slow store cannot restore a closed folder', async () => {
    const { registry, access, store, handle } = setup();
    const gate = deferred();
    const remember = access.remember;
    const started = vi.spyOn(access, 'remember').mockImplementation(async (h: DirHandle) => { await gate.promise; await remember(h); });
    const opening = registry.dispatch({ cmd: 'project.open', handle });
    const rejected = expect(opening).rejects.toMatchObject({ code: 'cancelled' });
    await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
    const closing = registry.dispatch({ cmd: 'project.close' });
    expect(store.state.project).toBeNull();
    gate.release();
    await Promise.all([rejected, closing]);
    expect(await access.recall()).toBeNull();
  });

  it('keeps granted file access usable when optional remembering fails', async () => {
    const { registry, access, store, handle } = setup({ 'note.txt': 'readable' });
    vi.spyOn(access, 'remember').mockRejectedValue(new Error('storage blocked'));
    await registry.dispatch({ cmd: 'project.open', handle });
    expect(await registry.dispatch({ cmd: 'file.read', path: 'note.txt' })).toEqual({ text: 'readable' });
    expect(store.state.console.some((line) => line.text.includes('could not remember'))).toBe(true);
    vi.spyOn(access, 'forget').mockRejectedValue(new DOMException('storage denied', 'SecurityError'));
    await expect(registry.dispatch({ cmd: 'project.close' })).rejects.toMatchObject({ code: 'file.scope' });
    expect(store.state.project).toBeNull();
  });
});
