// CodeMirror is the Script tab's only heavy UI dependency. Bottom.tsx imports this component
// through `lazy()`, so none of the editor packages join the landing bundle.
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { HighlightStyle, bracketMatching, syntaxHighlighting } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from '@codemirror/view';
import { javascript } from '@codemirror/lang-javascript';
import { tags } from '@lezer/highlight';
import { useLayoutEffect, useRef } from 'preact/hooks';

const femLabHighlight = HighlightStyle.define([
  { tag: tags.comment, color: 'var(--text-faint)', fontStyle: 'italic' },
  { tag: [tags.keyword, tags.controlKeyword, tags.definitionKeyword, tags.moduleKeyword], color: 'var(--accent)' },
  { tag: [tags.string, tags.bool, tags.null], color: 'var(--green)' },
  { tag: [tags.number, tags.unit], color: 'var(--yellow)' },
  { tag: [tags.propertyName, tags.function(tags.variableName), tags.typeName], color: 'var(--cyan)' },
  { tag: [tags.definition(tags.variableName), tags.variableName], color: 'var(--text-body)' },
  { tag: [tags.punctuation, tags.operatorKeyword], color: 'var(--text-low)' },
  { tag: tags.invalid, color: 'var(--red-text)', textDecoration: 'underline' },
]);

export interface ScriptEditorProps {
  value: string;
  onChange(value: string): void;
}

export default function ScriptEditor({ value, onChange }: ScriptEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const change = useRef(onChange);
  change.current = onChange;

  useLayoutEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          history(),
          drawSelection(),
          bracketMatching(),
          highlightActiveLine(),
          javascript({ typescript: true }),
          syntaxHighlighting(femLabHighlight),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.contentAttributes.of({ 'data-cmd': 'script.setSource', 'aria-label': 'TypeScript editor', class: 'script-edit', spellcheck: 'false' }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) change.current(update.state.doc.toString());
          }),
        ],
      }),
    });
    editor.current = view;
    view.focus();
    return () => {
      editor.current = null;
      view.destroy();
    };
  }, []);

  useLayoutEffect(() => {
    const view = editor.current;
    if (!view || view.state.doc.toString() === value) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  }, [value]);

  return <div class="script-editor-host" ref={host} />;
}
