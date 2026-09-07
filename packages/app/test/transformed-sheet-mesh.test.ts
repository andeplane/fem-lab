import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../../..');
const commands = JSON.parse(readFileSync(path.join(root, 'crates/engine/tests/fixtures/transformed-sheet.json'), 'utf8'));
const wasm = createRequire(import.meta.url)(path.join(root, 'tools/wasm-node/femlab_engine_wasm.js'));

it('meshes the transformed Sheet through the actual wasm API with its hole and named Sets', async () => {
  for (const size of ['1 m', '0.5 m', '0.25 m']) {
    for (const order of [1, 2]) {
      const engine = new wasm.Engine(1);
      const journal = [...commands, { cmd: 'mesh.set', mesher: { kind: 'free', of: 'plate', size }, order }];
      await engine.replay_hashes(JSON.stringify(journal.map((cmd, seq) => ({ seq, cmd, hashAfter: '' }))), false, false);
      const s = engine.surface() as { positions: Float32Array; indices: Uint32Array; source: string; bodyNames: string[] };
      expect(s.source).toBe('mesh');
      expect(s.bodyNames).toEqual(['plate']);
      expect(s.indices.length).toBeGreaterThan(0);
      let area = 0;
      for (let i = 0; i < s.indices.length; i += 3) {
        const a = s.indices[i]! * 3; const b = s.indices[i + 1]! * 3; const c = s.indices[i + 2]! * 3;
        const det = (s.positions[b]! - s.positions[a]!) * (s.positions[c + 1]! - s.positions[a + 1]!)
          - (s.positions[c]! - s.positions[a]!) * (s.positions[b + 1]! - s.positions[a + 1]!);
        expect(det).toBeGreaterThan(0);
        area += det / 2;
      }
      expect(area).toBeCloseTo(18, 5);
      for (const [name, length] of [['plate.left', 6], ['plate.bottom', 4], ['plate.right', 6], ['plate.top', 4], ['plate.hole', 10]] as const) {
        const set = JSON.parse(engine.query(JSON.stringify({ query: 'query.set', name })));
        expect(set.measure.value).toBeCloseTo(length, 10);
        expect(set.count).toBeGreaterThan(0);
      }
    }
  }
});
