// Import drafts are registry Commands, just like Properties edits. Source units are required
// choices and are independent of the Model's display units.
import type { UiState } from '../store';
import { useRef } from 'preact/hooks';
import { Cmd, type Dispatch } from './cmd';
import { useDialogFocus } from './Dialog';

export function ImportAbaqus({ s, dispatch }: { s: UiState; dispatch: Dispatch }) {
  const open = s.panels['abaqus'] === true && s.form?.cmd === 'file.importAbaqus';
  const dialog = useRef<HTMLDivElement>(null);
  useDialogFocus(open, dialog);
  if (!open || !s.form) return null;
  const values = s.form.values;
  const source = 'text' in values ? 'text' : 'path' in values ? 'path' : 'picker';
  const draft = (patch: Record<string, unknown>) => void dispatch({ cmd: 'form.open', command: 'file.importAbaqus', args: { ...values, ...patch }, keepInitial: true }).catch(() => undefined);
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
      <input class="mono input" aria-label={label} data-cmd="form.open" value={String(values[key] ?? '')} placeholder={placeholder}
        onInput={e => draft({ [key]: (e.target as HTMLInputElement).value })} />
    </label>
  );
  return <div class="overlay wide" onClick={close}>
    <div ref={dialog} class="gallery" role="dialog" aria-modal="true" aria-label="Import Abaqus input deck" tabIndex={-1} onClick={e => e.stopPropagation()}>
      <div class="gallery-head">
        <span class="gallery-title">Import Abaqus .inp</span>
        <Cmd dispatch={dispatch} cmd="panel.toggle" class="tbutton" args={{ panel: 'abaqus', open: false }} title="Close Abaqus import">×</Cmd>
      </div>
      <div class="props-body">
        <p>Import a flat deck with one Body of C3D4 tetrahedra or full-integration C3D8 hexahedra and named Sets. Maximum input: 16 MiB.</p>
        <p>PART, ASSEMBLY, INSTANCE, transforms, INCLUDE, OUTPUT blocks, other element types, and binary .odb or .cae databases are unsupported.</p>
        {textField('name', 'Project name')}
        {textField('body', 'Body name')}
        <div class="field">
          <span class="field-label">Import mode — choose explicitly</span>
          <div class="segmented" role="group" aria-label="Abaqus import mode">
            {(['mesh', 'static'] as const).map(choice => <button type="button" data-cmd="form.open" aria-pressed={mode === choice} onClick={() => draft({ mode: choice })}>
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
