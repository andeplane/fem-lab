// PLAN 4.12 and 4.13 against an in-memory `FileSystemDirectoryHandle`: what the folder lists, what
// AGENTS.md becomes, which skills override which, and that nothing outside the folder is reachable.
import { describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { BUILTIN_SKILLS } from '../src/ai/skills';
import { forgetHandle, kindOf, pickFolder, ProjectFolder, projectSkills, watchAgents, recentFolder, recallHandle, rememberHandle, rememberedFolder, type Breadcrumbs, type DirHandle } from '../src/ai/project';
import { browserProjectAccessFor } from '../src/project-host';

import { fakeDir } from './project-fake';

const SKILL = '---\nname: write-report\ndescription: The house calculation note.\n---\n\nUse the firm template.';

const FILES = {
  'AGENTS.md': 'All stresses in MPa. S355 yield 355 MPa.',
  'beam.femlab.json': '{}',
  'calc/sweep.ts': 'fem.mesh.set({})',
  'skills/write-report/SKILL.md': SKILL,
  'skills/broken/SKILL.md': 'no frontmatter here',
  'node_modules/pkg/index.js': 'ignored',
  '.git/config': 'ignored',
};

describe('account-owned remembered project folders', () => {
  const directory = (name: string): DirHandle => ({ kind: 'directory', name }) as DirHandle;
  function breadcrumbs() {
    const values = new Map<string, string>();
    const crumbs: Breadcrumbs = { getItem: key => values.get(key) ?? null, setItem: vi.fn((key, value) => { values.set(key, value); }), removeItem: key => { values.delete(key); } };
    return { values, crumbs };
  }

  it('preserves legacy anonymous folders while list, recall and forget stay private to each owner', async () => {
    const factory = new IDBFactory(); const { crumbs } = breadcrumbs();
    await rememberHandle(directory('anonymous'), factory, () => 1, crumbs);
    await rememberHandle(directory('private A'), factory, () => 2, crumbs, 'A');
    await rememberHandle(directory('private B'), factory, () => 3, crumbs, 'B');
    expect(await recentFolder(factory)).toEqual({ name: 'anonymous' });
    expect(await rememberedFolder(factory, 'A')).toEqual({ name: 'private A', at: 2 });
    expect(await recentFolder(factory, 'missing')).toBeNull();
    expect(await recallHandle(factory, crumbs, 'A')).toEqual(directory('private A'));
    expect(await recallHandle(factory, crumbs, 'B')).toEqual(directory('private B'));
    expect(await recallHandle(factory, crumbs)).toEqual(directory('anonymous'));
    await forgetHandle(factory, crumbs, 'A');
    expect(await recallHandle(factory, crumbs, 'A')).toBeNull();
    expect(await recentFolder(factory, 'B')).toEqual({ name: 'private B' });
    expect(await recentFolder(factory)).toEqual({ name: 'anonymous' });
    const injectedOwner = '\0femlab:folder-owner:v1:' + JSON.stringify(['B', 'folder']);
    expect(await recallHandle(factory, crumbs, injectedOwner)).toBeNull();
    expect(await recallHandle(factory, crumbs, 'B')).toEqual(directory('private B'));
  });

  it('isolates restore crash breadcrumbs even when owners remember identically named folders', async () => {
    const factory = new IDBFactory(); const { values, crumbs } = breadcrumbs();
    await rememberHandle(directory('same name'), factory, () => 1, crumbs, 'A');
    await rememberHandle(directory('same name'), factory, () => 1, crumbs, 'B');
    await recallHandle(factory, crumbs, 'A');
    const guard = vi.mocked(crumbs.setItem).mock.calls[0]![0]; values.set(guard, 'same name');
    expect(await recallHandle(factory, crumbs, 'B')).toEqual(directory('same name'));
    expect(values.get(guard)).toBe('same name');
    await expect(recallHandle(factory, crumbs, 'A')).rejects.toMatchObject({ code: 'file.not-found' });
    expect(await rememberedFolder(factory, 'A')).toBeNull();
    expect(await rememberedFolder(factory, 'B')).toEqual({ name: 'same name', at: 1 });
    expect(values.has(guard)).toBe(false);
  });

  it('captures the owner of browser access before an asynchronous remember completes', async () => {
    const factory = new IDBFactory(); const { crumbs } = breadcrumbs();
    vi.stubGlobal('indexedDB', factory); vi.stubGlobal('localStorage', crumbs);
    try {
      const a = browserProjectAccessFor('A'); let active = a;
      const pending = active.remember(directory('late A'));
      active = browserProjectAccessFor('B'); await active.remember(directory('current B')); await pending;
      expect(await a.recall()).toEqual(directory('late A'));
      expect(await active.recall()).toEqual(directory('current B'));
      expect(await browserProjectAccessFor(null).recent()).toBeNull();
      await active.forget();
      expect(await a.recent()).toEqual({ name: 'late A' }); expect(await active.recent()).toBeNull();
    } finally { vi.unstubAllGlobals(); }
  });
});

describe('the project folder', () => {
  it('lists the files it should and skips the ones nobody wants in a prompt', async () => {
    const folder = await ProjectFolder.fromHandle(fakeDir({ ...FILES }));
    expect(folder.name).toBe('bridge');
    expect(folder.files.map((f) => f.path)).toEqual(['AGENTS.md', 'beam.femlab.json', 'calc/sweep.ts', 'skills/broken/SKILL.md', 'skills/write-report/SKILL.md']);
  });

  it('tags each file with the kind the context strip and the prompt show', () => {
    expect(kindOf('AGENTS.md')).toBe('agents');
    expect(kindOf('sub/CLAUDE.md')).toBe('agents');
    expect(kindOf('skills/x/SKILL.md')).toBe('skill');
    expect(kindOf('beam.femlab.json')).toBe('journal');
    expect(kindOf('calc/sweep.ts')).toBe('script');
    expect(kindOf('reports/note.md')).toBe('export');
    expect(kindOf('notes.txt')).toBe('other');
  });

  it('reads AGENTS.md, prefers it over CLAUDE.md, and reports which one is in force', async () => {
    const both = await ProjectFolder.fromHandle(fakeDir({ 'AGENTS.md': 'a', 'CLAUDE.md': 'b' }));
    expect(both.agentsMd).toMatchObject({ file: 'AGENTS.md', text: 'a' });
    const claude = await ProjectFolder.fromHandle(fakeDir({ 'CLAUDE.md': 'b' }));
    expect(claude.agentsMd).toMatchObject({ file: 'CLAUDE.md', text: 'b' });
    const neither = await ProjectFolder.fromHandle(fakeDir({ 'x.md': 'c' }));
    expect(neither.agentsMd).toBeNull();
    expect(neither.info()).toEqual({ name: 'bridge', files: [{ path: 'x.md', size: 1, kind: 'export' }], agentsMd: null, skills: [] });
  });

  it('parses the project skills and skips a malformed SKILL.md rather than refusing the folder', async () => {
    const folder = await ProjectFolder.fromHandle(fakeDir({ ...FILES }));
    expect(folder.skills.map((s) => s.name)).toEqual(['write-report']);
    expect(folder.skills[0]!.source).toBe('project');
  });

  it('lets a project skill override the built-in of the same name and keeps the others', async () => {
    const folder = await ProjectFolder.fromHandle(fakeDir({ ...FILES }));
    const merged = projectSkills(BUILTIN_SKILLS, folder);
    expect(merged.find((s) => s.name === 'write-report')).toMatchObject({ source: 'project', body: 'Use the firm template.' });
    expect(merged.filter((s) => s.source === 'builtin').length).toBe(BUILTIN_SKILLS.length - 1);
    expect(projectSkills(BUILTIN_SKILLS, null)).toEqual(BUILTIN_SKILLS);
  });

  it('reads and writes by relative path, creating directories, and re-lists afterwards', async () => {
    const files: Record<string, string> = { ...FILES };
    const folder = await ProjectFolder.fromHandle(fakeDir(files));
    expect(await folder.readText('calc/sweep.ts')).toBe('fem.mesh.set({})');
    await folder.writeText('reports/beam.md', '# Beam');
    expect(files['reports/beam.md']).toBe('# Beam');
    await folder.refresh();
    expect(folder.files.some((f) => f.path === 'reports/beam.md')).toBe(true);
    await folder.writeBytes('reports/beam.vtu', new TextEncoder().encode('<VTKFile/>'));
    expect(files['reports/beam.vtu']).toBe('<VTKFile/>');
  });

  it('rejects oversized folder content before reading it into memory', async () => {
    const dir = fakeDir({ 'large.txt': 'x' });
    const handle = await dir.getFileHandle('large.txt');
    const text = vi.fn(async () => 'must not be read');
    vi.spyOn(dir, 'getFileHandle').mockResolvedValue({ ...handle, getFile: async () => ({ size: 17 * 1024 * 1024, lastModified: 0, text, arrayBuffer: async () => new ArrayBuffer(0) }) });
    const folder = await ProjectFolder.fromHandle(dir);
    await expect(folder.readText('large.txt')).rejects.toMatchObject({ code: 'unsupported' });
    expect(text).not.toHaveBeenCalled();
    await expect(folder.readText('large.txt', 2 * 1024 * 1024)).rejects.toMatchObject({ code: 'unsupported' });
    expect(text).not.toHaveBeenCalled();
  });

  it('publishes refresh atomically and serializes reads from the watcher and Commands', async () => {
    const files: Record<string, string> = { ...FILES };
    const folder = await ProjectFolder.fromHandle(fakeDir(files));
    const before = { files: folder.files, rules: folder.agentsMd, skills: folder.skills };
    files['AGENTS.md'] = 'New rules.';
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const original = folder.readText.bind(folder);
    const read = vi.spyOn(folder, 'readText').mockImplementationOnce(async () => {
      await pending;
      throw new Error('permission revoked');
    });
    const first = folder.refresh();
    const failed = expect(first).rejects.toThrow('permission revoked');
    const second = folder.refresh();
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    expect(folder.files).toBe(before.files);
    expect(folder.agentsMd).toBe(before.rules);
    expect(folder.skills).toBe(before.skills);
    read.mockImplementation(original);
    release();
    await failed;
    await second;
    expect(folder.agentsMd?.text).toBe('New rules.');
    expect(folder.skills.map((s) => s.name)).toEqual(['write-report']);
    read.mockRestore();
  });

  it('refuses every path that would leave the folder before it touches a handle', async () => {
    const folder = await ProjectFolder.fromHandle(fakeDir({ ...FILES }));
    for (const path of ['../secrets.md', '/etc/passwd', 'C:\\keys.txt', 'a/../../b']) {
      await expect(folder.readText(path)).rejects.toMatchObject({ code: 'file.scope' });
    }
  });

  it('stops at four levels deep, so a checked-out repo cannot fill the prompt', async () => {
    const folder = await ProjectFolder.fromHandle(fakeDir({ 'a/b/c/deep.md': '1', 'a/b/c/d/too-deep.md': '2' }));
    expect(folder.files.map((f) => f.path)).toEqual(['a/b/c/deep.md']);
  });
});

describe('watching AGENTS.md', () => {
  it('calls back only when the text actually changed, and stops when told to', async () => {
    const files = { 'AGENTS.md': 'a' };
    let at = 1;
    const folder = await ProjectFolder.fromHandle(fakeDir(files, 'bridge', at));
    const onChange = vi.fn();
    let tick = () => {};
    const stop = watchAgents(folder, onChange, 1000, ((fn: () => void) => {
      tick = fn;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval);

    tick();
    await vi.waitFor(() => expect(onChange).not.toHaveBeenCalled());
    at = 2;
    Object.assign(folder, { handle: fakeDir({ 'AGENTS.md': 'a changed' }, 'bridge', at) });
    tick();
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    stop();
  });
});

describe('watching project skills', () => {
  it('keeps the last catalog on read failure, reports once, and retries until skills recover', async () => {
    const files: Record<string, string> = { 'skills/write-report/SKILL.md': SKILL };
    const folder = await ProjectFolder.fromHandle(fakeDir(files));
    const before = folder.skills;
    const onChange = vi.fn();
    const onError = vi.fn();
    let tick = () => {};
    const stop = watchAgents(folder, onChange, 1000, ((fn: () => void) => {
      tick = fn;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval, onError);
    const read = vi.spyOn(folder, 'readText').mockRejectedValue(new Error('permission revoked'));
    try {
      tick();
      tick(); // one read at a time, even when the timer fires again before it completes
      await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
      expect(read).toHaveBeenCalledTimes(1);
      expect(folder.skills).toBe(before);
      expect(onChange).not.toHaveBeenCalled();
      tick();
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
      expect(onError).toHaveBeenCalledTimes(1);
      read.mockRestore();
      files['skills/write-report/SKILL.md'] = SKILL.replace('Use the firm template.', 'Use the updated template.');
      tick();
      await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
      expect(folder.skills[0]!.body).toBe('Use the updated template.');
      delete files['skills/write-report/SKILL.md'];
      tick();
      await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(2));
      expect(folder.skills).toEqual([]);
      stop();
      files['skills/write-report/SKILL.md'] = SKILL;
      tick();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(onChange).toHaveBeenCalledTimes(2);
    } finally {
      read.mockRestore();
      stop();
    }
  });
});

describe('the directory picker', () => {
  it('says plainly that the browser is the problem when there is no picker', async () => {
    await expect(pickFolder({})).rejects.toThrow(/Chromium/);
    const handle = fakeDir({});
    await expect(pickFolder({ showDirectoryPicker: async () => handle })).resolves.toBe(handle);
  });
});

describe('the built-in skills', () => {
  it('all parse, and every one has a name, a description worth reading and a body', () => {
    expect(BUILTIN_SKILLS.map((s) => s.name)).toEqual([
      'beam-theory-check',
      'convergence-study',
      'eurocode-1992-check',
      'heat-transfer-check',
      'modal-check',
      'nafems-benchmark',
      'write-report',
    ]);
    for (const skill of BUILTIN_SKILLS) {
      expect(skill.description.length, skill.name).toBeGreaterThanOrEqual(40);
      expect(skill.when, skill.name).toBeTruthy();
      expect(skill.body.length, skill.name).toBeGreaterThan(200);
      expect(skill.source).toBe('builtin');
    }
  });
});
