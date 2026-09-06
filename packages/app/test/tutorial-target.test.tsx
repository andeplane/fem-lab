// `src/tutorial/target.ts` against a fixture DOM: which control a Step points at, in what
// order, what the card lists, and where the card lands (issues #38, #46). Pure functions only —
// nothing here mounts the panel, which is `tutorial-panel.test.tsx`'s job.
import { afterEach, describe, expect, it } from 'vitest';
import { candidates, fieldsOf, formHintsOf, nameOf, place, prettyUnits, resolve } from '../src/tutorial/target';
import type { Step } from '../src/tutorial/types';

const step = (patch: Partial<Step> = {}): Step => ({ title: 't', explain: 'e', expect: { cmd: 'material.add' }, highlight: 'material.add', doIt: { cmd: 'material.add', name: 'steel', E: '210 GPa', nu: 0.3, rho: '7850 kg/m^3' }, ...patch });

/** The shell in miniature: a tree with an `+ add …` chip, a Properties panel with the same
 * Command on its Revert button, and the ⌘K field that is always there. */
function shell(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  document.body.append(root);
  return root;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('candidates', () => {
  it('offers the form fields first, but only when the form is open on the step\'s own Command', () => {
    expect(candidates(step(), { cmd: 'material.add' }).slice(0, 4)).toEqual(['.props [data-field="name"]', '.props [data-field="E"]', '.props [data-field="nu"]', '.props [data-field="rho"]']);
    // a form open on something else must not be pointed at
    expect(candidates(step(), { cmd: 'load.pressure' })[0]).toBe('[data-cmd="material.add"]');
    expect(candidates(step(), null)[0]).toBe('[data-cmd="material.add"]');
  });

  it('tries the Command that dispatches it, then the control that opens the form on it', () => {
    expect(candidates(step(), null)).toEqual(['[data-cmd="material.add"]', '[data-opens="material.add"]', '.palette-field']);
  });

  it('passes a raw CSS selector straight through, without wrapping it in data-cmd', () => {
    expect(candidates(step({ highlight: '[title="panel.toggle results"]' }), null)).toEqual(['[title="panel.toggle results"]', '.palette-field']);
  });

  it('falls back to the ⌘K field for a step that names no control at all', () => {
    expect(candidates(step({ highlight: undefined }), null)).toEqual(['.palette-field']);
  });
});

describe('resolve', () => {
  it('takes the first candidate that is on the page', () => {
    const root = shell('<button data-cmd="panel.toggle" class="palette-field">Search</button><button data-cmd="material.add">Add material</button>');
    expect(resolve(candidates(step(), null))!.textContent).toBe('Add material');
    root.remove();
  });

  it('finds the tree chip through data-opens when nothing dispatches the Command', () => {
    shell('<aside class="tree"><button data-cmd="form.open" data-opens="material.add" class="chip-add">+ add material</button></aside><button class="palette-field">Search</button>');
    expect(resolve(candidates(step(), null))!.textContent).toBe('+ add material');
  });

  // Plan E review, decision 2: SchemaForm's Revert is `form.open` with the step's own Command.
  it('never lands on the Properties panel\'s Revert button', () => {
    shell('<aside class="props"><button data-cmd="form.open" data-opens="material.add">Revert</button></aside><button class="palette-field">Search commands</button>');
    const hit = resolve(candidates(step(), null))!;
    expect(hit.textContent).toBe('Search commands');
  });

  it('does point into the Properties panel on rung 1, where that is the whole idea', () => {
    shell('<aside class="props"><div class="field" data-field="E"><input /></div></aside>');
    expect(resolve(candidates(step(), { cmd: 'material.add' }))!.getAttribute('data-field')).toBe('E');
  });

  it('treats a selector that does not parse as a miss, not a page error (issue #55)', () => {
    shell('<button class="palette-field">Search</button>');
    expect(resolve(['[unclosed="', '.palette-field'])!.className).toBe('palette-field');
  });

  it('returns null when nothing matches at all', () => {
    expect(resolve(['[data-cmd="nothing.here"]'])).toBeNull();
  });
});

describe('fieldsOf', () => {
  it('derives the values from doIt, through the symbols an engineer writes', () => {
    expect(fieldsOf(step())).toEqual([
      ['name', 'steel'],
      ['E', '210 GPa'],
      ['ν', '0.3'],
      ['ρ', '7850 kg/m³'],
    ]);
  });

  it('joins a list of quantities the way the size of a box reads', () => {
    expect(fieldsOf(step({ doIt: { cmd: 'geometry.addBox', name: 'beam', size: ['1 m', '100 mm', '100 mm'] } }))).toEqual([
      ['name', 'beam'],
      ['size', '1 m × 100 mm × 100 mm'],
    ]);
  });

  it('lets `fields` override a derived list that reads badly', () => {
    expect(fieldsOf(step({ fields: { 'the point': 'this one value' } }))).toEqual([['the point', 'this one value']]);
  });

  it('is empty for a read-only step, which has no Command to show', () => {
    expect(fieldsOf(step({ expect: null, doIt: undefined }))).toEqual([]);
  });
});

describe('formHintsOf', () => {
  it('keys every value by the data-field path SchemaForm renders', () => {
    expect(formHintsOf(step())).toEqual({ name: 'steel', E: '210 GPa', nu: '0.3', rho: '7850 kg/m³' });
  });

  it('paths a multi-part quantity by index, as the form does', () => {
    expect(formHintsOf(step({ doIt: { cmd: 'geometry.addBox', size: ['1 m', '100 mm', '100 mm'] } }))).toEqual({ 'size.0': '1 m', 'size.1': '100 mm', 'size.2': '100 mm' });
  });

  it('reaches into a nested object, as `mesher.size` is nested', () => {
    expect(formHintsOf(step({ doIt: { cmd: 'mesh.set', mesher: { kind: 'lattice', size: '25 mm' }, order: 1 } }))).toEqual({ 'mesher.kind': 'lattice', 'mesher.size': '25 mm', order: '1' });
  });
});

describe('prettyUnits', () => {
  it('writes exponents and degrees the way the design writes them', () => {
    expect(prettyUnits('7850 kg/m^3')).toBe('7850 kg/m³');
    expect(prettyUnits('1e-5 1/K')).toBe('1e-5 1/K');
    expect(prettyUnits('100 degC')).toBe('100 °C');
    expect(prettyUnits('5 W/(m^2 K)')).toBe('5 W/(m² K)');
  });
});

describe('place', () => {
  const card = { width: 320, height: 300 };
  const viewport = { width: 1600, height: 1000 };

  it('puts the card to the right of the target when there is room', () => {
    expect(place({ left: 100, top: 200, width: 180, height: 40 }, card, viewport)).toEqual({ left: 296, top: 200, side: 'right' });
  });

  it('flips to the left when the right would run off the viewport', () => {
    expect(place({ left: 1300, top: 120, width: 260, height: 40 }, card, viewport)).toEqual({ left: 964, top: 120, side: 'left' });
  });

  it('clamps into the viewport rather than drawing the card off the bottom', () => {
    const p = place({ left: 100, top: 960, width: 180, height: 40 }, card, viewport);
    expect(p.top).toBe(1000 - 300 - 8);
  });

  it('stays on the right when neither side fits, so it is at least beside the target', () => {
    const narrow = { width: 400, height: 600 };
    expect(place({ left: 60, top: 10, width: 300, height: 40 }, card, narrow).side).toBe('right');
  });
});

describe('nameOf', () => {
  it('reads the control\'s own visible text, collapsed', () => {
    const root = shell('<button>  + add \n material </button>');
    expect(nameOf(root.querySelector('button'))).toBe('+ add material');
  });

  it('declines a control with no text, or a whole paragraph of it', () => {
    const root = shell(`<button></button><div>${'x'.repeat(80)}</div>`);
    expect(nameOf(root.querySelector('button'))).toBeNull();
    expect(nameOf(root.querySelector('div'))).toBeNull();
    expect(nameOf(null)).toBeNull();
  });
});
