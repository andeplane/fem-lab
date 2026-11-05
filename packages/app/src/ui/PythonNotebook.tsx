import type { Store, UiState } from '../store';
import { Cmd, type Dispatch } from './cmd';
export function PythonNotebook({ s, store, dispatch }: { s: UiState; store: Store; dispatch: Dispatch }) {
  const code = s.pythonDraft ?? '# %%\nprint("Python is a client of the FEM Lab registry")\nprint(await fem.query_model())';
  const cells = code.split(/^# %%.*$/m).filter((cell, index) => index > 0 || cell.trim());
  const update = (index: number, value: string) => {
    const next = [...cells]; next[index] = value;
    store.set({ pythonDraft: next.map(cell => `# %%\n${cell}`).join('\n'), scriptEditing: true });
  };
  return <div class="python-notebook" style="overflow:auto;flex:1;padding:12px">
    <p>Python · numpy · matplotlib. Run all cells in order. Only engine Commands enter the Journal; source and plots stay in project files.</p>
    {cells.map((cell, index) => <label key={index} style="display:block">Cell {index + 1}
      <textarea aria-label={`Python cell ${index + 1}`} data-cmd="script.setSource" value={cell} rows={Math.max(4, cell.split('\n').length)} style="width:100%;font-family:monospace" onInput={event => update(index, event.currentTarget.value)} disabled={s.scriptRunning} />
    </label>)}
    <Cmd dispatch={dispatch} cmd="script.setSource" args={{ code: `${code}\n# %%\n` }} class="tbutton outline" disabled={s.scriptRunning}>Add cell</Cmd>
    {s.pythonPlots.map((plot, index) => <figure key={index}><img src={`data:image/png;base64,${plot}`} alt={`Python matplotlib output ${index + 1}`} style="max-width:100%" /><figcaption>Plot {index + 1}</figcaption></figure>)}
  </div>;
}
