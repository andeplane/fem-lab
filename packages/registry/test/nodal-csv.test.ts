import { describe, expect, it, vi } from 'vitest';
import { exportNodalDisplacements } from '../src/nodal-csv';
import { csvRow } from '../src/csv';
import { Registry, type EngineSchema } from '../src/registry';
import schema from '../src/generated/runtime-schema';
import { fakeHost, fakeTransport, RESULT } from './fakes';
import type { ModelDocument, ResultField, ResultSurface, RetainedResults } from '../src/generated/engine';

function setup() {
  const document: ModelDocument = {
    file: { format: 'femlab/1', engineVersion: 'test', journal: { entries: [] }, model: { name: 'source', idealisation: { kind: 'solid3d' }, mesh: { order: 1, formulation: 'full', mesher: {
      kind: 'imported', body: 'mesh', elements: [],
      nodes: [{ label: 1, at: [0, 0, 0] }, { label: 2, at: [1, 0, 0] }, { label: 9, at: [4, 5, 6] }],
      provenance: { sha256: 'input', conversionVersion: 'test', nodeIdentities: {
        '1': { sourceLabel: 10, instance: 'first, instance', part: 'Part "A"' },
        '2': { sourceLabel: 10, instance: 'second instance', part: 'Part "A"' },
        '9': { sourceLabel: 99, instance: 'second instance', part: 'Part "A"' },
      } },
    } } } }, hash: 'solved-model', revision: 10,
  };
  const result = { ...RESULT };
  const catalogue: RetainedResults = { limit: 8, records: [{
    id: result.resultId, step: result.step, solvedRevision: result.revision,
    modelName: document.file.model.name, modelHash: document.hash, inputHash: 'solved-input',
    stale: false, nodes: 3, elements: 0, fieldBytes: 72, meshBytes: 72, modelJsonBytes: 0,
  }] };
  const surface: ResultSurface = {
    resultId: result.resultId, step: result.step, unit: 'm', nodeCount: 3,
    sourceLabels: { nodes: [1, 2], elements: [], unusedNodes: [9] },
    positions: [0, 0, -0, 1, 0, 0, 2, 0, 0],
    indices: [], triElementNode: [], triBody: [], triElement: [], triFace: [],
    faceNames: [], setNames: [], triSetOffsets: [0], triSets: [], bodyNames: [],
    edges: [], edgeElement: [], edgeElementNode: [], edgeFace: [], edgeBody: [],
  };
  const field: ResultField = {
    resultId: result.resultId, step: result.step, field: 'displacement', per: 'node', components: 3,
    nodeCount: 3, entityCount: 3, unit: 'm', values: [0, 0, -0, 0.12345678901234566, 1e-300, 0, 1, 2, 3],
  };
  const transport = fakeTransport();
  const replies = { 'query.result': result, 'query.document': document, 'query.results': catalogue, 'query.surface': surface, 'query.field': field };
  vi.mocked(transport.query).mockImplementation(async (q) => structuredClone(replies[q.query as keyof typeof replies]) as never);
  const host = fakeHost(transport);
  const registry = new Registry({ schema: schema as unknown as EngineSchema, host });
  return { document, result, catalogue, surface, field, transport, host, registry };
}

describe('source-labelled nodal scientific CSV', () => {
  it('exports all f64 SI values with original instance labels, auxiliary nodes and uncomputed unused nodes', async () => {
    const { transport, registry, host } = setup();
    await registry.dispatch({ cmd: 'file.export', spec: { format: 'csv', table: 'nodal-displacements', step: 'static' } });
    expect(host.files.download).toHaveBeenCalledWith('source-nodal-displacements.csv', 'text/csv', [
      'resultId,step,nodeIndex,normalizedLabel,sourceLabel,instance,part,x_m,y_m,z_m,ux_m,uy_m,uz_m,status',
      'result-1,static,0,1,10,"first, instance","Part ""A""",0,0,-0,0,0,-0,computed',
      'result-1,static,1,2,10,second instance,"Part ""A""",1,0,0,0.12345678901234566,1e-300,0,computed',
      'result-1,static,2,,,,,2,0,0,1,2,3,computed',
      'result-1,static,,9,99,second instance,"Part ""A""",4,5,6,,,,unused', '',
    ].join('\n'));
    expect(transport.surface).not.toHaveBeenCalled();
    expect(transport.field).not.toHaveBeenCalled();
    expect(transport.query).toHaveBeenCalledWith({ query: 'query.surface', resultId: 'result-1' });
    expect(transport.query).toHaveBeenCalledWith({ query: 'query.field', field: 'displacement', resultId: 'result-1' });
  });

  it('quotes CR/LF and preserves signed zero rather than f32-rounding values', () => {
    expect(csvRow(['a\rb\nc', -0, 0.12345678901234566])).toBe('"a\rb\nc",-0,0.12345678901234566');
  });

  it('uses flat authored labels without invented part identities and allows absent unused nodes', async () => {
    const s = setup();
    const source = s.document.file.model.mesh!.mesher;
    if (source.kind !== 'imported') throw new Error('fixture');
    delete source.provenance;
    delete s.surface.sourceLabels!.unusedNodes;
    const out = await exportNodalDisplacements(s.transport, undefined, 'result-1');
    expect(out.data).toContain('result-1,static,0,1,1,,,');
    expect(out.data).not.toContain(',unused');
    expect(s.transport.query).toHaveBeenCalledWith({ query: 'query.result', resultId: 'result-1' });
  });

  it('exports ordinary generated meshes without claiming authored identities', async () => {
    const s = setup();
    delete s.document.file.model.mesh;
    delete s.surface.sourceLabels;
    const out = await exportNodalDisplacements(s.transport);
    expect(out.data).toContain('result-1,static,0,,,,,0,0,-0,');
    s.document.file.model.mesh = { order: 1, formulation: 'full', mesher: { kind: 'lattice', size: 1 } };
    expect((await exportNodalDisplacements(s.transport)).data).toBe(out.data);
  });

  it('keeps globally authored assembly nodes with no part/instance annotations', async () => {
    const s = setup();
    const source = s.document.file.model.mesh!.mesher;
    if (source.kind !== 'imported') throw new Error('fixture');
    source.provenance!.nodeIdentities = { '1': { sourceLabel: 10 } };
    expect((await exportNodalDisplacements(s.transport)).data).toContain('result-1,static,0,1,10,,,');
  });

  it.each(['stale', 'catalogue-stale', 'missing', 'source-changed'] as const)('refuses %s context before any file delivery', async (which) => {
    const s = setup();
    if (which === 'stale') s.result.stale = true;
    if (which === 'catalogue-stale') s.catalogue.records[0]!.stale = true;
    if (which === 'missing') s.catalogue.records = [];
    if (which === 'source-changed') s.document.hash = 'another-model';
    await expect(s.registry.dispatch({ cmd: 'file.export', spec: { format: 'csv', table: 'nodal-displacements' } })).rejects.toMatchObject({ code: 'export.unavailable' });
    expect(s.host.files.download).not.toHaveBeenCalled();
    expect(s.host.folder.writeText).not.toHaveBeenCalled();
  });

  it.each(['document', 'missing', 'stale', 'record-hash'] as const)('refuses a concurrent %s change after pinned scientific reads started', async (which) => {
    const s = setup();
    const originalQuery = vi.mocked(s.transport.query).getMockImplementation()!;
    let release!: () => void;
    let entered!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const query = vi.fn(originalQuery);
    vi.mocked(s.transport.query).mockImplementation(async (q) => {
      const snapshot = await query(q);
      if (q.query === 'query.field') { entered(); await pending; }
      return snapshot;
    });
    const exporting = s.registry.dispatch({ cmd: 'file.export', spec: { format: 'csv', table: 'nodal-displacements' } });
    await started;
    if (which === 'document') s.document.hash = 'edited-model';
    if (which === 'missing') s.catalogue.records = [];
    if (which === 'stale') s.catalogue.records[0]!.stale = true;
    if (which === 'record-hash') s.catalogue.records[0]!.modelHash = 'another-model';
    release();
    await expect(exporting).rejects.toMatchObject({ code: 'export.unavailable', cause: expect.stringContaining('while preparing') });
    expect(s.host.files.download).not.toHaveBeenCalled();
    expect(s.host.folder.writeText).not.toHaveBeenCalled();
  });

  it('preserves formula-leading source names as exact machine-readable CSV text', async () => {
    const s = setup();
    const source = s.document.file.model.mesh!.mesher;
    if (source.kind !== 'imported') throw new Error('fixture');
    source.provenance!.nodeIdentities!['1'] = { sourceLabel: 10, instance: '+instance', part: '=SUM(1,2)' };
    expect((await exportNodalDisplacements(s.transport)).data).toContain('result-1,static,0,1,10,+instance,"=SUM(1,2)",');
  });

  it.each(['surface-id', 'field-id', 'surface-step', 'field-step'] as const)('refuses mismatched %s arrays', async (which) => {
    const s = setup();
    if (which === 'surface-id') s.surface.resultId = 'other';
    if (which === 'field-id') s.field.resultId = 'other';
    if (which === 'surface-step') s.surface.step = 'other';
    if (which === 'field-step') s.field.step = 'other';
    await expect(exportNodalDisplacements(s.transport)).rejects.toMatchObject({ code: 'export.unavailable', cause: expect.stringContaining('another Result') });
  });

  it.each(['position-unit', 'value-unit', 'per', 'components', 'nodes', 'entities', 'positions', 'values'] as const)('refuses invalid %s scientific layout', async (which) => {
    const s = setup();
    if (which === 'position-unit') s.surface.unit = 'mm';
    if (which === 'value-unit') s.field.unit = 'mm';
    if (which === 'per') s.field.per = 'element';
    if (which === 'components') s.field.components = 1;
    if (which === 'nodes') s.field.nodeCount = 1;
    if (which === 'entities') s.field.entityCount = 1;
    if (which === 'positions') s.surface.positions.pop();
    if (which === 'values') s.field.values.pop();
    await expect(exportNodalDisplacements(s.transport)).rejects.toMatchObject({ code: 'export.unavailable', cause: expect.stringContaining('three SI components') });
  });

  it.each(['positions', 'values'] as const)('rejects nonfinite %s rather than writing a false numeric answer', async (which) => {
    const s = setup();
    if (which === 'positions') s.surface.positions[0] = Infinity;
    else s.field.values[0] = NaN;
    await expect(exportNodalDisplacements(s.transport)).rejects.toMatchObject({ cause: expect.stringContaining('nonfinite') });
  });

  it.each(['missing', 'oversized', 'unknown-unused'] as const)('rejects %s source mapping', async (which) => {
    const s = setup();
    if (which === 'missing') delete s.surface.sourceLabels;
    if (which === 'oversized') s.surface.sourceLabels!.nodes = [1, 2, 3, 4];
    if (which === 'unknown-unused') s.surface.sourceLabels!.unusedNodes = [999];
    await expect(exportNodalDisplacements(s.transport)).rejects.toMatchObject({ code: 'export.unavailable' });
  });

  it('rejects unknown CSV tables with a structured schema error before queries or downloads', async () => {
    const { registry, transport, host } = setup();
    await expect(registry.dispatch({ cmd: 'file.export', spec: { format: 'csv', table: 'nodal' } })).rejects.toMatchObject({ code: 'schema', where: expect.stringMatching(/^spec/) });
    expect(transport.query).not.toHaveBeenCalled();
    expect(host.files.download).not.toHaveBeenCalled();
  });
});
