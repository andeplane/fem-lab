// Import drafts are registry Commands, just like Properties edits. Source units are required
// choices and are independent of the Model's display units.
import type { UiState } from '../store';
import { useRef } from 'preact/hooks';
import { Cmd, type Dispatch } from './cmd';
import { useDialogFocus } from './Dialog';
import type { Quantity } from '@femlab/registry';

const quantityText = (value: Quantity) => typeof value === 'string' ? value : `${value.value} ${value.unit}`;
const draftText = (value: unknown): string => value && typeof value === 'object' && 'value' in value && 'unit' in value
  ? `${value.value} ${value.unit}` : String(value ?? '');

export function ImportAbaqus({ s, dispatch }: { s: UiState; dispatch: Dispatch }) {
  const open = s.panels['abaqus'] === true && s.form?.cmd === 'file.importAbaqus';
  const dialog = useRef<HTMLDivElement>(null);
  useDialogFocus(open, dialog);
  if (!open || !s.form) return null;
  const values = s.form.values;
  const source = 'text' in values ? 'text' : 'path' in values ? 'path' : 'picker';
  const draft = (patch: Record<string, unknown>) => void dispatch({ cmd: 'form.open', command: 'file.importAbaqus', args: { ...values, ...patch }, keepInitial: true }).catch(() => undefined);
  const chooseMode = (next: 'mesh' | 'static') => {
    const { unitForce: _force, ...mesh } = values;
    void dispatch({ cmd: 'form.open', command: 'file.importAbaqus', args: { ...(next === 'mesh' ? mesh : values), mode: next }, keepInitial: true }).catch(() => undefined);
  };
  const chooseSource = (next: string) => {
    const { text: _text, path: _path, picker: _picker, ...rest } = values;
    void dispatch({ cmd: 'form.open', command: 'file.importAbaqus', args: { ...rest, ...(next === 'text' ? { text: '' } : { picker: true }) }, keepInitial: true }).catch(() => undefined);
  };
  const close = () => void dispatch({ cmd: 'panel.toggle', panel: 'abaqus', open: false }).catch(() => undefined);
  const mode = values['mode'];
  const incomplete = !String(values['name'] ?? '').trim() || !String(values['body'] ?? '').trim()
    || (mode !== 'mesh' && mode !== 'static') || !String(values['unitLength'] ?? '').trim()
    || (mode === 'static' && !String(values['unitForce'] ?? '').trim())
    || (source === 'text' && !String(values['text']).trim());
  const textField = (key: string, label: string, placeholder?: string) => (
    <label class="field">
      <span class="field-label">{label}</span>
      <input class="mono input" aria-label={label} data-cmd="form.open" value={draftText(values[key])} placeholder={placeholder}
        onInput={e => draft({ [key]: (e.target as HTMLInputElement).value })} />
    </label>
  );
  return <div class="overlay wide" onClick={close}>
    <div ref={dialog} class="gallery" role="dialog" aria-modal="true" aria-label="Import Abaqus input deck" tabIndex={-1} onClick={e => e.stopPropagation()}>
      <div class="gallery-head">
        <span class="gallery-title">Import Abaqus .inp</span>
        <Cmd dispatch={dispatch} cmd="panel.toggle" class="tbutton" args={{ panel: 'abaqus', open: false }} title="Close Abaqus import">×</Cmd>
      </div>
      <div class="props-body abaqus-import">
        <p>Import a flat deck with one Body of C3D4 tetrahedra or full-integration C3D8 hexahedra and named Sets. Maximum input: 16 MiB.</p>
        <p>PART, ASSEMBLY, INSTANCE, transforms, INCLUDE, OUTPUT blocks, other element types, and binary .odb or .cae databases are unsupported.</p>
        {textField('name', 'Project name')}
        {textField('body', 'Body name')}
        <div class="field">
          <span class="field-label">Import mode — choose explicitly</span>
          <div class="segmented" role="group" aria-label="Abaqus import mode">
            {(['mesh', 'static'] as const).map(choice => <button type="button" data-cmd="form.open" aria-pressed={mode === choice} onClick={() => chooseMode(choice)}>
              {choice === 'mesh' ? 'Mesh and Sets' : 'Linear static analysis'}
            </button>)}
          </div>
          {mode === 'mesh' ? <p>Mesh mode accepts nodes, elements and Sets. Decks containing physics require static mode.</p> : mode === 'static' ? <p>Static mode accepts one homogeneous isotropic elastic Material, displacement constraints, one STATIC Step and CLOAD nodal forces. Import creates the final equilibrium model; Abaqus increment history is not reproduced. Unsupported static content fails the import.</p> : null}
        </div>
        {textField('unitLength', 'One source length unit', 'Choose a positive Quantity, e.g. 1 mm or 1 m')}
        {mode === 'static' ? textField('unitForce', 'One source force unit', 'Choose a positive Quantity, e.g. 1 N or 1 kN') : null}
        <p>These source units convert the deck to SI. The toolbar’s display units do not select import units.</p>
        <div class="segmented" role="group" aria-label="Abaqus input source">
          <button type="button" data-cmd="form.open" aria-pressed={source === 'picker'} onClick={() => chooseSource('picker')}>Choose .inp file</button>
          <button type="button" data-cmd="form.open" aria-pressed={source === 'text'} onClick={() => chooseSource('text')}>Paste inline deck</button>
        </div>
        {source === 'text' ? <label class="field">
          <span class="field-label">Abaqus input text</span>
          <textarea class="mono input json" aria-label="Abaqus input text" data-cmd="form.open" value={String(values['text'])}
            onInput={e => draft({ text: (e.target as HTMLTextAreaElement).value })} />
        </label> : source === 'path' ? textField('path', 'Path inside project folder') : null}
        {s.lastError ? <p class="surface error" role="alert">{s.lastError.code}: {s.lastError.cause}</p> : null}
        <p>Import creates a new project after validation. The current project is saved before replacement; cancelling the file picker keeps it open.</p>
        <Cmd dispatch={dispatch} cmd="file.importAbaqus" class="apply" args={values} disabled={incomplete}>
          {source === 'picker' ? 'Choose .inp and import' : 'Import deck'}
        </Cmd>
      </div>
    </div>
  </div>;
}

/** Exact converter receipt, published with its project. Ordinary Model files retain source provenance. */
export function AbaqusImportReport({ s, dispatch }: { s: UiState; dispatch: Dispatch }) {
  const open = s.panels['abaqusReport'] === true && s.abaqusReport !== null;
  const dialog = useRef<HTMLDivElement>(null);
  useDialogFocus(open, dialog);
  if (!open || !s.abaqusReport) return null;
  const report = s.abaqusReport;
  const unused = report.sourceLabels.unusedNodes ?? [];
  const close = () => void dispatch({ cmd: 'panel.toggle', panel: 'abaqusReport', open: false }).catch(() => undefined);
  return <div class="overlay wide" onClick={close}>
    <div ref={dialog} class="gallery" role="dialog" aria-modal="true" aria-label="Abaqus import report" tabIndex={-1} onClick={e => e.stopPropagation()}>
      <div class="gallery-head">
        <span class="gallery-title">Abaqus import complete</span>
        <Cmd dispatch={dispatch} cmd="panel.toggle" class="tbutton" args={{ panel: 'abaqusReport', open: false }} title="Close Abaqus import report">×</Cmd>
      </div>
      <div class="props-body abaqus-import">
        <p>Body <b class="mono">{report.body}</b> · {report.elementKind} · {report.mode === 'static' ? 'Linear static analysis configured; not solved' : 'Mesh and Sets imported'}</p>
        <table class="mono"><tbody>
          <tr><th>Source nodes</th><td>{report.sourceNodes}</td><th>Active nodes</th><td>{report.activeNodes}</td></tr>
          <tr><th>Source elements</th><td>{report.sourceElements}</td><th>Input bytes</th><td>{report.inputBytes}</td></tr>
          <tr><th>One source length unit</th><td>{quantityText(report.unitLength)}</td><th>One source force unit</th><td>{report.unitForce == null ? 'Not used' : quantityText(report.unitForce)}</td></tr>
        </tbody></table>
        <p>SI bounds of active nodes at import:</p>
        <table class="mono"><thead><tr><th>Axis</th><th>Minimum</th><th>Maximum</th></tr></thead><tbody>
          {['x', 'y', 'z'].map((axis, i) => <tr key={axis}><th>{axis}</th><td>{quantityText(report.bbox[i]!)}</td><td>{quantityText(report.bbox[i + 3]!)}</td></tr>)}
        </tbody></table>
        {report.analysis ? <>
          <p>Material <b class="mono">{report.analysis.material}</b> · Section Set <b class="mono">{report.analysis.sectionElset}</b> · Step <b class="mono">{report.analysis.step}</b></p>
          <p>Constraints: <span class="mono">{report.analysis.constraints.join(', ')}</span>. Loads: <span class="mono">{report.analysis.loads.join(', ')}</span>.</p>
          {report.analysis.finalEquilibriumOnly ? <p>The imported Step represents final equilibrium. Abaqus increment history is not reproduced. Use Solve to compute its Result.</p> : null}
        </> : null}
        <p>Named Set mappings:</p>
        <table class="mono"><thead><tr><th>Kind</th><th>Source name</th><th>Imported name</th><th>Members</th></tr></thead><tbody>
          {report.sets.map(set => <tr key={`${set.kind}:${set.source}`}><td>{set.kind}</td><td>{set.source}</td><td>{set.target}</td><td>{set.count}</td></tr>)}
        </tbody></table>
        {unused.length ? <p>Unused authored node labels: <span class="mono">{unused.join(', ')}</span>. These nodes are physically unanalysed and excluded from active mesh bounds.</p> : <p>All authored nodes participate in the active mesh.</p>}
        {report.headings.length ? <p>Source heading: {report.headings.join(' · ')}</p> : null}
        {report.preprint.length ? <p>Authored PREPRINT flags: <span class="mono">{report.preprint.map(flags => Object.entries(flags).map(([name, value]) => `${name}=${value ? 'YES' : 'NO'}`).join(', ')).join(' · ')}</span></p> : null}
        <p class="mono">Source SHA-256: {report.sha256}<br />Conversion: {report.conversionVersion}</p>
        <p>This receipt describes the original import. Its measurements stay fixed when the Model is edited. Save this project as a normal Model file to reopen it without the original .inp; saved files retain the imported source and Journal.</p>
      </div>
    </div>
  </div>;
}
