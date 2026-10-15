import { render } from 'preact';
import { act } from 'preact/test-utils';
import { describe, expect, it, vi } from 'vitest';
import type { CostEstimate, MeshSummary, ModelSummary } from '@femlab/registry';
import { initialState } from '../src/store';
import { Checks } from '../src/ui/Results';
import type { Query } from '../src/ui/SchemaForm';
import { afterEffects, waitFor, waitForText } from './wait-for';

const mesh = (nodes: number): MeshSummary => ({
  nodes, elements: nodes / 4, dofs: nodes * 3, elementKind: 'hex8',
  bbox: [{ value: 0, unit: 'm' }, { value: 0, unit: 'm' }, { value: 0, unit: 'm' }, { value: 1, unit: 'm' }, { value: 1, unit: 'm' }, { value: 1, unit: 'm' }],
  minEdge: { value: 1, unit: 'm' }, maxEdge: { value: 1, unit: 'm' }, sets: [],
  quality: { minDetJRatio: 1, maxAspect: 1, minAngleDeg: 90, worst: [] },
});
const cost = (dofs: number): CostEstimate => ({
  dofs, nnz: dofs * dofs, nnzLower: dofs, bytes: 1000, assemblyBytes: 1000,
  residentResultBytes: 0, resultMeshBytes: 0, retainedFrames: 0, retainedBytes: 0,
  transientWorkBytes: 0, transportStagingBytes: 0, wasmTransportStagingBytes: 0,
  wasmTransportStagingComplete: false, budgetBytes: 1_610_612_736, feasible: null,
  note: 'Excludes direct-factor fill/workspace.',
});
const model = (revision: number): ModelSummary => ({
  name: 'Checks model', revision, hash: String(revision), units: {}, idealisation: 'solid3d',
  bodies: [], materials: [], sets: [], constraints: [], connections: [], loads: [], warnings: [],
  steps: [{ name: 'static', procedure: 'static', constraints: [], loads: [], solved: false }],
  meshSettings: { mesher: { kind: 'lattice', size: 1 / revision }, order: 1, formulation: 'full' },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function mount(query: Query) {
  const root = document.createElement('div');
  const show = (revision: number) => render(<Checks s={{ ...initialState, revision, model: model(revision) }} query={query} dispatch={async () => undefined} />, root);
  show(1);
  return { root, show, dispose: () => render(null, root) };
}

describe('Checks current Model receipts', () => {
  it('removes displayed old measurements while the edited Model reads are pending', async () => {
    const nextMesh = deferred<MeshSummary>(), nextCost = deferred<CostEstimate>();
    let meshReads = 0, costReads = 0;
    const query = vi.fn<Query>(async q => q.query === 'query.mesh'
      ? (++meshReads === 1 ? mesh(12) : nextMesh.promise)
      : (++costReads === 1 ? cost(36) : nextCost.promise));
    const s = mount(query);
    try {
      await waitForText(() => s.root, 'degrees of freedom36');
      s.show(2);
      await waitFor(() => meshReads === 2 && costReads === 2, 'edited Model checks to start');
      expect(s.root.textContent).not.toContain('degrees of freedom36');
      expect(s.root.textContent).not.toContain('nodes · elements12');
      expect(s.root.textContent).toContain('Reading current Mesh quality');
      expect(s.root.textContent).toContain('Reading current cost estimate');
      nextMesh.resolve(mesh(24)); nextCost.resolve(cost(72));
      await waitForText(() => s.root, 'degrees of freedom72');
      expect(s.root.textContent).toContain('nodes · elements24');
    } finally { s.dispose(); }
  });

  it.each(['success', 'failure'] as const)('ignores a retired %s without replacing current Mesh/cost values', async ending => {
    const oldMesh = deferred<MeshSummary>(), oldCost = deferred<CostEstimate>();
    let meshReads = 0, costReads = 0;
    const query = vi.fn<Query>(async q => q.query === 'query.mesh'
      ? (++meshReads === 1 ? oldMesh.promise : mesh(24))
      : (++costReads === 1 ? oldCost.promise : cost(72)));
    const s = mount(query);
    try {
      await waitFor(() => meshReads === 1 && costReads === 1, 'old checks to start');
      s.show(2);
      await waitForText(() => s.root, 'degrees of freedom72');
      await act(async () => {
        if (ending === 'success') { oldMesh.resolve(mesh(12)); oldCost.resolve(cost(36)); }
        else { oldMesh.reject({ code: 'schema', cause: 'retired Mesh' }); oldCost.reject({ code: 'schema', cause: 'retired cost' }); }
      });
      await afterEffects();
      expect(s.root.textContent).toContain('degrees of freedom72');
      expect(s.root.textContent).toContain('nodes · elements24');
      expect(s.root.textContent).not.toContain('retired');
    } finally { s.dispose(); }
  });

  it('shows a current read error without discarding the other current measurement', async () => {
    const query = vi.fn<Query>(async q => {
      if (q.query === 'query.mesh') throw { code: 'schema', cause: 'current Mesh could not be built' };
      return cost(72);
    });
    const s = mount(query);
    try {
      await waitForText(() => s.root, 'degrees of freedom72');
      expect(s.root.textContent).toContain('schema');
      expect(s.root.textContent).toContain('current Mesh could not be built');
      expect(s.root.textContent).not.toContain('Element quality appears once');
    } finally { s.dispose(); }
  });
});
