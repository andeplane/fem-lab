// The Export modal of docs/design/README.md: `query.exportFormats` as three groups of rows,
// each showing the extension, the name, the note and the Command that writes it. Ticking rows
// and pressing "Export selected" dispatches one `file.export` per ticked row — no batching
// Command, because each file is its own artefact and its own Journal line.
import { EXPORT_FORMATS, type ExportFormatRow } from '@femlab/registry';
import { useState } from 'preact/hooks';
import type { UiState } from '../store';
import { Cmd, type Dispatch } from './cmd';

const GROUPS: ExportFormatRow['group'][] = ['Model & mesh', 'Results', 'Document & model file'];

/** Why a row cannot be exported yet, or `null` when it can. */
export function unavailable(row: ExportFormatRow, s: { hasMesh: boolean; hasResult: boolean }): string | null {
  if (row.needs === 'soon') return 'not written yet';
  if (row.needs === 'mesh' && !s.hasMesh) return 'needs a Mesh (mesh.set)';
  if (row.needs === 'result' && !s.hasResult) return 'needs a solved Step';
  return null;
}

/** The `file.export` spec a row runs; CSV defaults to the extremes table. */
export function specOf(row: ExportFormatRow, step: string | undefined): Record<string, unknown> {
  if (row.format === 'csv') return { format: 'csv', table: 'extremes', ...(step ? { step } : {}) };
  if (row.format === 'vtu' && step) return { format: 'vtu', step };
  return { format: row.format };
}

const line = (spec: Record<string, unknown>): string => `await fem.file.export({ spec: ${JSON.stringify(spec)} });`;

export function ExportModal({ s, dispatch }: { s: UiState; dispatch: Dispatch }) {
  const [ticked, setTicked] = useState<string[]>([]);
  if (s.panels['export'] !== true) return null;
  const ctx = { hasMesh: Boolean(s.model?.meshSettings), hasResult: s.result !== null };
  const step = s.result?.step;
  const close = { cmd: 'panel.toggle', panel: 'export', open: false };
  const runAll = (): void => {
    for (const format of ticked) {
      const row = EXPORT_FORMATS.find((r) => r.format === format);
      if (row) void dispatch({ cmd: 'file.export', spec: specOf(row, step) }).catch(() => undefined);
    }
  };
  return (
    <div class="overlay wide" onClick={() => void dispatch(close)}>
      <div class="export-modal" onClick={(e) => e.stopPropagation()}>
        <div class="gallery-head">
          <span class="gallery-title">Export</span>
          <span class="gallery-sub">Every row is one Command, so anything here is also scriptable and callable by the Assistant.</span>
          <Cmd dispatch={dispatch} cmd="panel.toggle" class="tbutton" args={{ panel: 'export', open: false }}>
            ×
          </Cmd>
        </div>
        {GROUPS.map((group) => (
          <div key={group} class="export-group">
            <div class="section-label">{group}</div>
            {EXPORT_FORMATS.filter((r) => r.group === group).map((row) => {
              const why = unavailable(row, ctx);
              const spec = specOf(row, step);
              return (
                <div key={row.format} class={why ? 'export-row off' : 'export-row'}>
                  <input
                    type="checkbox"
                    aria-label={`export ${row.name}`}
                    disabled={why !== null}
                    checked={ticked.includes(row.format)}
                    onChange={(e) => setTicked((t) => ((e.target as HTMLInputElement).checked ? [...t, row.format] : t.filter((x) => x !== row.format)))}
                  />
                  <span class="mono ext">.{row.ext}</span>
                  <span class="export-name">{row.name}</span>
                  <span class="export-note">{why ?? row.note}</span>
                  <span class="mono export-cmd">{line(spec)}</span>
                  <Cmd dispatch={dispatch} cmd="file.export" class="chip-add" args={{ spec }} disabled={why !== null} title={line(spec)}>
                    export
                  </Cmd>
                </div>
              );
            })}
          </div>
        ))}
        <div class="export-foot">
          <Cmd dispatch={dispatch} cmd="file.export" class="apply" disabled={ticked.length === 0} onRun={runAll} title="one file.export per ticked row">
            Export selected
          </Cmd>
        </div>
      </div>
    </div>
  );
}
