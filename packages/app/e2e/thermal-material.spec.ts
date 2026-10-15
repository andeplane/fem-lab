import { expect, test } from './fixtures';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Command, FrameResult, FramesResult } from '@femlab/registry';

const root = path.resolve(import.meta.dirname, '../../..');
const native = process.env['FEMLAB_NATIVE'] ?? path.join(root, 'target/release/femlab');

for (const order of [1, 2]) for (const nx of [2, 4]) {
  test(`@cpu thermal-only Material solves and replays without elastic stiffness, order ${order}, nx ${nx}`, async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('femlab.tour.dismissed', '1');
      localStorage.setItem('femlab.autosave', 'off');
    });
    await page.goto('./');
    await page.waitForFunction(() => Boolean(window.fem));
    const commands = JSON.parse(readFileSync(path.join(root, 'tools/fixtures/transient-heat.json'), 'utf8')) as Command[];
    const mesh = commands.find(command => command.cmd === 'mesh.set')! as Extract<Command, { cmd: 'mesh.set' }>;
    mesh.order = order;
    if (mesh.mesher.kind === 'lattice' && typeof mesh.mesher.size === 'object' && 'nx' in mesh.mesher.size) mesh.mesher.size.nx = nx;
    await page.evaluate(async commands => {
      for (const command of commands) await window.fem.dispatch(command);
    }, commands);

    const journal = await page.evaluate(() => window.fem.query.journal());
    const definition = await page.evaluate(() => window.fem.query.definition({ kind: 'material', name: 'mat' }));
    const recordedMaterial = journal.entries.find(entry => entry.cmd.cmd === 'material.add')!.cmd;
    for (const material of [definition.command, recordedMaterial]) {
      expect(material).toMatchObject({ cmd: 'material.add', name: 'mat' });
      for (const field of ['E', 'nu', 'orthotropic']) expect(material).not.toHaveProperty(field);
      for (const field of ['k', 'rho', 'cp']) expect(material).toHaveProperty(field);
    }

    const catalogue = await page.evaluate(() => window.fem.query.frames()) as FramesResult;
    expect(catalogue.frames.map(frame => frame.timeSi)).toEqual([0, 0.175, 0.35]);
    for (const stamp of catalogue.frames) {
      const frame = await page.evaluate(index => window.fem.query.frame({ index }), stamp.index) as FrameResult;
      expect(frame.unit).toBe('K');
      for (let index = 0; index < frame.values.length; index++) {
        // q = rho cp = 6 in SI, so the uniform exact solution is T(t) = t.
        expect(Math.abs(frame.values[index]! - (index % 3 === 0 ? stamp.timeSi : 0))).toBeLessThan(1e-10);
      }
    }

    const scratch = mkdtempSync(path.join(tmpdir(), 'femlab-thermal-browser-'));
    try {
      const file = path.join(scratch, 'journal.json');
      writeFileSync(file, JSON.stringify(journal.entries));
      const hashes = journal.entries.map(entry => entry.hashAfter);
      for (const threads of [1, 4]) {
        const common = ['run', file, '--cpu', '--threads', String(threads), '--verify'];
        const actual = execFileSync(native, [...common, '--hashes'], { encoding: 'utf8', timeout: 30_000 });
        expect(actual.trim().split(/\r?\n/)).toEqual(hashes);
        const frames = execFileSync(native, [...common, '--query', '{"query":"query.frames"}'], { encoding: 'utf8', timeout: 30_000 });
        expect(JSON.parse(frames)[0]).toEqual(catalogue);
      }
      const replay = path.join(root, 'tools/replay-wasm.mjs');
      const wasmHashes = execFileSync(process.execPath, [replay, file], { encoding: 'utf8', timeout: 30_000 });
      expect(wasmHashes.trim().split(/\r?\n/)).toEqual(hashes);
      const wasmFrames = execFileSync(process.execPath, [replay, file, '--query', '{"query":"query.frames"}'], { encoding: 'utf8', timeout: 30_000 });
      expect(JSON.parse(wasmFrames)[0]).toEqual(catalogue);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }

    const mechanical = await page.evaluate(async () => {
      await window.fem.dispatch({ cmd: 'step.add', name: 'mechanical', procedure: 'static', constraints: [], loads: [] });
      try {
        await window.fem.dispatch({ cmd: 'solve.run', step: 'mechanical' });
        return null;
      } catch (error) {
        const structured = error as { code: string; cause: string; where: string };
        return { code: structured.code, cause: structured.cause, where: structured.where };
      }
    });
    expect(mechanical).toMatchObject({ code: 'material.props', where: "material 'mat'" });
    expect(mechanical!.cause).toContain('no elastic stiffness');
  });
}
