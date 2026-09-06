// ADR 0003's behavioral gate: a click and the registered Command it names must produce the same
// observable host state. Checking only `data-cmd` leaves an onRun that mutates local state, or a
// button labelled with a different known Command, invisible to the schema-only checks.
import { HOST_COMMANDS, Registry, type EngineSchema, type JsonSchema, type ModelSummary } from '@femlab/registry';
import { render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import schema from '../../registry/src/generated/engine.schema.json';
import { fakeHost, fakeTransport } from '../../registry/test/fakes';
import { AssistantPanel, chatBridge } from '../src/ai/AssistantPanel';
import { appHostCommands, makeHostContext } from '../src/host';
import { Store, initialState, type UiState } from '../src/store';
import { Bottom } from '../src/ui/Bottom';
import { SchemaForm } from '../src/ui/SchemaForm';
import { Cmd } from '../src/ui/cmd';
import { type Defs } from '../src/ui/schema';

// The global test setup replaces the lazy AI barrel for shell tests. This gate mounts the real
// drawer, while making the host Command's dynamic bridge import resolve to that same real module.
vi.mock('../src/ai', async (importOriginal) => importOriginal());

const ENGINE_SCHEMA = schema as unknown as EngineSchema;
const DEFS: Defs = { ...ENGINE_SCHEMA.commands.$defs, ...ENGINE_SCHEMA.queries.$defs };
const VARIANTS = new Map<string, JsonSchema>(ENGINE_SCHEMA.commands.oneOf.map((v) => [v.properties['cmd']!.const!, v as unknown as JsonSchema]));
const MODEL: ModelSummary = {
  name: 'parity',
  revision: 1,
  hash: 'h',
  units: { length: 'mm', force: 'N', stress: 'MPa' },
  idealisation: 'solid',
  bodies: [{ name: 'beam', material: null, bbox: [{ value: 0, unit: 'm' }, { value: 0, unit: 'm' }, { value: 0, unit: 'm' }, { value: 1, unit: 'm' }, { value: 1, unit: 'm' }, { value: 1, unit: 'm' }], measure: { value: 1, unit: 'm^3' }, faces: ['beam.top'] }],
  materials: [],
  sets: [],
  constraints: [],
  loads: [],
  steps: [],
  meshSettings: null,
  warnings: [],
};

type CommandCall = { cmd: string } & Record<string, unknown>;
type Harness = { store: Store; registry: Registry; root: HTMLElement };

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const paint = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

function observable(store: Store): Pick<UiState, 'tab' | 'panels' | 'form' | 'pickInto' | 'pickTarget'> {
  return {
    tab: store.state.tab,
    panels: { ...store.state.panels },
    form: store.state.form ? { ...store.state.form, values: { ...store.state.form.values }, initial: { ...store.state.form.initial } } : null,
    pickInto: store.state.pickInto ? [...store.state.pickInto] : null,
    pickTarget: store.state.pickTarget,
  };
}

function harness(patch: Partial<UiState> = {}): Harness {
  const transport = fakeTransport();
  const engineQuery = transport.query;
  transport.query = async (q) => q.query === 'query.objects' ? ({ objects: [{ ref: 'body:beam', kind: 'body', name: 'beam', summary: 'a box' }] } as never) : engineQuery(q);
  const store = new Store({ ...initialState, model: MODEL, ready: true, revision: 1, ...patch, panels: { ...initialState.panels, ...patch.panels } });
  const viewer = { current: null };
  const host = fakeHost(transport);
  host.panels.toggle = (panel, open) => store.togglePanel(panel, open);
  host.selection.set = (input) => store.select(input);
  host.selection.clear = () => store.set({ selection: { bodies: [], faces: [], sets: [], refs: [] } });
  host.selection.setPickTarget = (target) => store.set({ pickTarget: target });
  host.selection.get = () => store.state.selection;
  host.chat.send = (text) => chatBridge.send(text);
  host.chat.insertMention = (ref) => chatBridge.insertMention(ref);
  host.chat.setDraft = (text) => chatBridge.setDraft(text);
  host.chat.clear = () => chatBridge.clear();
  host.ai.setKey = (key, provider = 'anthropic') => {
    const slot = provider === 'openai' ? 'femlab.ai.key.openai' : 'femlab.ai.key';
    if (key === null) localStorage.removeItem(slot);
    else localStorage.setItem(slot, key);
  };
  const registry = new Registry({
    schema: ENGINE_SCHEMA,
    host,
    hostCommands: [...HOST_COMMANDS, ...appHostCommands(store, transport, viewer, async () => undefined)],
  });
  const root = document.createElement('div');
  document.body.append(root);
  return { store, registry, root };
}

function unmount(root: HTMLElement): void {
  render(null, root);
  root.remove();
}

function dispatching(h: Harness, calls: CommandCall[]): (cmd: CommandCall) => Promise<unknown> {
  return (cmd) => {
    calls.push({ ...cmd });
    return h.registry.dispatch(cmd);
  };
}

/** Click one real control, then run the exact captured payload through a fresh Registry. */
async function assertClickParity(
  renderUi: (h: Harness, dispatch: (cmd: CommandCall) => Promise<unknown>) => void,
  selector: string,
  patch: Partial<UiState> = {},
): Promise<CommandCall> {
  const clicked = harness(patch);
  const calls: CommandCall[] = [];
  renderUi(clicked, dispatching(clicked, calls));
  const control = clicked.root.querySelector<HTMLElement>(selector);
  if (!control) throw new Error(`parity control not found: ${selector}`);
  const dataCmd = control.dataset['cmd'];
  if (!dataCmd) throw new Error(`parity control has no data-cmd: ${selector}`);
  control.click();
  await tick();
  expect(calls).toHaveLength(1);
  const call = calls[0]!;
  expect(call.cmd).toBe(dataCmd);
  expect(() => clicked.registry.describe(dataCmd)).not.toThrow();
  const afterClick = observable(clicked.store);

  const explicit = harness(patch);
  await explicit.registry.dispatch(call);
  expect(observable(explicit.store)).toEqual(afterClick);
  unmount(clicked.root);
  unmount(explicit.root);
  return call;
}

describe('behavioral Command parity', () => {
  afterEach(() => {
    for (const root of [...document.body.children]) unmount(root as HTMLElement);
    document.body.innerHTML = '';
    chatBridge.pending = null;
    chatBridge.pendingDraft = null;
  });

  it('dispatches provider key storage through the real browser host without changing the other slot', async () => {
    const transport = fakeTransport();
    const host = makeHostContext(new Store(), transport, { current: null }, {
      webgpu: false, crossOriginIsolated: false, sharedArrayBuffer: false,
      threads: 1, chromium: true, userAgent: 'Chromium parity test',
    });
    const registry = new Registry({ schema: ENGINE_SCHEMA, host, hostCommands: HOST_COMMANDS });
    localStorage.setItem('femlab.ai.key', 'anthropic-original');
    localStorage.setItem('femlab.ai.key.openai', 'openai-original');
    await registry.dispatch({ cmd: 'ai.setKey', key: 'openai-new', provider: 'openai' });
    expect(localStorage.getItem('femlab.ai.key.openai')).toBe('openai-new');
    expect(localStorage.getItem('femlab.ai.key')).toBe('anthropic-original');
    await registry.dispatch({ cmd: 'ai.setKey', key: 'anthropic-new' });
    expect(localStorage.getItem('femlab.ai.key')).toBe('anthropic-new');
    expect(localStorage.getItem('femlab.ai.key.openai')).toBe('openai-new');
    await registry.dispatch({ cmd: 'ai.setKey', key: null, provider: 'openai' });
    expect(localStorage.getItem('femlab.ai.key.openai')).toBeNull();
    expect(localStorage.getItem('femlab.ai.key')).toBe('anthropic-new');
    await registry.dispatch({ cmd: 'ai.setKey', key: 'openai-restored', provider: 'openai' });
    await registry.dispatch({ cmd: 'ai.setKey', key: null, provider: 'anthropic' });
    expect(localStorage.getItem('femlab.ai.key')).toBeNull();
    expect(localStorage.getItem('femlab.ai.key.openai')).toBe('openai-restored');
    localStorage.clear();
  });

  it('keeps every Bottom tab click equivalent to panel.toggle', async () => {
    for (const tab of ['journal', 'script', 'results', 'checks', 'console'] as const) {
      const call = await assertClickParity(
        (h, dispatch) => render(<Bottom s={h.store.state} store={h.store} dispatch={dispatch} query={async () => ({ value: 1, unit: 'Pa' })} />, h.root),
        `button[data-cmd="panel.toggle"][title="panel.toggle ${tab}"]`,
        { tab: 'journal' },
      );
      expect(call).toEqual({ cmd: 'panel.toggle', panel: tab, open: true });
    }
  });

  it('keeps SchemaForm pick and Revert clicks equivalent to registered Commands', async () => {
    const pick = harness();
    pick.store.openForm('load.pressure', { name: 'pressure', on: 'beam.top', value: '1 MPa' });
    const pickCalls: CommandCall[] = [];
    render(<SchemaForm s={pick.store.state} store={pick.store} dispatch={dispatching(pick, pickCalls)} query={async () => ({ value: 1, unit: 'Pa' })} defs={DEFS} variants={VARIANTS} />, pick.root);
    const picker = pick.root.querySelector<HTMLButtonElement>('.chip-pick');
    expect(picker).not.toBeNull();
    const pickDataCmd = picker!.dataset['cmd'];
    picker!.click();
    await tick();
    expect(pickCalls).toHaveLength(1);
    expect(pickCalls[0]!.cmd).toBe(pickDataCmd);
    expect(pickCalls[0]).toEqual({ cmd: 'form.pick', command: 'load.pressure', field: ['on'] });
    const pickAfter = observable(pick.store);
    const pickExplicit = harness();
    pickExplicit.store.openForm('load.pressure', { name: 'pressure', on: 'beam.top', value: '1 MPa' });
    await pickExplicit.registry.dispatch(pickCalls[0]!);
    expect(observable(pickExplicit.store)).toEqual(pickAfter);
    unmount(pick.root);
    unmount(pickExplicit.root);

    const revert = harness();
    revert.store.openForm('load.pressure', { name: 'pressure', on: 'beam.top', value: '1 MPa' });
    revert.store.set({ form: { cmd: 'load.pressure', values: { name: 'changed', on: 'beam.top', value: '2 MPa' }, initial: { name: 'pressure', on: 'beam.top', value: '1 MPa' } } });
    const revertCalls: CommandCall[] = [];
    render(<SchemaForm s={revert.store.state} store={revert.store} dispatch={dispatching(revert, revertCalls)} query={async () => ({ value: 1, unit: 'Pa' })} defs={DEFS} variants={VARIANTS} />, revert.root);
    const revertButton = revert.root.querySelector<HTMLButtonElement>('button[title="Revert to the values this form opened with"]');
    expect(revertButton).not.toBeNull();
    const revertDataCmd = revertButton!.dataset['cmd'];
    revertButton!.click();
    await tick();
    expect(revertCalls).toHaveLength(1);
    expect(revertCalls[0]!.cmd).toBe(revertDataCmd);
    expect(revertCalls[0]).toEqual({ cmd: 'form.open', command: 'load.pressure', args: { name: 'pressure', on: 'beam.top', value: '1 MPa' } });
    const revertAfter = observable(revert.store);
    const revertExplicit = harness();
    revertExplicit.store.openForm('load.pressure', { name: 'changed', on: 'beam.top', value: '2 MPa' });
    await revertExplicit.registry.dispatch(revertCalls[0]!);
    expect(observable(revertExplicit.store)).toEqual(revertAfter);
    unmount(revert.root);
    unmount(revertExplicit.root);
  });

  async function assistantParity(selector: string, expected: CommandCall, patch: Partial<UiState> = {}, prepare?: (root: HTMLElement) => Promise<void> | void): Promise<{ call: CommandCall; actual: { state: ReturnType<typeof observable>; draft: string; tokens: string[] }; explicit: { state: ReturnType<typeof observable>; draft: string; tokens: string[] } }> {
    chatBridge.pending = null;
    chatBridge.pendingDraft = null;
    const clicked = harness({ panels: { assistant: true }, ...patch });
    const calls: CommandCall[] = [];
    const original = clicked.registry.dispatch.bind(clicked.registry);
    const spy = vi.spyOn(clicked.registry, 'dispatch').mockImplementation((cmd) => {
      calls.push({ ...cmd });
      return original(cmd);
    });
    render(<AssistantPanel registry={clicked.registry} store={clicked.store} />, clicked.root);
    await paint();
    await prepare?.(clicked.root);
    calls.length = 0;
    const control = clicked.root.querySelector<HTMLElement>(selector);
    if (!control) throw new Error(`assistant parity control not found: ${selector}`);
    const dataCmd = control.dataset['cmd'];
    if (!dataCmd) throw new Error(`assistant parity control has no data-cmd: ${selector}`);
    control.click();
    await tick();
    await tick();
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.cmd).toBe(dataCmd);
    expect(call).toEqual(expected);
    expect(() => clicked.registry.describe(dataCmd)).not.toThrow();
    const actual = {
      state: observable(clicked.store),
      draft: clicked.root.querySelector<HTMLTextAreaElement>('textarea')?.value ?? '',
      tokens: [...clicked.root.querySelectorAll('.token > span:first-child')].map((token) => token.textContent ?? ''),
    };
    spy.mockRestore();
    unmount(clicked.root);

    chatBridge.pending = null;
    chatBridge.pendingDraft = null;
    const explicit = harness({ panels: { assistant: true }, ...patch });
    render(<AssistantPanel registry={explicit.registry} store={explicit.store} />, explicit.root);
    await paint();
    await prepare?.(explicit.root);
    await explicit.registry.dispatch(call);
    await tick();
    await tick();
    const result = {
      state: observable(explicit.store),
      draft: explicit.root.querySelector<HTMLTextAreaElement>('textarea')?.value ?? '',
      tokens: [...explicit.root.querySelectorAll('.token > span:first-child')].map((token) => token.textContent ?? ''),
    };
    expect(result).toEqual(actual);
    unmount(explicit.root);
    return { call, actual, explicit: result };
  }

  it('keeps Assistant settings, close, and skill toggles on panel.toggle', async () => {
    await assistantParity('button[data-cmd="panel.toggle"][title="Settings"]', { cmd: 'panel.toggle', panel: 'assistant.settings' });
    await assistantParity('button[data-cmd="panel.toggle"][title="Close the assistant"]', { cmd: 'panel.toggle', panel: 'assistant', open: false });
    await assistantParity('.chips button[data-cmd="panel.toggle"]', { cmd: 'panel.toggle', panel: 'skill:beam-theory-check', open: false }, { panels: { 'skill:beam-theory-check': true } });
  });

  it('keeps Assistant clear, mentions-panel, selection insertion, and no-key Send on Commands', async () => {
    await assistantParity('button[data-cmd="chat.clear"]', { cmd: 'chat.clear' });
    await assistantParity('button[data-cmd="panel.toggle"].at', { cmd: 'panel.toggle', panel: 'assistant.mentions' });
    await assistantParity('.popover button[data-cmd="chat.insertMention"]', { cmd: 'chat.insertMention', ref: 'body:beam' }, {}, async (root) => {
      root.querySelector<HTMLButtonElement>('.bar .at')!.click();
      await tick();
      await tick();
    });
    await assistantParity('button[data-cmd="chat.insertMention"]', { cmd: 'chat.insertMention', ref: 'body:beam' }, { selection: { bodies: ['beam'], faces: [], sets: [], refs: ['body:beam'] } });
    const result = await assistantParity('button[data-cmd="chat.send"]', { cmd: 'chat.send', text: 'hello from parity' }, {}, async (root) => {
      const textarea = root.querySelector<HTMLTextAreaElement>('textarea')!;
      textarea.value = 'hello from parity';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      await tick();
    });
    expect(result.actual.state.panels['assistant.settings']).toBe(true);
    expect(result.actual.tokens).toEqual([]);
  });

  it('routes Enter in the composer through chat.send', async () => {
    const clicked = harness({ panels: { assistant: true } });
    const calls: CommandCall[] = [];
    const original = clicked.registry.dispatch.bind(clicked.registry);
    const spy = vi.spyOn(clicked.registry, 'dispatch').mockImplementation((cmd) => {
      calls.push({ ...cmd });
      return original(cmd);
    });
    render(<AssistantPanel registry={clicked.registry} store={clicked.store} />, clicked.root);
    await paint();
    const textarea = clicked.root.querySelector<HTMLTextAreaElement>('textarea')!;
    textarea.value = 'submitted by Enter';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    await tick();
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await tick();
    expect(calls).toContainEqual({ cmd: 'chat.send', text: 'submitted by Enter' });
    expect(clicked.store.state.panels['assistant.settings']).toBe(true);
    spy.mockRestore();
    unmount(clicked.root);
  });

  it('keeps the API-key save on ai.setKey and the host storage contract', async () => {
    localStorage.clear();
    const clicked = harness({ panels: { assistant: true, 'assistant.settings': true } });
    const calls: CommandCall[] = [];
    const original = clicked.registry.dispatch.bind(clicked.registry);
    const spy = vi.spyOn(clicked.registry, 'dispatch').mockImplementation((cmd) => {
      calls.push({ ...cmd });
      return original(cmd);
    });
    render(<AssistantPanel registry={clicked.registry} store={clicked.store} />, clicked.root);
    await paint();
    const input = clicked.root.querySelector<HTMLInputElement>('.settings input[type="password"]')!;
    input.value = 'test-key';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await tick();
    clicked.root.querySelector<HTMLButtonElement>('button[data-cmd="ai.setKey"]')!.click();
    await tick();
    expect(calls).toContainEqual({ cmd: 'ai.setKey', key: 'test-key', provider: 'anthropic' });
    expect(localStorage.getItem('femlab.ai.key')).toBe('test-key');
    spy.mockRestore();
    unmount(clicked.root);
  });

  it('keeps OpenAI key saves in the OpenAI slot', async () => {
    localStorage.clear();
    localStorage.setItem('femlab.ai.key.openai', 'old-openai');
    const clicked = harness({ panels: { assistant: true, 'assistant.settings': true } });
    const calls: CommandCall[] = [];
    const original = clicked.registry.dispatch.bind(clicked.registry);
    const spy = vi.spyOn(clicked.registry, 'dispatch').mockImplementation((cmd) => {
      calls.push({ ...cmd });
      return original(cmd);
    });
    render(<AssistantPanel registry={clicked.registry} store={clicked.store} />, clicked.root);
    await paint();
    const input = clicked.root.querySelector<HTMLInputElement>('.settings input[type="password"]')!;
    input.value = 'new-openai';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await tick();
    clicked.root.querySelector<HTMLButtonElement>('button[data-cmd="ai.setKey"]')!.click();
    await tick();
    expect(calls).toContainEqual({ cmd: 'ai.setKey', key: 'new-openai', provider: 'openai' });
    expect(localStorage.getItem('femlab.ai.key.openai')).toBe('new-openai');
    expect(localStorage.getItem('femlab.ai.key')).toBeNull();
    spy.mockRestore();
    unmount(clicked.root);
  });

  it('keeps the slash menu on chat.setDraft', async () => {
    const result = await (async () => {
      chatBridge.pending = null;
      chatBridge.pendingDraft = null;
      const clicked = harness({ panels: { assistant: true } });
      const calls: CommandCall[] = [];
      let commandSettled: Promise<unknown> | null = null;
      const original = clicked.registry.dispatch.bind(clicked.registry);
      const spy = vi.spyOn(clicked.registry, 'dispatch').mockImplementation((cmd) => {
        calls.push({ ...cmd });
        const result = original(cmd);
        commandSettled = result;
        return result;
      });
      render(<AssistantPanel registry={clicked.registry} store={clicked.store} />, clicked.root);
      await paint();
      const textarea = clicked.root.querySelector<HTMLTextAreaElement>('textarea')!;
      textarea.value = '/beam';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      await tick();
      const item = clicked.root.querySelector<HTMLElement>('[data-cmd="chat.setDraft"]');
      expect(item).not.toBeNull();
      item!.click();
      expect(commandSettled).not.toBeNull();
      await commandSettled;
      await paint();
      expect(calls).toHaveLength(1);
      expect(calls[0]!.cmd).toBe(item!.dataset['cmd']);
      expect(calls[0]).toEqual({ cmd: 'chat.setDraft', text: '/beam-theory-check ' });
      const actual = { state: observable(clicked.store), draft: clicked.root.querySelector<HTMLTextAreaElement>('textarea')!.value };
      spy.mockRestore();
      unmount(clicked.root);

      chatBridge.pending = null;
      chatBridge.pendingDraft = null;
      const explicit = harness({ panels: { assistant: true } });
      render(<AssistantPanel registry={explicit.registry} store={explicit.store} />, explicit.root);
      await paint();
      await explicit.registry.dispatch(calls[0]!);
      await paint();
      const expected = { state: observable(explicit.store), draft: explicit.root.querySelector<HTMLTextAreaElement>('textarea')!.value };
      expect(expected).toEqual(actual);
      unmount(explicit.root);
      return { actual, expected };
    })();
    expect(result.actual.draft).toMatch(/^\/beam-theory-check /);
  });

  it('awaits asynchronous chat.setDraft completion and failure', async () => {
    const transport = fakeTransport();
    const store = new Store();
    const host = fakeHost(transport);
    let release!: () => void;
    const applied = vi.fn();
    host.chat.setDraft = () => new Promise<void>((resolve) => {
      release = () => {
        applied();
        resolve();
      };
    });
    const registry = new Registry({
      schema: ENGINE_SCHEMA,
      host,
      hostCommands: appHostCommands(store, transport, { current: null }, async () => undefined),
    });

    const settled = vi.fn();
    const dispatched = registry.dispatch({ cmd: 'chat.setDraft', text: '/beam' }).then(settled);
    await tick();
    expect(settled).not.toHaveBeenCalled();
    expect(applied).not.toHaveBeenCalled();

    release();
    await dispatched;
    expect(applied).toHaveBeenCalledOnce();
    expect(settled).toHaveBeenCalledOnce();

    const failure = new Error('draft bridge unavailable');
    host.chat.setDraft = () => Promise.reject(failure);
    await expect(registry.dispatch({ cmd: 'chat.setDraft', text: '/retry' })).rejects.toBe(failure);
  });

  it('would fail for a local-store mutant and a mislabeled known Command', async () => {
    await expect(
      assertClickParity(
        (h, dispatch) => render(<Cmd dispatch={dispatch} cmd="panel.toggle" onRun={() => h.store.togglePanel('script', true)}>mutant</Cmd>, h.root),
        'button[data-cmd="panel.toggle"]',
      ),
    ).rejects.toThrow('to have a length of 1');
    await expect(
      assertClickParity(
        (_h, dispatch) => render(<Cmd dispatch={dispatch} cmd="panel.toggle" onRun={() => void dispatch({ cmd: 'view.setMode', mode: 'mesh' })}>mislabeled</Cmd>, _h.root),
        'button[data-cmd="panel.toggle"]',
      ),
    ).rejects.toThrow("to be 'panel.toggle'");
  });
});
