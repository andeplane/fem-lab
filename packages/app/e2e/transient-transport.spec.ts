import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Command, FrameResult, FramesResult, ProbeResult } from '@femlab/registry';

const root = path.resolve(import.meta.dirname, '../../..');

test('@cpu browser-recorded transient Journals retain f64 frames and replay in native/Node hosts', async ({ page }) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => {
    localStorage.setItem('femlab.tour.dismissed', '1');
    localStorage.setItem('femlab.autosave', 'off');
    const Original = window.Worker;
    (window as unknown as { frameTransfers: number[] }).frameTransfers = [];
    window.Worker = class extends Original {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.addEventListener('message', (event: MessageEvent) => {
          const response = event.data as { buffers?: { dtype: string; length: number }[]; raw?: ArrayBuffer[] };
          if (response.buffers?.[0]?.dtype === 'f64') {
            const raw = response.raw![0]!;
            if (raw.byteLength !== response.buffers[0].length * 8) throw new Error('bad f64 transfer size');
            (window as unknown as { frameTransfers: number[] }).frameTransfers.push(raw.byteLength);
          }
        });
      }
    };
  });
  await page.goto('./');
  await page.waitForFunction(() => Boolean(window.fem));
  const recorded = path.join(root, 'packages/app/test-results/transient-journals');
  mkdirSync(recorded, { recursive: true });
  try {
    for (const kind of ['heat', 'explicit-2d', 'explicit-3d']) for (const order of [1, 2]) for (const nx of [2, 4]) {
      const name = `${kind}-o${order}-n${nx}`;
      const commands = JSON.parse(readFileSync(path.join(root, `tools/fixtures/transient-${kind}.json`), 'utf8')) as Record<string, unknown>[];
      const mesh = commands.find(c => c['cmd'] === 'mesh.set')! as { order: number; mesher: { kind: string; blocks: { n: number[] }[]; size: { nx: number } } };
      mesh.order = order;
      if (mesh.mesher.kind === 'mapped') mesh.mesher.blocks[0]!.n[0] = nx;
      else mesh.mesher.size.nx = nx;
      await page.evaluate(async (cmds) => { for (const cmd of cmds) await window.fem.dispatch(cmd as Command); }, commands);
      const journal = await page.evaluate(() => window.fem.query.journal());
      writeFileSync(path.join(recorded, `${name}.json`), JSON.stringify(journal.entries));
      const catalogue = await page.evaluate(() => window.fem.query.frames()) as FramesResult;
      expect(catalogue.frames.length).toBeGreaterThanOrEqual(3);
      const heat = kind === 'heat';
      for (const stamp of catalogue.frames) {
        const frame = await page.evaluate(index => window.fem.query.frame({ index }), stamp.index) as FrameResult;
        const expected = heat ? stamp.timeSi : -4.905 * stamp.timeSi ** 2;
        expect(Array.isArray(frame.values)).toBe(true);
        expect(frame.unit).toBe(heat ? 'K' : 'm');
        expect(frame.sample.frame).toEqual(stamp);
        for (let j = 0; j < frame.values.length; j++) expect(Math.abs(frame.values[j]! - (j % 3 === (heat ? 0 : 1) ? expected : 0))).toBeLessThan(heat ? 1e-10 : 1e-12);
        // Mutating a caller's copy must neither corrupt retained engine state nor future reads.
        const reread = await page.evaluate(async (index) => {
          const first = await window.fem.query.frame({ index });
          first.values.fill(99);
          return window.fem.query.frame({ sample: { kind: 'time', time: `${first.sample.frame.timeSi} s`, sampling: 'exact' } });
        }, stamp.index) as FrameResult;
        expect(reread).toEqual(frame);
        const probe = await page.evaluate(({ index, heat, dim2 }) => window.fem.query.probe({ field: heat ? 'temperature' : 'displacement', component: heat ? 0 : 1, at: ['0.5 m', '0.05 m', dim2 ? '0 m' : '0.05 m'], sample: { kind: 'frame', index } }), { index: stamp.index, heat, dim2: kind === 'explicit-2d' }) as ProbeResult;
        expect(probe.sample).toEqual(frame.sample);
        expect(Math.abs(probe.value.value - (heat ? expected - 273.15 : expected * 1000))).toBeLessThan(1e-9);
      }
      expect(await page.evaluate(() => window.fem.query.journal())).toEqual(journal);
      // Explicitly solve the same Model again: the identity stays modelHash, so a host must
      // invalidate cached payloads on every Solve Ack, not only when that hash changes.
      const solved = commands.at(-1)!;
      await page.evaluate(cmd => window.fem.dispatch(cmd as Command), solved);
      expect((await page.evaluate(() => window.fem.query.frames())).modelHash).toBe(catalogue.modelHash);
      expect(await page.evaluate(() => (window as unknown as { frameTransfers: number[] }).frameTransfers.length)).toBeGreaterThan(0);
    }
    // Full solves, hashes and retained SI times are checked from these exact browser Journals.
    execFileSync(process.execPath, [path.join(root, 'tools/test-transient-replay.mjs'), recorded], { cwd: root, stdio: 'pipe', timeout: 120_000 });
  } finally {
    rmSync(recorded, { recursive: true, force: true });
  }
});
