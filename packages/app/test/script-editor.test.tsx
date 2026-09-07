import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import ScriptEditor from '../src/ui/ScriptEditor';

afterEach(async () => {
  await act(async () => {
    for (const root of [...document.body.children]) render(null, root);
  });
  document.body.replaceChildren();
});

describe('ScriptEditor', () => {
  it('sets up CodeMirror, reports document changes, syncs controlled values, and cleans up', async () => {
    const onChange = vi.fn();
    const root = document.createElement('div');
    document.body.append(root);

    await act(async () => render(<ScriptEditor value="const answer = 1;" onChange={onChange} />, root));

    const content = root.querySelector<HTMLElement>('.cm-content');
    expect(content).not.toBeNull();
    const view = EditorView.findFromDOM(content!);
    expect(view).not.toBeNull();
    expect(content!.getAttribute('contenteditable')).toBe('true');
    expect(content!.getAttribute('data-cmd')).toBe('script.setSource');
    expect(content!.getAttribute('aria-label')).toBe('TypeScript editor');
    expect(content!.classList.contains('script-edit')).toBe(true);
    expect(content!.getAttribute('spellcheck')).toBe('false');
    expect(root.querySelector('.cm-lineNumbers')).not.toBeNull();
    expect(view!.state.doc.toString()).toBe('const answer = 1;');

    view!.dispatch({ selection: { anchor: 0 } });
    expect(onChange).not.toHaveBeenCalled();
    view!.dispatch({ changes: { from: 0, to: view!.state.doc.length, insert: 'const answer = 2;' } });
    expect(onChange).toHaveBeenCalledWith('const answer = 2;');

    view!.dispatch({ selection: { anchor: 5 } });
    const replacement = vi.fn();
    await act(async () => render(<ScriptEditor value="const answer = 2;" onChange={replacement} />, root));
    expect(view!.state.selection.main.anchor).toBe(5);
    view!.dispatch({ changes: { from: 0, to: view!.state.doc.length, insert: 'latest callback' } });
    expect(replacement).toHaveBeenCalledWith('latest callback');
    expect(onChange).toHaveBeenCalledTimes(1);

    await act(async () => render(<ScriptEditor value="externally supplied" onChange={replacement} />, root));
    expect(view!.state.doc.toString()).toBe('externally supplied');

    const destroy = vi.spyOn(view!, 'destroy');
    await act(async () => render(null, root));
    expect(destroy).toHaveBeenCalledOnce();
    expect(root.querySelector('.cm-content')).toBeNull();
  });
});
