import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { Dispatch } from './cmd';

/** Enter or blur commits one rename; Escape restores the current name without a Command. */
export function ModelName({ name, dirty, dispatch }: { name: string; dirty: boolean; dispatch: Dispatch }) {
  const [draft, setDraft] = useState(name);
  const editing = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    setDraft(name);
  }, [name]);
  const finish = (commit: boolean) => {
    if (!editing.current) return;
    editing.current = false;
    const next = draft.trim();
    setDraft(commit && next ? next : name);
    if (commit && next && next !== name) void dispatch({ cmd: 'model.setName', name: next }).catch(() => setDraft(name));
    input.current?.blur();
  };
  return (
    <div class="model-title">
      <input
        ref={input}
        class="mono model-name"
        aria-label="Model name"
        title={name}
        aria-description="Enter or blur to apply the Model name; Escape to cancel"
        data-cmd="model.setName"
        value={draft}
        size={Math.max(4, draft.length)}
        onFocus={() => {
          editing.current = true;
        }}
        onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
        onBlur={() => finish(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            finish(e.key === 'Enter');
          }
        }}
      />
      {dirty ? <span class="unsaved-dot" role="img" aria-label="Unsaved changes" title="Changes since the last explicit save or open" /> : null}
    </div>
  );
}
