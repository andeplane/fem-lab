import type { ModelDocument, ResultField, ResultSummary, ResultSurface, RetainedResults } from './generated/engine';
import type { EngineTransport } from './transport';
import { FemError } from './error';
import { csvRow } from './csv';

function unavailable(cause: string): FemError {
  return new FemError('export.unavailable', cause, 'file.export.spec', 'solve the current Model and export its nodal displacements again');
}

/** Current solved source and scientific arrays are joined by immutable solve identity and
 * exact Model hash. Historical results cannot borrow identity from a later imported source. */
export async function exportNodalDisplacements(transport: EngineTransport, step?: string, resultId?: string): Promise<{ filename: string; data: string }> {
  const selector = { ...(step === undefined ? {} : { step }), ...(resultId === undefined ? {} : { resultId }) };
  const result = await transport.query({ query: 'query.result', ...selector }) as ResultSummary;
  if (result.stale) throw unavailable('nodal CSV requires the current solved Model; this Result is stale');
  const [document, catalogue] = await Promise.all([
    transport.query({ query: 'query.document' }) as Promise<ModelDocument>,
    transport.query({ query: 'query.results' }) as Promise<RetainedResults>,
  ]);
  const record = catalogue.records.find((entry) => entry.id === result.resultId);
  if (!record || record.stale || record.modelHash !== document.hash) throw unavailable('the solved Result and current source Model do not match');
  const pinned = { resultId: result.resultId };
  const [surface, field] = await Promise.all([
    transport.query({ query: 'query.surface', ...pinned }) as Promise<ResultSurface>,
    transport.query({ query: 'query.field', field: 'displacement', ...pinned }) as Promise<ResultField>,
  ]);
  if (surface.resultId !== result.resultId || field.resultId !== result.resultId || surface.step !== result.step || field.step !== result.step) {
    throw unavailable('scientific data belongs to another Result or Step');
  }
  if (surface.unit !== 'm' || field.unit !== 'm' || field.per !== 'node' || field.components !== 3 || field.nodeCount !== surface.nodeCount || field.entityCount !== surface.nodeCount || surface.positions.length !== 3 * surface.nodeCount || field.values.length !== 3 * surface.nodeCount) {
    throw unavailable('nodal displacements require three SI components for every solved Mesh node');
  }
  if (!surface.positions.every(Number.isFinite) || !field.values.every(Number.isFinite)) throw unavailable('nodal CSV cannot contain nonfinite scientific values');
  const mesher = document.file.model.mesh?.mesher;
  const source = mesher?.kind === 'imported' ? mesher : null;
  const labels = surface.sourceLabels;
  if (source && (!labels || labels.nodes.length > surface.nodeCount)) throw unavailable('the solved source-node mapping is unavailable');
  const rows = [csvRow(['resultId', 'step', 'nodeIndex', 'normalizedLabel', 'sourceLabel', 'instance', 'part', 'x_m', 'y_m', 'z_m', 'ux_m', 'uy_m', 'uz_m', 'status'])];
  const identity = (label: number | undefined): (string | number)[] => {
    if (label === undefined) return ['', '', '', ''];
    const original = source?.provenance?.nodeIdentities?.[String(label)];
    return [label, original?.sourceLabel ?? label, original?.instance ?? '', original?.part ?? ''];
  };
  for (let node = 0; node < surface.nodeCount; node += 1) {
    rows.push(csvRow([result.resultId, result.step, node, ...identity(labels?.nodes[node]), ...surface.positions.slice(3 * node, 3 * node + 3), ...field.values.slice(3 * node, 3 * node + 3), 'computed']));
  }
  if (source && labels) {
    const nodes = new Map(source.nodes.map((node) => [node.label, node.at]));
    for (const label of labels.unusedNodes ?? []) {
      const at = nodes.get(label);
      if (!at) throw unavailable('an unused authored node is absent from the matching source Model');
      rows.push(csvRow([result.resultId, result.step, '', ...identity(label), ...at, '', '', '', 'unused']));
    }
  }
  // Scientific reads intentionally support retained results after edits. Recheck their
  // current status and source hash after preparing the file, before host delivery.
  const [currentDocument, currentCatalogue] = await Promise.all([
    transport.query({ query: 'query.document' }) as Promise<ModelDocument>,
    transport.query({ query: 'query.results' }) as Promise<RetainedResults>,
  ]);
  const currentRecord = currentCatalogue.records.find((entry) => entry.id === result.resultId);
  if (currentDocument.hash !== document.hash || !currentRecord || currentRecord.stale || currentRecord.modelHash !== document.hash) {
    throw unavailable('the Model or solved Result changed while preparing nodal CSV');
  }
  return { filename: `${document.file.model.name}-nodal-displacements.csv`, data: `${rows.join('\n')}\n` };
}
