// ADR 0003 for the drawer: every clickable in it names a Command the registry has. Plus the pieces
// the design's cards are made of — the verification block the model writes, the mention popover,
// the skill toggles and the settings row.
import { HOST_COMMANDS, Registry, type EngineSchema } from '@femlab/registry';
import { render } from 'preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as anthropic from '../src/ai/anthropic';
import schema from '../../registry/src/generated/engine.schema.json';
import { fakeHost, fakeTransport } from '../../registry/test/fakes';
import { AssistantPanel, chatBridge } from '../src/ai/AssistantPanel';
import { parseVerification } from '../src/ai/context';
import { Store } from '../src/store';

async function mount(patch: Partial<Store['state']> = {}) {
  const transport = fakeTransport();
  transport.query = (async (q: { query: string }) => (q.query === 'query.objects' ? { objects: [{ ref: 'body:beam', kind: 'body', name: 'beam', summary: 'a box' }] } : {})) as never;
  const registry = new Registry({ schema: schema as unknown as EngineSchema, host: fakeHost(transport), hostCommands: HOST_COMMANDS });
  const store = new Store();
  store.set({ ready: true, ...patch });
  const root = document.createElement('div');
  document.body.append(root);
  render(<AssistantPanel registry={registry} store={store} />, root);
  await paint(); // Preact runs effects after the first paint; the chat bridge is wired in one.
  return { root, registry, store };
}

const cmds = (root: HTMLElement) => [...root.querySelectorAll('[data-cmd]')].map((el) => el.getAttribute('data-cmd')!);

/** Preact batches state into a microtask; let it, and let any pending query settle. */
const tick = () => new Promise((r) => setTimeout(r, 0));
/** Effects run after a paint, which happy-dom schedules on requestAnimationFrame. */
const paint = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

async function type(root: HTMLElement, text: string) {
  const box = root.querySelector('textarea')!;
  // A person focuses the box before typing in it, and that is what loads the mention index.
  box.dispatchEvent(new Event('focus', { bubbles: true }));
  await tick();
  box.value = text;
  box.dispatchEvent(new Event('input', { bubbles: true }));
  await tick();
  return box;
}

/** One key in the composer, the way the picker's arrows and ↵ arrive. */
function press(box: HTMLTextAreaElement, key: string): void {
  box.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

describe('the assistant drawer', () => {
  beforeEach(() => {
    // Unmount, not just detach: a live panel keeps re-running the effect that owns `chatBridge`.
    for (const root of [...document.body.children]) render(null, root as HTMLElement);
    document.body.innerHTML = '';
    chatBridge.pending = null;
    localStorage.clear();
  });

  it('names only Commands the registry has on every clickable', async () => {
    const { root, registry } = await mount({ panels: { 'assistant.settings': true, 'assistant.mentions': true } });
    const { commands, queries } = registry.list();
    const known = new Set([...commands, ...queries].map((d) => d.name));
    const used = cmds(root);
    expect(used.length).toBeGreaterThan(8);
    expect([...new Set(used)].filter((c) => !known.has(c))).toEqual([]);
  });

  it('puts a data-cmd on every button, so nothing in the drawer does something the registry cannot', async () => {
    const { root } = await mount({ panels: { 'assistant.settings': true } });
    expect([...root.querySelectorAll('button')].filter((b) => !b.hasAttribute('data-cmd')).map((b) => b.textContent)).toEqual([]);
  });

  it('offers to open a project folder until one is open, and lists the built-in skills as toggles', async () => {
    const { root } = await mount();
    expect(root.textContent).toContain('open a project folder');
    const chips = [...root.querySelectorAll('.chips button')].map((b) => b.textContent);
    expect(chips).toContain('beam-theory-check');
    expect(chips).toContain('write-report');
    expect([...root.querySelectorAll('.chips button')].every((b) => b.getAttribute('aria-pressed') === 'true')).toBe(true);
  });

  it('switches a skill off through panel.toggle, so the toggle is a Command like everything else', async () => {
    const { root, store } = await mount();
    const chip = [...root.querySelectorAll<HTMLButtonElement>('.chips button')].find((b) => b.textContent?.includes('convergence-study'))!;
    chip.click();
    expect(store.state.panels['skill:convergence-study']).toBe(false);
  });

  it('refuses to send without a key and points at the settings, rather than failing silently', async () => {
    const { root, store } = await mount();
    await type(root, 'build a beam');
    root.querySelector<HTMLButtonElement>('button.send')!.click();
    await tick();
    expect(root.textContent).toContain('no anthropic API key yet');
    expect(store.state.panels['assistant.settings']).toBe(true);
  });

  it('keeps a real conversation and an in-flight tool call alive while hidden', async () => {
    localStorage.setItem('femlab.ai.key', 'test-key');
    let finishTool!: (value: unknown) => void;
    const pending = new Promise((resolve) => { finishTool = resolve; });
    let round = 0;
    const provider = vi.spyOn(anthropic, 'anthropicProvider').mockReturnValue({
      id: 'anthropic', models: ['test'],
      async *chat() {
        if (round++ === 0) {
          yield { type: 'text_delta', text: 'Inspecting the beam.' };
          yield { type: 'tool_use', id: 'inspect', name: 'query_model', input: {} };
        } else yield { type: 'text_delta', text: 'The beam is ready.' };
        yield { type: 'done', stopReason: 'end_turn' };
      },
    });
    try {
      const { root, registry, store } = await mount();
      const original = registry.query.bind(registry);
      vi.spyOn(registry, 'query').mockImplementation((q) => q.query === 'query.model' ? pending : q.query === 'query.journal' ? Promise.resolve({ entries: [], revision: 0, canUndo: false, canRedo: false }) : original(q));
      await type(root, 'Check the beam');
      root.querySelector<HTMLButtonElement>('button.send')!.click();
      await tick();
      expect(root.textContent).toContain('Inspecting the beam.');
      expect(root.querySelector('.thinking')!.textContent).toContain('query.model');
      expect(root.querySelector('.card')!.getAttribute('data-status')).toBe('pending');
      expect(root.querySelector('.card [aria-label=Running]')).not.toBeNull();
      expect(root.querySelector('.card .ok')).toBeNull();
      render(<AssistantPanel registry={registry} store={store} hidden />, root);
      await tick();
      expect(root.querySelector('aside')!.hidden).toBe(true);
      finishTool({ name: 'beam', bodies: [] });
      await tick();
      await tick();
      render(<AssistantPanel registry={registry} store={store} />, root);
      await tick();
      expect(root.querySelector('aside')!.hidden).toBe(false);
      expect(root.querySelector('.bubble')!.textContent).toBe('Check the beam');
      expect(root.textContent).toContain('Inspecting the beam.');
      expect(root.textContent).toContain('The beam is ready.');
      expect(root.querySelector('.card .out')!.textContent).toContain('beam');
      expect(root.querySelector('.card')!.getAttribute('data-status')).toBe('succeeded');
      expect(root.querySelector('.card [aria-label=Succeeded]')).not.toBeNull();
      expect(root.querySelector('.thinking')).toBeNull();
    } finally { provider.mockRestore(); }
  });

  it('shows a script error as a failed tool card with its partial console output', async () => {
    localStorage.setItem('femlab.ai.key', 'test-key');
    let round = 0;
    const provider = vi.spyOn(anthropic, 'anthropicProvider').mockReturnValue({
      id: 'anthropic', models: ['test'],
      async *chat() {
        if (round++ === 0) yield { type: 'tool_use', id: 'script', name: 'run_script', input: { code: 'buildThenFail()' } };
        yield { type: 'done', stopReason: 'end_turn' };
      },
    });
    try {
      const { root, registry } = await mount();
      const original = registry.query.bind(registry);
      vi.spyOn(registry, 'query').mockImplementation((q) => q.query === 'query.journal' ? Promise.resolve({ hash: 'empty', entries: [], revision: 0, canUndo: false, canRedo: false }) : original(q));
      vi.spyOn(registry, 'dispatch').mockResolvedValue({ result: null, console: ['built one body'], error: 'line 2: no such Set' });
      await type(root, 'Build it');
      root.querySelector<HTMLButtonElement>('button.send')!.click();
      await tick();
      await tick();
      expect(root.querySelector('.card.bad')!.getAttribute('data-status')).toBe('failed');
      expect(root.querySelector('.card [aria-label=Failed]')).not.toBeNull();
      expect(root.querySelector('.card .out')!.textContent).toContain('built one body');
      expect(root.querySelector('.card .out')!.textContent).toContain('line 2: no such Set');
    } finally { provider.mockRestore(); }
  });

  it('shows the key source and the model in the settings sub-panel', async () => {
    localStorage.setItem('femlab.ai.key', 'sk-ant-api03-abcdefgh7f2a');
    const { root } = await mount({ panels: { 'assistant.settings': true } });
    expect(root.textContent).toContain('from localStorage in this browser');
    expect(root.querySelector<HTMLInputElement>('.settings input[type=password]')!.placeholder).toBe('sk-ant-a…7f2a');
    expect([...root.querySelectorAll('.settings option')].map((o) => o.textContent)).toContain('claude-opus-5');
    expect(root.querySelector('[data-cmd="ai.setModel"]')).not.toBeNull();
  });

  it('lists the Model objects in the mention popover and inserts one as a token', async () => {
    const { root } = await mount();
    root.querySelector<HTMLButtonElement>('.bar .at')!.click();
    await tick();
    const entry = root.querySelector<HTMLButtonElement>('.popover button[data-cmd="chat.insertMention"]')!;
    expect(entry.textContent).toContain('beam');
    entry.click();
    await tick();
    expect(root.querySelector('.token')!.textContent).toContain('@body:beam');
  });

  it('expands @selection into one token per selected object', async () => {
    const { root, store } = await mount();
    store.select({ bodies: ['beam'], faces: ['beam.top'] });
    await tick();
    root.querySelector<HTMLButtonElement>('.bar [data-cmd="chat.insertMention"]')!.click();
    await tick();
    expect([...root.querySelectorAll('.token span:first-child')].map((t) => t.textContent)).toEqual(['@body:beam', '@face:beam.top']);
  });

  it('shows the skill menu when the line starts with a slash', async () => {
    const { root } = await mount();
    await type(root, '/beam');
    expect(root.querySelector('.popover')!.textContent).toContain('beam-theory-check');
  });

  // Issue #39: `@` alone opened nothing, and an `@` after any word never matched at all.
  it('opens the picker on a bare @, and on an @ in the middle of a line', async () => {
    const { root } = await mount();
    await type(root, '@');
    expect(root.querySelector('.popover')).not.toBeNull();
    expect(root.querySelector('.popover')!.textContent).toContain('beam');
    await type(root, 'ask about @be');
    expect(root.querySelector('.popover')!.textContent).toContain('beam');
    await type(root, 'ask about @zzz');
    expect(root.querySelector('.popover')).toBeNull();
  });

  it('groups the candidates by kind, with the two context rows pinned above them', async () => {
    const { root, store } = await mount();
    store.select({ bodies: ['beam'] });
    await tick();
    await type(root, '@');
    expect([...root.querySelectorAll('.popover .group-label')].map((l) => l.textContent)).toEqual(['context', 'bodies']);
    expect([...root.querySelectorAll('.popover .group:first-child .name')].map((n) => n.textContent)).toEqual(['selection', 'view']);
  });

  it('walks the list with the arrows and picks with ↵, leaving no orphan @ in the draft', async () => {
    const { root, store } = await mount();
    store.select({ bodies: ['beam'] });
    await tick();
    const box = await type(root, 'check @be');
    press(box, 'ArrowDown');
    press(box, 'ArrowDown');
    await tick();
    press(box, 'Enter');
    await tick();
    expect(root.querySelector('.token')!.textContent).toContain('@body:beam');
    expect(box.value).toBe('check ');
    expect(root.querySelector('.popover')).toBeNull();
  });

  it('closes on Escape without touching the draft, and comes back on the next letter', async () => {
    const { root } = await mount();
    const box = await type(root, 'about @b');
    press(box, 'Escape');
    await tick();
    expect(root.querySelector('.popover')).toBeNull();
    expect(box.value).toBe('about @b');
    await type(root, 'about @be');
    expect(root.querySelector('.popover')).not.toBeNull();
  });

  it('hands chat.send from a script to the same code the Send button runs', async () => {
    const { root, store } = await mount({ panels: { assistant: false } });
    chatBridge.send('hello from a script');
    expect(store.state.panels['assistant']).toBe(true);
    await tick();
    expect(root.textContent).toContain('no anthropic API key yet');
    chatBridge.clear();
    await tick();
    expect(root.textContent).not.toContain('no anthropic API key yet');
  });

  // Issue #40: "open the drawer, then chat.send" is one tick, and the panel mounts on the next.
  it('keeps a chat.send made before it mounted, and sends it on mount', async () => {
    chatBridge.send('sent before the drawer existed');
    expect(chatBridge.pending).toBe('sent before the drawer existed');
    const { root, store } = await mount();
    await tick();
    // No key, so the buffered line lands as the drawer's own answer and opens Settings, which is
    // exactly what #40 asks for. Dropped, it would say nothing at all.
    expect(root.textContent).toContain('no anthropic API key yet');
    expect(store.state.panels['assistant.settings']).toBe(true);
    expect(chatBridge.pending).toBeNull();
  });

  it('goes back to buffering when it unmounts, so the next send is not lost either', async () => {
    const { root } = await mount();
    render(null, root);
    chatBridge.send('after the drawer closed');
    expect(chatBridge.pending).toBe('after the drawer closed');
  });
});

describe('the verification block', () => {
  it('is lifted out of the assistant’s own text, leaving the prose behind', () => {
    const { rows, prose } = parseVerification('Solved.\n\n<verification>\nok | Reactions equal the applied load | 0.02 %\nwarn | Tip deflection vs beam theory | 6.1 %\nfail | Mesh convergence | not run\n</verification>\n\nThat is the answer.');
    expect(rows).toEqual([
      { status: 'ok', what: 'Reactions equal the applied load', value: '0.02 %' },
      { status: 'warn', what: 'Tip deflection vs beam theory', value: '6.1 %' },
      { status: 'fail', what: 'Mesh convergence', value: 'not run' },
    ]);
    expect(prose).toBe('Solved.\n\nThat is the answer.');
  });

  it('leaves text without a block completely alone', () => {
    expect(parseVerification('Just prose.')).toEqual({ rows: [], prose: 'Just prose.' });
  });
});
