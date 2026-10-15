import { useRef } from 'preact/hooks';
import type { UiState } from '../store';
import { Cmd, type Dispatch } from './cmd';
import { useDialogFocus } from './Dialog';

export const STEP_IMPORT_DRAFT = { name: 'body', linearDeflection: '0.1 mm', angularDeflection: '15 deg' };
const text = (v: unknown): string => v && typeof v === 'object' && 'value' in v && 'unit' in v ? `${v.value} ${v.unit}` : String(v ?? '');
export function ImportStep({ s, dispatch }: { s: UiState; dispatch: Dispatch }) {
  const open = s.panels['step'] === true && s.form?.cmd === 'geometry.importStep';
  const dialog = useRef<HTMLDivElement>(null);
  useDialogFocus(open, dialog);
  if (!open || !s.form) return null;
  const values = s.form.values; const pending = s.stepImport;
  const close = () => void dispatch({ cmd: 'panel.toggle', panel: 'step', open: false }).catch(() => undefined);
  const field = (name: string, label: string) => <label class="field"><span class="field-label">{label}</span>
    <input class="mono input" aria-label={label} data-cmd="form.open" value={text(values[name])} disabled={Boolean(pending)}
      onInput={event => void dispatch({ cmd: 'form.open', command: 'geometry.importStep', args: { ...values, [name]: (event.target as HTMLInputElement).value }, keepInitial: true }).catch(() => undefined)} /></label>;
  return <div class="overlay wide" onClick={close}>
    <div ref={dialog} class="gallery" role="dialog" aria-modal="true" aria-label="Import STEP geometry" tabIndex={-1} onClick={e => e.stopPropagation()}>
      <div class="gallery-head"><span class="gallery-title">Import STEP geometry</span><Cmd dispatch={dispatch} cmd="panel.toggle" class="tbutton" args={{ panel: 'step', open: false }} title="Close STEP import">×</Cmd></div>
      <div class="props-body abaqus-import">
        <p>Add or re-import one Body from a .step or .stp file, up to 16 MiB. STEP’s declared length units are converted to meters; display units do not change source units.</p>
        {field('name', 'Body name')}
        {field('linearDeflection', 'Absolute linear deflection')}
        {field('angularDeflection', 'Angular deflection')}
        {'path' in values ? field('path', 'Path inside project folder') : null}
        <p>Linear deflection must be at least 0.0000001 m. Smaller deflections add curved-surface triangles; source tolerances can supersede the requested value. Angular deflection must be positive and at most 180 deg.</p>
        <p>Import retains tessellated surfaces for meshing. Exact B-rep, CAD history, original face identities and CAD materials are lost; multiple meshes become one Body. Name durable face targets with geometric predicates after import.</p>
        <p>Transfer warnings, incomplete faces, free wires or points, and external file references are unsupported. Even a potentially harmless transfer warning fails conservatively because it can indicate omitted geometry; repair or re-export the source.</p>
        <p>The converter downloads only when you import. <a href={`${import.meta.env.BASE_URL}third-party/step-converter/NOTICE.txt`} target="_blank" rel="noreferrer">Converter notices</a> · <a href={`${import.meta.env.BASE_URL}third-party/step-converter/corresponding-source.tar.gz`}>Complete source and rebuild kit</a></p>
        {pending ? <p role="status">{pending.name}: {pending.phase}. {pending.cancellable ? 'Cancel terminates the converter before publication.' : 'Publishing the checked geometry Command.'}</p> : null}
        {s.lastError ? <p class="surface error" role="alert">{s.lastError.code}: {s.lastError.cause}</p> : null}
        <Cmd dispatch={dispatch} cmd="geometry.importStep" class="apply" args={values} disabled={Boolean(pending) || !['name', 'linearDeflection', 'angularDeflection'].every(key => text(values[key]).trim())}>{'path' in values ? 'Import STEP' : 'Choose STEP file and import'}</Cmd>
        {pending ? <Cmd dispatch={dispatch} cmd="geometry.cancelStep" class="tbutton" args={{ name: pending.name }} disabled={!pending.cancellable}>Cancel STEP import</Cmd> : null}
        <p>Edits or project switches while conversion runs reject the pending import. Closing this dialog keeps conversion running; use Cancel to stop it.</p>
      </div>
    </div>
  </div>;
}

export function StepImportReport({ s, dispatch }: { s: UiState; dispatch: Dispatch }) {
  const open = s.panels['stepReport'] === true && s.stepReport !== null;
  const dialog = useRef<HTMLDivElement>(null); useDialogFocus(open, dialog);
  if (!open || !s.stepReport) return null;
  const r = s.stepReport;
  const close = () => void dispatch({ cmd: 'panel.toggle', panel: 'stepReport', open: false }).catch(() => undefined);
  return <div class="overlay wide" onClick={close}><div ref={dialog} class="gallery" role="dialog" aria-modal="true" aria-label="STEP import report" tabIndex={-1} onClick={e => e.stopPropagation()}>
    <div class="gallery-head"><span class="gallery-title">STEP conversion receipt: {r.name}</span><Cmd dispatch={dispatch} cmd="panel.toggle" class="tbutton" args={{ panel: 'stepReport', open: false }} title="Close STEP report">×</Cmd></div>
    <div class="props-body abaqus-import">
      <p>Last successful STEP conversion in this project. Later edits or Undo may change or remove this geometry.</p>
      <p>{r.sourceName} · {r.sourceBytes.toLocaleString()} source bytes. Converted {r.roots} transfer roots, {r.sourceRoots} source shapes, {r.faces} faces, {r.meshes} meshes and {r.triangles.toLocaleString()} triangles into one Body.</p>
      <p>Output: meters. Requested absolute deflection: {r.linearDeflection.value} {r.linearDeflection.unit}; angular deflection: {r.angularDeflection.value} {r.angularDeflection.unit}. Converter: {r.converter}.</p>
      <p>Exact B-rep, CAD history, original face identifiers and CAD materials are not retained. Use imported patch inspection and geometry.nameFace predicates for durable targets, then assign a Material and mesh the Body.</p>
      <p class="mono">Source SHA-256: {r.sourceSha256}<br />Geometry SHA-256: {r.geometrySha256}<br />Portable geometry: {r.geometryBytes.toLocaleString()} bytes.</p>
      <p>The converted geometry was recorded as one portable Command. Replay of that Command needs neither this file nor the converter.</p>
    </div>
  </div></div>;
}
