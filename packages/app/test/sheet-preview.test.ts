import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../../..');
const commands = JSON.parse(readFileSync(path.join(root, 'crates/engine/tests/fixtures/sheet-preview.json'), 'utf8'));
const wasm = createRequire(import.meta.url)(path.join(root, 'tools/wasm-node/femlab_engine_wasm.js'));

it('transfers the unmeshed Sheet as closed tagged loops with the analytical transformed area', async () => {
  const engine = new wasm.Engine(1);
  await engine.replay_hashes(JSON.stringify(commands.map((cmd: unknown, seq: number) => ({ seq, cmd, hashAfter: '' }))), false, false);
  const s = engine.surface() as { positions: Float32Array; indices: Uint32Array; edges: Uint32Array; edgeSet: Uint32Array; edgeBody: Uint32Array; setNames: string[]; bodyNames: string[] };
  expect(s.indices).toHaveLength(0);
  expect(s.positions).toHaveLength(24);
  expect(s.edges).toHaveLength(16);
  expect(s.edgeSet).toHaveLength(8);
  expect(Array.from(s.edgeBody)).toEqual(Array(8).fill(0));
  expect(s.bodyNames).toEqual(['plate']);
  const areas = [0, 0];
  const degree = Array(8).fill(0) as number[];
  for (let e = 0; e < 8; e++) {
    const a = s.edges[e * 2]!; const b = s.edges[e * 2 + 1]!;
    degree[a]!++; degree[b]!++;
    expect(s.positions[a * 3 + 2]).toBe(0);
    const hole = s.setNames[s.edgeSet[e]!] === 'plate.hole';
    areas[hole ? 1 : 0]! += (s.positions[a * 3]! * s.positions[b * 3 + 1]! - s.positions[b * 3]! * s.positions[a * 3 + 1]!) / 2;
  }
  expect(degree).toEqual(Array(8).fill(2));
  expect(areas).toEqual([24, -6]);
  expect(areas[0]! + areas[1]!).toBe(18);
  expect(new Set(Array.from(s.edgeSet, i => s.setNames[i]))).toEqual(new Set(['plate.left', 'plate.bottom', 'plate.right', 'plate.top', 'plate.hole']));
});

it('keeps the vertex offsets and body/Set identities of two Sheet previews separate', async () => {
  const second = structuredClone(commands[2]);
  second.name = 'second';
  second.shape.at.translate = ['15 m', '7 m', '0 m'];
  const engine = new wasm.Engine(1);
  await engine.replay_hashes(JSON.stringify([...commands, second].map((cmd, seq) => ({ seq, cmd, hashAfter: '' }))), false, false);
  const s = engine.surface() as { positions: Float32Array; edges: Uint32Array; edgeSet: Uint32Array; edgeBody: Uint32Array; setNames: string[]; bodyNames: string[] };
  expect(s.bodyNames).toEqual(['plate', 'second']);
  expect(s.edges).toHaveLength(32);
  for (let e = 0; e < 8; e++) {
    expect(s.edgeBody[e + 8]).toBe(1);
    expect(s.setNames[s.edgeSet[e + 8]!]).toBe(s.setNames[s.edgeSet[e]!]!.replace('plate.', 'second.'));
    for (let k = 0; k < 2; k++) {
      const a = s.edges[e * 2 + k]!; const b = s.edges[(e + 8) * 2 + k]!;
      expect(b).toBe(a + 8);
      expect(s.positions[b * 3]! - s.positions[a * 3]!).toBeCloseTo(10, 6);
      expect(s.positions[b * 3 + 1]).toBe(s.positions[a * 3 + 1]);
    }
  }
});
