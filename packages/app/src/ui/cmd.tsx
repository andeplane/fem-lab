// ADR 0003 as a component: everything a person can click is one Command, named in `data-cmd`
// so `test/data-cmd.test.tsx` and the Playwright smoke can hold the DOM against
// `registry.list()`. Nothing in `src/ui/*` renders a bare `<button>`.
import type { ComponentChildren } from 'preact';
import { useLayoutEffect, useReducer } from 'preact/hooks';
import type { Store, UiState } from '../store';

export type Dispatch = (cmd: { cmd: string } & Record<string, unknown>) => Promise<unknown>;

export function useStore(store: Store): UiState {
  const [, redraw] = useReducer((revision: number) => revision + 1, 0);
  const snapshot = store.state;
  useLayoutEffect(() => {
    const unsubscribe = store.subscribe(() => redraw(undefined));
    // Catch a publication between render and subscription. A different Store is read on
    // its very first render; no state value from the previous activation is retained.
    if (store.state !== snapshot) redraw(undefined);
    return unsubscribe;
  }, [store]);
  return snapshot;
}

export interface CmdProps {
  dispatch: Dispatch;
  cmd: string;
  args?: Record<string, unknown>;
  class?: string;
  title?: string;
  disabled?: boolean;
  pressed?: boolean;
  expanded?: boolean;
  controls?: string;
  label?: string;
  /** `role="tab"` with `selected`, for the bottom panel's strip; anything else is a button. */
  role?: 'tab';
  selected?: boolean;
  /** Runs instead of `dispatch` when the click needs a fallback (the `@` button's copy). */
  onRun?: () => void;
  onFocus?: () => void;
  onBlur?: () => void;
  /** A Command this control runs on the way to its own, for the tutorial to find it by. */
  opens?: string;
  children: ComponentChildren;
}

export function Cmd({ dispatch, cmd, args, children, onRun, onFocus, onBlur, ...rest }: CmdProps) {
  // A control that fills the Properties form with some *other* Command names it here, so the
  // tutorial spotlight can find "the + add material chip" from `highlight: "material.add"`
  // alone (issue #38). The form's own inputs carry a bare `data-cmd="form.open"` with no args,
  // so they never claim a Command they do not open.
  const opens = rest.opens ?? (cmd === 'form.open' && typeof args?.['command'] === 'string' ? (args['command'] as string) : undefined);
  return (
    <button
      type="button"
      data-cmd={cmd}
      {...(opens === undefined ? {} : { 'data-opens': opens })}
      class={rest.class}
      title={rest.title ?? cmd}
      disabled={rest.disabled ?? false}
      {...(rest.role === undefined ? {} : { role: rest.role })}
      {...(rest.selected === undefined ? {} : { 'aria-selected': rest.selected })}
      {...(rest.pressed === undefined ? {} : { 'aria-pressed': rest.pressed })}
      {...(rest.expanded === undefined ? {} : { 'aria-expanded': rest.expanded })}
      {...(rest.controls === undefined ? {} : { 'aria-controls': rest.controls })}
      {...(rest.label === undefined ? {} : { 'aria-label': rest.label })}
      onFocus={onFocus}
      onBlur={onBlur}
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
