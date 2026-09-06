import { describe, expect, it, vi } from 'vitest';
import { Store, consoleReducer, initialState, panelsReducer, refsOf, selectionReducer, visibilityReducer } from '../src/store';

const sel = (bodies: string[] = [], faces: string[] = [], sets: string[] = []) => ({ bodies, faces, sets, refs: refsOf({ bodies, faces, sets }) });

describe('selectionReducer', () => {
  it('replaces by default and drops the categories the input omits', () => {
    const after = selectionReducer(sel(['a'], ['a.top']), { bodies: ['b'] });
    expect(after).toEqual(sel(['b']));
  });

  it('adds without duplicating and removes only what is named', () => {
    const added = selectionReducer(sel(['a']), { bodies: ['a', 'b'], mode: 'add' });
    expect(added.bodies).toEqual(['a', 'b']);
    expect(selectionReducer(added, { bodies: ['a'], mode: 'remove' }).bodies).toEqual(['b']);
  });

  it('leaves untouched categories alone in add and remove mode', () => {
    const after = selectionReducer(sel(['a'], ['a.top']), { bodies: ['b'], mode: 'add' });
    expect(after.faces).toEqual(['a.top']);
  });

  it('expands refs the way @selection does', () => {
    expect(selectionReducer(sel(), { bodies: ['beam'], faces: ['beam.top'], sets: ['s'] }).refs).toEqual(['body:beam', 'face:beam.top', 'set:s']);
  });
});

describe('consoleReducer', () => {
  it('appends and caps the buffer', () => {
    let lines = [] as ReturnType<typeof consoleReducer>;
    for (let i = 0; i < 600; i++) lines = consoleReducer(lines, { level: 'engine', text: `line ${i}`, at: i });
    expect(lines).toHaveLength(500);
    expect(lines[0]!.text).toBe('line 100');
    expect(lines.at(-1)!.text).toBe('line 599');
  });
});

describe('panelsReducer', () => {
  it('flips when `open` is omitted and obeys it when given', () => {
    expect(panelsReducer({}, 'examples')['examples']).toBe(true);
    expect(panelsReducer({ examples: true }, 'examples')['examples']).toBe(false);
    expect(panelsReducer({ examples: true }, 'examples', true)['examples']).toBe(true);
  });
});

describe('visibilityReducer', () => {
  it('hides without duplicates and shows only the named bodies', () => {
    expect(visibilityReducer(['column'], ['beam', 'beam'], false)).toEqual(['column', 'beam']);
    expect(visibilityReducer(['column', 'beam'], ['beam'], true)).toEqual(['column']);
  });
});

describe('Store', () => {
  it('notifies subscribers and stops after unsubscribe', () => {
    const store = new Store();
    const seen = vi.fn();
    const off = store.subscribe(seen);
    store.set({ ready: true });
    expect(store.state.ready).toBe(true);
    off();
    store.set({ ready: false });
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('routes the bottom tabs through panel.toggle', () => {
    const store = new Store();
    store.togglePanel('console');
    expect(store.state.tab).toBe('console');
    expect(store.state.panels['console']).toBeUndefined();
  });

  it('turns any thrown thing into a structured error and a console line', () => {
    const store = new Store();
    store.fail({ code: 'not-found', cause: "no body 'x'", where: 'x', suggestion: 'geometry.addBox' });
    expect(store.state.lastError).toEqual({ code: 'not-found', cause: "no body 'x'", where: 'x', suggestion: 'geometry.addBox' });
    store.fail(new Error('boom'));
    expect(store.state.lastError).toEqual({ code: 'internal', cause: 'boom', where: null, suggestion: null });
    expect(store.state.console.map((l) => l.level)).toEqual(['error', 'error']);
  });

  it('starts with nothing selected and no model', () => {
    expect(initialState.selection.refs).toEqual([]);
    expect(initialState.model).toBeNull();
  });
});
