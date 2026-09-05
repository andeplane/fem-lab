// ADR 0003 as a component: everything a person can click is one Command, named in `data-cmd`
// so `test/data-cmd.test.tsx` and the Playwright smoke can hold the DOM against
// `registry.list()`. Nothing in `src/ui/*` renders a bare `<button>`.
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { Store, UiState } from '../store';

export type Dispatch = (cmd: { cmd: string } & Record<string, unknown>) => Promise<unknown>;

export function useStore(store: Store): UiState {
  const [state, setState] = useState(store.state);
  useEffect(() => store.subscribe(() => setState(store.state)), [store]);
  return state;
}

export interface CmdProps {
  dispatch: Dispatch;
  cmd: string;
  args?: Record<string, unknown>;
  class?: string;
  title?: string;
  disabled?: boolean;
  pressed?: boolean;
  /** Runs instead of `dispatch` when the click needs a fallback (the `@` button's copy). */
  onRun?: () => void;
  children: ComponentChildren;
}

export function Cmd({ dispatch, cmd, args, children, onRun, ...rest }: CmdProps) {
  return (
    <button
      type="button"
      data-cmd={cmd}
      class={rest.class}
      title={rest.title ?? cmd}
      disabled={rest.disabled ?? false}
      {...(rest.pressed === undefined ? {} : { 'aria-pressed': rest.pressed })}
      onClick={(e) => {
        e.stopPropagation();
        if (onRun) return onRun();
        void dispatch({ cmd, ...(args ?? {}) }).catch(() => undefined);
      }}
    >
      {children}
    </button>
  );
}
