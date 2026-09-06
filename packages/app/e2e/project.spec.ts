// Issue #13: real Chromium directory handles travel through the production Registry and host.
import { expect, test, type Page } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function ready(page: Page) {
  await page.waitForFunction(() => typeof window.fem !== 'undefined', undefined, { timeout: 60_000 });
  await page.waitForFunction(async () => Boolean(await window.fem.query.capabilities()), undefined, { timeout: 60_000 });
}

test.describe('@cpu project file host', () => {
  test('scoped native files, scripts, exports, shared context and remembered handles survive reload', async ({ page }) => {
    await page.goto('./');
    await ready(page);
    await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const folder = await root.getDirectoryHandle('project-13', { create: true });
      const put = async (dir: FileSystemDirectoryHandle, name: string, text: string) => {
        const file = await dir.getFileHandle(name, { create: true });
        const stream = await file.createWritable(); await stream.write(text); await stream.close();
      };
      await put(root, 'outside.txt', 'outside sentinel');
      await put(folder, 'AGENTS.md', 'Check reactions before reporting.');
      const skills = await folder.getDirectoryHandle('skills', { create: true });
      const skill = await skills.getDirectoryHandle('project-check', { create: true });
      await put(skill, 'SKILL.md', '---\nname: project-check\ndescription: Check this project.\n---\n\nOriginal project instructions.');
      // Native prototype methods and handle identity must survive schema parsing.
      await window.fem.dispatch({ cmd: 'project.open', handle: folder });
      await window.fem.dispatch({ cmd: 'panel.toggle', panel: 'assistant', open: true });
    });
    const drawer = page.locator('aside.assistant');
    await expect(drawer).toContainText('project-13');
    await expect(drawer.locator('.chips')).toContainText('project-check');
    await expect(drawer).toContainText('AGENTS.md');
    expect(await page.evaluate(() => window.fem.registry.query({ query: 'query.project' }))).toMatchObject({ name: 'project-13', agentsMd: 'AGENTS.md', skills: ['project-check'] });
    expect(await page.evaluate(() => window.fem.dispatch({ cmd: 'skill.invoke', name: 'project-check' }))).toMatchObject({ body: 'Original project instructions.', source: 'project' });
    await page.evaluate(async () => {
      await window.fem.dispatch({ cmd: 'file.write', path: 'skills/project-check/SKILL.md', text: '---\nname: project-check\ndescription: Revised check.\n---\n\nRevised project instructions.' });
      await window.fem.dispatch({ cmd: 'file.write', path: 'scripts/read-project.ts', text: 'const rules = await fem.file.read({path:"AGENTS.md"}); await fem.file.write({path:"exports/script-report.txt",text:rules.text}); return rules.text;' });
    });
    expect(await page.evaluate(() => window.fem.dispatch({ cmd: 'skill.invoke', name: 'project-check' }))).toMatchObject({ body: 'Revised project instructions.' });
    expect(await page.evaluate(async () => {
      const { text } = await window.fem.dispatch({ cmd: 'file.read', path: 'scripts/read-project.ts' }) as { text: string };
      return window.fem.dispatch({ cmd: 'script.run', code: text });
    })).toMatchObject({ result: 'Check reactions before reporting.' });
    expect(await page.evaluate(() => window.fem.dispatch({ cmd: 'file.read', path: 'exports/script-report.txt' }))).toEqual({ text: 'Check reactions before reporting.' });
    // An external editor's change only becomes the shared catalog after refresh.
    await page.evaluate(async () => {
      const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle('project-13');
      await folder.removeEntry('skills', { recursive: true });
      const stream = await (await folder.getFileHandle('AGENTS.md')).createWritable();
      await stream.write('Externally revised rules.'); await stream.close();
    });
    await drawer.locator('[data-cmd="project.refresh"]').click();
    await expect(drawer.locator('.chips')).not.toContainText('project-check');
    expect(await page.evaluate(() => window.fem.dispatch({ cmd: 'file.read', path: 'AGENTS.md' }))).toEqual({ text: 'Externally revised rules.' });
    const errors = await page.evaluate(async () => {
      const errors: string[] = [];
      for (const path of ['../outside.txt', '/outside.txt', 'nested/../../outside.txt', 'nested\\..\\outside.txt']) {
        try { await window.fem.dispatch({ cmd: 'file.write', path, text: 'escaped' }); }
        catch (error) { errors.push((error as { code: string }).code); }
      }
      return errors;
    });
    expect(errors).toEqual(['file.scope', 'file.scope', 'file.scope', 'file.scope']);
    expect(await page.evaluate(async () => (await (await (await navigator.storage.getDirectory()).getFileHandle('outside.txt')).getFile()).text())).toBe('outside sentinel');
    await page.evaluate(async () => {
      await window.fem.model.new({ name: 'saved-project' });
      await window.fem.geometry.addBox({ name: 'beam', size: ['2 m', '1 m', '1 m'] });
      await window.fem.dispatch({ cmd: 'file.save', name: 'models/saved.femlab.json' });
      await window.fem.dispatch({ cmd: 'file.export', spec: { format: 'script' }, name: 'exports/model.ts' });
      await window.fem.model.new({ name: 'temporary' });
      await window.fem.dispatch({ cmd: 'file.open', path: 'models/saved.femlab.json' });
    });
    expect(await page.evaluate(() => window.fem.query.model())).toMatchObject({ name: 'saved-project', bodies: [{ name: 'beam' }] });
    expect(await page.evaluate(() => window.fem.dispatch({ cmd: 'file.read', path: 'exports/model.ts' }))).toMatchObject({ text: expect.stringContaining('geometry.addBox') });
    // Exercise autosave from a new engine Command; file.open UI hydration belongs to #127.
    await page.evaluate(() => window.fem.geometry.addBox({ name: 'autosave-check', size: ['1 m', '1 m', '1 m'] }));
    await expect(page.locator('.viewer canvas')).toBeVisible();
    await page.evaluate(() => window.fem.dispatch({ cmd: 'file.export', spec: { format: 'png' }, name: 'exports/view.png' }));
    expect(await page.evaluate(async () => {
      const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle('project-13');
      const dir = await folder.getDirectoryHandle('exports');
      const file = await (await dir.getFileHandle('view.png')).getFile();
      return Array.from(new Uint8Array(await file.slice(0, 8).arrayBuffer()));
    })).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    // Await the actual debounced IndexedDB commit, not the host's optimistic autosave label.
    await expect.poll(() => page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('femlab', 1);
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      try {
        return await new Promise<string | null>((resolve, reject) => {
          const request = db.transaction('autosave', 'readonly').objectStore('autosave').get('last');
          request.onsuccess = () => resolve((request.result as { name: string } | undefined)?.name ?? null);
          request.onerror = () => reject(request.error);
        });
      } finally { db.close(); }
    })).toBe('saved-project');
    await page.reload(); await ready(page);
    expect(await page.evaluate(() => window.fem.registry.query({ query: 'query.project' }))).toBeNull();
    expect(await page.evaluate(() => window.fem.registry.query({ query: 'query.projectRecent' }))).toEqual({ name: 'project-13' });
    // Autosave and handle persistence each opened their database before this reload.
    expect(await page.evaluate(() => window.fem.registry.query({ query: 'query.autosave' }))).toMatchObject({ enabled: true, saved: { name: 'saved-project', commands: 3 } });
    await page.evaluate(() => window.fem.dispatch({ cmd: 'panel.toggle', panel: 'assistant', open: true }));
    await drawer.getByRole('button', { name: 'reopen project-13', exact: true }).click();
    await expect(drawer).toContainText('AGENTS.md');
    expect(await page.evaluate(() => window.fem.dispatch({ cmd: 'file.read', path: 'AGENTS.md' }))).toEqual({ text: 'Externally revised rules.' });
    await drawer.locator('[data-cmd="project.close"]').click();
    await expect(drawer).toContainText('open a project folder');
    expect(await page.evaluate(() => window.fem.registry.query({ query: 'query.projectRecent' }))).toBeNull();
    const download = page.waitForEvent('download');
    await page.evaluate(() => window.fem.dispatch({ cmd: 'file.save', name: 'closed.femlab.json' }));
    expect((await download).suggestedFilename()).toBe('closed.femlab.json');
  });

  test('Chromium native handles refuse file and directory symlinks leaving the granted folder', async ({ page }) => {
    const fixture = await mkdtemp(join(tmpdir(), 'fem-project-scope-'));
    try {
      const project = join(fixture, 'project'); const outside = join(fixture, 'outside');
      await mkdir(project); await mkdir(outside);
      await writeFile(join(project, 'inside.txt'), 'inside');
      await writeFile(join(outside, 'sentinel.txt'), 'outside sentinel');
      await symlink(join(outside, 'sentinel.txt'), join(project, 'link.txt'));
      await symlink(outside, join(project, 'link-dir'));
      await page.goto('./');
      // A native drag grants a real local directory handle without mocking the browser API.
      await page.evaluate(() => {
        document.body.innerHTML = '<div style="position:fixed;inset:0">Drop folder</div>';
        document.body.addEventListener('dragover', (event) => event.preventDefault());
        document.body.addEventListener('drop', async (event) => {
          event.preventDefault();
          const item = event.dataTransfer!.items[0]! as DataTransferItem & { getAsFileSystemHandle(): Promise<FileSystemDirectoryHandle> };
          const root = await item.getAsFileSystemHandle();
          const results: Record<string, string> = {};
          for (const path of ['inside.txt', 'link.txt', 'link-dir/sentinel.txt']) {
            try {
              let dir = root; const parts = path.split('/');
              for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
              results[path] = await (await (await dir.getFileHandle(parts.at(-1)!)).getFile()).text();
            } catch (error) { results[path] = (error as Error).name; }
          }
          document.body.dataset['result'] = JSON.stringify(results);
        });
      });
      const cdp = await page.context().newCDPSession(page);
      const data = { items: [], files: [project], dragOperationsMask: 1 };
      for (const type of ['dragEnter', 'dragOver', 'drop'] as const) await cdp.send('Input.dispatchDragEvent', { type, x: 100, y: 100, data });
      await expect.poll(() => page.evaluate(() => document.body.dataset['result'])).toBeTruthy();
      expect(JSON.parse((await page.evaluate(() => document.body.dataset['result']))!)).toEqual({ 'inside.txt': 'inside', 'link.txt': 'NotFoundError', 'link-dir/sentinel.txt': 'NotFoundError' });
      expect(await readFile(join(outside, 'sentinel.txt'), 'utf8')).toBe('outside sentinel');
    } finally { await rm(fixture, { recursive: true, force: true }); }
  });
});
