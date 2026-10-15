import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import type { Command, CostEstimate, MeshSummary, ResultSummary } from '@femlab/registry';
import type { SessionRequest, SessionResponse } from '../src/session-protocol';
import { expect, test } from './fixtures';

interface DelayedCheck {
  arm: boolean;
  held: MeshSummary | null;
  release(): void;
}
declare global { interface Window { delayedCheck: DelayedCheck } }

test('@cpu edited imported Model shows current Checks before solving, CSV comparison and portable reopen', async ({ page }, info) => {
  await page.setViewportSize({ width: 1800, height: 1100 });
  await page.addInitScript(() => {
    localStorage.setItem('femlab.tour.dismissed', '1');
    localStorage.setItem('femlab.autosave', 'off');
    const NativeWorker = window.Worker;
    // Delay a real public query reply, preserving its exact checked-owner envelope and DTO.
    // No engine method or scientific value is replaced by the browser harness.
    const control: DelayedCheck = { arm: false, held: null, release: () => undefined };
    window.delayedCheck = control;
    window.Worker = class extends NativeWorker {
      private heldIds = new Set<number>();
      private replaying = false;
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.addEventListener('message', (event: MessageEvent<SessionResponse>) => {
          const message = event.data;
          if (this.replaying || !this.heldIds.has(message.id) || 'progress' in message) return;
          this.heldIds.delete(message.id);
          event.stopImmediatePropagation();
          if (message.ok) control.held = structuredClone(message.value) as MeshSummary;
          control.release = () => {
            this.replaying = true;
            this.dispatchEvent(new MessageEvent('message', { data: message }));
            this.replaying = false;
          };
        });
      }
      override postMessage(message: SessionRequest, transferOrOptions: Transferable[] | StructuredSerializeOptions = []) {
        if (control.arm && message.op === 'query' && message.query.query === 'query.mesh') {
          control.arm = false;
          this.heldIds.add(message.id);
        }
        if (Array.isArray(transferOrOptions)) super.postMessage(message, transferOrOptions);
        else super.postMessage(message, transferOrOptions);
      }
    };
  });
  await page.goto('./');
  await page.waitForFunction(() => Boolean(window.fem));
  const submission = info.outputPath('submission');
  const source = `${submission}/bar.inp`;
  await mkdir(submission);
  const original = await readFile(new URL('../../../crates/engine/tests/fixtures/abaqus-static/bar-hex-mm-n.inp', import.meta.url), 'utf8');
  await writeFile(source, original);
  try {
    await page.getByTitle('Import Abaqus .inp', { exact: true }).click();
    const importing = page.getByRole('dialog', { name: 'Import Abaqus input deck', exact: true });
    await importing.getByLabel('Project name').fill('Current imported Checks');
    await importing.getByLabel('Body name').fill('bar');
    await importing.getByRole('button', { name: 'Linear static analysis', exact: true }).click();
    await importing.getByLabel('One source length unit').fill('1 mm');
    await importing.getByLabel('One source force unit').fill('1 N');
    const choose = page.waitForEvent('filechooser');
    await importing.getByRole('button', { name: 'Choose .inp and import', exact: true }).click();
    await (await choose).setFiles(source);
    const report = page.getByRole('dialog', { name: 'Abaqus import report', exact: true });
    await expect(report).toContainText('configured; not solved');
    await expect(report).toContainText('0.001 m');
    await report.getByTitle('Close Abaqus import report', { exact: true }).click();
    await page.getByRole('button', { name: 'mm N MPa', exact: true }).click();
    await expect.poll(() => page.evaluate(async () => (await window.fem.query.model()).units.length)).toBe('mm');
    const before = await page.evaluate(() => window.fem.query.journal());
    await page.getByRole('tab', { name: /^checks/ }).click();
    const checks = page.locator('.checks');
    const initial = await page.evaluate(() => window.fem.registry.query({ query: 'query.mesh' })) as MeshSummary;
    await expect(checks).toContainText(`max aspect ratio${initial.quality!.maxAspect}`);
    await expect(checks).toContainText('degrees of freedom36');
    expect(await page.evaluate(() => window.fem.query.journal())).toEqual(before);

    // Independently lengthen the original source while retaining its authored topology and
    // analysis Sets. Existing ordinary mesh.set is the supported source-replacement edit.
    const longer = original.replace('L=1000 mm', 'L=2000 mm').replaceAll(',1000,', ',2000,').replaceAll(',500,', ',1000,');
    await page.evaluate(async text => {
      const bytes = new TextEncoder().encode(text);
      const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
      const converted = await window.fem.registry.query({ query: 'query.convertAbaqus', text, sha256, name: 'longer source', body: 'bar', mode: 'static', unitLength: '1 mm', unitForce: '1 N' }) as { commands: Command[] };
      window.delayedCheck.arm = true;
      await window.fem.dispatch(converted.commands.find(command => command.cmd === 'mesh.set')!);
    }, longer);
    await expect.poll(() => page.evaluate(() => window.delayedCheck.held !== null)).toBe(true);
    const current = await page.evaluate(() => window.delayedCheck.held!);
    expect(current.quality!.maxAspect).not.toBe(initial.quality!.maxAspect);
    await expect(checks).toContainText('Reading current Mesh quality');
    await expect(checks).toContainText('Reading current cost estimate');
    await expect(checks).not.toContainText(`max aspect ratio${initial.quality!.maxAspect}`);
    await expect(checks).not.toContainText('degrees of freedom36');
    await page.screenshot({ path: info.outputPath('checks-current-pending.png') });
    await page.evaluate(() => window.delayedCheck.release());
    await expect(checks).toContainText(`max aspect ratio${current.quality!.maxAspect}`);
    await expect(checks).toContainText('degrees of freedom36');
    const cost = await page.evaluate(() => window.fem.registry.query({ query: 'query.cost', step: 'AXIAL' })) as CostEstimate;
    expect(cost.dofs).toBe(36);
    const afterEdit = await page.evaluate(() => window.fem.query.journal());
    expect(afterEdit.entries).toHaveLength(before.entries.length + 1);
    await page.screenshot({ path: info.outputPath('checks-current-ready.png') });

    await page.locator('.topbar button[data-cmd="solve.run"]').click();
    await expect(page.locator('.result-header')).toContainText('AXIAL');
    const result = await page.evaluate(() => window.fem.registry.query({ query: 'query.result', step: 'AXIAL' })) as ResultSummary;
    const ux = result.extremes.find(e => e.field === 'displacement' && e.component === 0)!;
    expect(ux.max.unit).toBe('mm');
    expect(Math.abs(ux.max.value - 0.001)).toBeLessThan(1e-11); // F L/(E A), L=2 m.
    expect(result.stale).toBe(false);
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    const row = page.getByRole('dialog', { name: 'Export', exact: true }).locator('.export-row').filter({ has: page.getByText('Nodal displacements (CSV)', { exact: true }) });
    const downloadingCsv = page.waitForEvent('download');
    await row.getByRole('button', { name: 'export', exact: true }).click();
    const csvPath = info.outputPath('longer-bar.csv');
    await (await downloadingCsv).saveAs(csvPath);
    const [header, ...csv] = (await readFile(csvPath, 'utf8')).trim().split('\n').map(line => line.split(','));
    expect(header).toContain('ux_m');
    expect(csv).toHaveLength(12);
    expect(Math.abs(Math.max(...csv.map(r => Number(r[10]))) - 1e-6)).toBeLessThan(1e-14);
    expect(csv.every(r => r[0] === result.resultId && r[13] === 'computed')).toBe(true);
    await page.getByRole('button', { name: /Close export/ }).click();
    const downloadingFile = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Save as file', exact: true }).click();
    const saved = info.outputPath('longer-bar.femlab.json');
    await (await downloadingFile).saveAs(saved);
    await rm(submission, { recursive: true });
    await page.evaluate(() => window.fem.dispatch({ cmd: 'project.new', name: 'after saved bar' }));
    const opening = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Open', exact: true }).click();
    await (await opening).setFiles(saved);
    await expect(page.getByRole('textbox', { name: 'Model name', exact: true })).toHaveValue('Current imported Checks');
    const reopened = await page.evaluate(() => window.fem.registry.query({ query: 'query.mesh' })) as MeshSummary;
    expect(reopened.quality).toEqual(current.quality);
    expect(reopened.nodes).toBe(12);
    await page.getByRole('tab', { name: /^checks/ }).click();
    await expect(checks).toContainText(`max aspect ratio${current.quality!.maxAspect}`);
  } finally { await rm(submission, { recursive: true, force: true }); }
});
