import { describe, expect, it, vi } from 'vitest';
import type { ModelSummary } from '@femlab/registry';
import { DEFAULT_PANEL_SIZES, Store, clampPanelSize, consoleReducer, initialState, panelsReducer, refsOf, selectionReducer, visibilityReducer } from '../src/store';
import { journalTarget } from '../src/ui/Bottom';

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
  it('round-trips quoted selection names to readable renderer names and canonical mention targets', () => {
    const names = { bodies: ['beam"quoted'], faces: ['beam"quoted.top'], sets: ['odd,set'] };
    const refs = refsOf(names);
    expect(refs).toEqual(['body:"beam\\"quoted"', 'face:"beam\\"quoted.top"', 'set:"odd,set"']);
    expect(selectionReducer(sel(), { refs })).toEqual({ ...names, refs });
    expect(selectionReducer(sel(), { refs: ['body:"beam"', 'body:beam'] }).refs).toEqual(['body:beam']);
    const target = journalTarget({ cmd: 'geometry.addBox', name: 'beam"quoted' }, { bodies: [{ name: 'beam"quoted' }] } as ModelSummary, [{ kind: 'body', name: 'beam"quoted', ref: 'body:beam"quoted', summary: '' }]);
    expect(target).toEqual({ ref: refs[0], highlight: { bodies: ['beam"quoted'] } });
  });

  it('keeps semantic object refs separate from drawable selection names', () => {
    expect(selectionReducer(sel(), { refs: ['material:steel', 'constraint:fix'] })).toEqual({ bodies: [], faces: [], sets: [], refs: ['material:steel', 'constraint:fix'] });
    expect(selectionReducer({ bodies: [], faces: [], sets: [], refs: ['material:steel'] }, { bodies: ['beam'], mode: 'add' }).refs).toEqual(['material:steel', 'body:beam']);
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

  it('keeps one tree menu open and gives tree groups a real open default', () => {
    const a = panelsReducer(initialState.panels, 'tree.menu.body:a', true);
    const b = panelsReducer(a, 'tree.menu.body:b', true);
    expect(b['tree.menu.body:a']).toBe(false);
    expect(b['tree.menu.body:b']).toBe(true);
    expect(panelsReducer(initialState.panels, 'tree.geometry')['tree.geometry']).toBe(false);
  });

  it('switches between the workflow guide and tutorial without two competing runners', () => {
    const tour = panelsReducer({ tutorial: true, assistant: true }, 'tour', true);
    expect(tour).toEqual({ tutorial: false, tour: true, assistant: true });
    const tutorial = panelsReducer(tour, 'tutorial');
    expect(tutorial).toEqual({ tutorial: true, tour: false, assistant: true });
    expect(panelsReducer(tutorial, 'tutorial', false)).toEqual({ tutorial: false, tour: false, assistant: true });
    expect(panelsReducer({ profile: true, tutorial: false }, 'tutorial', true)).toEqual({ profile: false, tutorial: true });
    expect(panelsReducer({ tour: true }, 'profile', true)['tour']).toBe(false);
  });
});

describe('visibilityReducer', () => {
  it('hides without duplicates and shows only the named bodies', () => {
    expect(visibilityReducer(['column'], ['beam', 'beam'], false)).toEqual(['column', 'beam']);
    expect(visibilityReducer(['column', 'beam'], ['beam'], true)).toEqual(['column']);
  });
});

describe('panel sizing', () => {
  it('starts with the designed dimensions and clamps host or gesture values', () => {
    expect(initialState.panelSizes).toEqual(DEFAULT_PANEL_SIZES);
    expect(clampPanelSize('tree', 1)).toBe(180);
    expect(clampPanelSize('properties', 999)).toBe(440);
    expect(clampPanelSize('bottom', 184.4)).toBe(184);
  });

  it('keeps layout state in the Store without touching model state', () => {
    const store = new Store();
    const model = store.state.model;
    store.resizePanel('properties', 372);
    expect(store.state.panelSizes.properties).toBe(372);
    expect(store.state.model).toBe(model);
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
