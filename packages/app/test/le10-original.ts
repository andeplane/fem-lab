import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import type { TutorialCommand } from '../src/tutorial/types';

type Engine = {
  replay_hashes(json: string, skipSolves: boolean, verify: boolean): Promise<string>;
  query(json: string): string;
  free(): void;
};
type Mesh = {
  cmd: string;
  mesher: {
    nodes: { label: number; at: { value: number; unit: string }[] }[];
    elements: { kind: string; nodes: number[] }[];
    nodeSets: Record<string, number[]>;
    surfaces: Record<string, unknown>;
    provenance: { sha256: string };
  };
};
const here = path.dirname(fileURLToPath(import.meta.url));

/** One fine tutorial replay also owns the independent three-mesh physical check. */
export async function checkOriginalLe10(Engine: new (threads: number) => Engine, commands: TutorialCommand[]) {
  const errors: number[] = [];
  for (const [n, layers] of [[4, 2], [4, 4], [6, 6]] as const) {
    const size = `${n}x${n}x${layers}`;
    const mesh = (n === 6 ? commands.find(c => c.cmd === 'mesh.set') : JSON.parse(readFileSync(path.join(here, 'fixtures', 'le10-original', `${size}.mesh.json`), 'utf8'))) as Mesh;
    const deck = readFileSync(path.resolve(here, '../../../tools/fixtures/le10-original', `${size}.inp`), 'utf8');
    expect(createHash('sha256').update(deck).digest('hex')).toBe(mesh.mesher.provenance.sha256);
    expect(mesh.mesher.elements).toHaveLength(n * n * layers);
    expect(mesh.mesher.elements.every(e => e.kind === 'hex20' && e.nodes.length === 20)).toBe(true);
    const outer: number[] = [], midline: number[] = [];
    for (const node of mesh.mesher.nodes) {
      expect(node.at.every(q => q.unit === 'm')).toBe(true);
      const [x, y, z] = node.at.map(q => q.value) as [number, number, number];
      expect(x).toBeGreaterThanOrEqual(-1e-12);
      expect(y).toBeGreaterThanOrEqual(-1e-12);
      expect(z).toBeGreaterThanOrEqual(-1e-12);
      expect(z).toBeLessThanOrEqual(0.6 + 1e-12);
      expect((x / 2) ** 2 + y ** 2).toBeGreaterThanOrEqual(1 - 1e-12);
      const ellipse = (x / 3.25) ** 2 + (y / 2.75) ** 2;
      expect(ellipse).toBeLessThanOrEqual(1 + 1e-12);
      if (Math.abs(ellipse - 1) < 1e-12) {
        outer.push(node.label);
        if (Math.abs(z - 0.3) < 1e-12) midline.push(node.label);
      }
    }
    expect(outer).toHaveLength(3 * n * layers + 2 * n + 2 * layers + 1);
    expect(midline).toHaveLength(2 * n + 1);
    expect(mesh.mesher.nodeSets['outer-midline']).toEqual(midline);
    expect(Object.keys(mesh.mesher.surfaces).sort()).toEqual(['plate.bottom', 'plate.inner', 'plate.outer', 'plate.top', 'plate.x0', 'plate.y0']);
    const active = commands.map(c => c.cmd === 'mesh.set' ? mesh as unknown as TutorialCommand : c);
    expect(active.filter(c => c.cmd === 'constraint.fix')).toEqual([
      { cmd: 'constraint.fix', name: 'symx', on: 'plate.surface_plate.x0', dofs: ['ux'] },
      { cmd: 'constraint.fix', name: 'symy', on: 'plate.surface_plate.y0', dofs: ['uy'] },
      { cmd: 'constraint.fix', name: 'rim-in-plane', on: 'plate.surface_plate.outer', dofs: ['ux', 'uy'] },
      { cmd: 'constraint.fix', name: 'rim-midline', on: 'plate.nset_outer-midline', dofs: ['uz'] },
    ]);
    const engine = new Engine(1);
    try {
      await engine.replay_hashes(JSON.stringify(active.map((cmd, seq) => ({ seq, cmd, hashAfter: '' }))), false, false);
      const support = JSON.parse(engine.query(JSON.stringify({ query: 'query.set', name: 'plate.nset_outer-midline' }))) as { sourceNodeLabels: number[] };
      expect(support.sourceNodeLabels).toEqual(midline);
      const probe = (field: string, component: number, at: string[]) => JSON.parse(engine.query(JSON.stringify({ query: 'query.probe', step: 'static', field, component, at }))).value as { value: number; unit: string };
      const stress = probe('stress', 1, ['2 m', '0 m', '0.6 m']);
      expect(stress.unit).toBe('MPa');
      errors.push(Math.abs(stress.value - -5.38) / 5.38);
      const result = JSON.parse(engine.query(JSON.stringify({ query: 'query.result', step: 'static' }))) as { balance: number; appliedTotal: { value: number }[]; reactions: { constraint: string; total: { value: number }[] }[] };
      const exactLoad = -1e6 * Math.PI / 4 * (3.25 * 2.75 - 2);
      expect(Math.abs(result.appliedTotal[2]!.value / exactLoad - 1)).toBeLessThan(1e-4);
      expect(result.balance).toBeLessThan(1e-9);
      expect(Math.abs(result.reactions.find(r => r.constraint === 'rim-midline')!.total[2]!.value / -result.appliedTotal[2]!.value - 1)).toBeLessThan(1e-9);
      const mid = probe('displacement', 2, ['3.25 m', '0 m', '0.3 m']);
      expect(mid.unit).toBe('m');
      expect(Math.abs(mid.value)).toBeLessThan(1e-12);
      // A whole-face uz clamp would fail both checks, even if its coarse stress looked close.
      for (const z of ['0 m', '0.6 m']) expect(Math.abs(probe('displacement', 2, ['3.25 m', '0 m', z]).value)).toBeGreaterThan(1e-8);
    } finally { engine.free(); }
  }
  expect(errors[1]).toBeLessThan(errors[0]!);
  expect(errors[2]).toBeLessThan(errors[1]!);
  expect(errors[2]).toBeLessThan(0.02);
}
