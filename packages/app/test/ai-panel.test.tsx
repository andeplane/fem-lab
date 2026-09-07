// ADR 0003 for the drawer: every clickable in it names a Command the registry has. Plus the pieces
// the design's cards are made of — the verification block the model writes, the mention popover,
// the skill toggles and the settings row.
import { HOST_COMMANDS, Registry, type EngineSchema } from '@femlab/registry';
import { render } from 'preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as anthropic from '../src/ai/anthropic';
import * as context from '../src/ai/context';
import schema from '../../registry/src/generated/engine.schema.json';
import { fakeTransport } from '../../registry/test/fakes';
import { AssistantPanel, ToolCard, chatBridge, resultAssumptions } from '../src/ai/AssistantPanel';
import { parseVerification } from '../src/ai/context';
import { Store } from '../src/store';
import { bindRegistryProducer } from '../src/producer-registry';
import { Checks } from '../src/ui/Results';
import { appHostCommands, makeHostContext } from '../src/host';
import { readHostCaps } from '../src/capabilities';
import type { EngineTransport as WorkerTransport } from '@femlab/registry';
import type { ChatRequest } from '../src/ai/provider';
import { BUILTIN_SKILLS } from '../src/ai/skills';
import * as project from '../src/ai/project';
import { fakeDir } from './project-fake';

async function mount(patch: Partial<Store['state']> = {}) {
  const transport = fakeTransport();
  transport.query = (async (q: { query: string }) => (q.query === 'query.objects' ? { objects: [{ ref: 'body:beam', kind: 'body', name: 'beam', summary: 'a box' }] } : { entries: [], revision: 0, canUndo: false, canRedo: false })) as never;
  const store = new Store();
  const viewer = { current: null };
  const host = makeHostContext(store, transport as WorkerTransport, viewer, readHostCaps({}));
  host.chat.send = (text) => chatBridge.send(text);
  host.chat.insertMention = (ref) => chatBridge.insertMention(ref);
  host.chat.setDraft = (text) => chatBridge.setDraft(text);
  host.chat.clear = () => chatBridge.clear();
  const registry = new Registry({ schema: schema as unknown as EngineSchema, host, hostCommands: [...HOST_COMMANDS, ...appHostCommands(store, transport as WorkerTransport, viewer, async () => undefined)] });

  bindRegistryProducer(registry, async () => ({ registry, signal: new AbortController().signal, store: () => store, release: async () => undefined }));
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
  box.focus();
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
    chatBridge.pendingDraft = null;
    localStorage.clear();
    sessionStorage.clear();
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
    sessionStorage.setItem('femlab.ai.key', 'test-key');
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

  it('renders every solver-used assumption from direct and script-returned Results beyond the JSON preview', () => {
    const assumption = {
      step: 'thermal-explicit',
      body: 'heated-block',
      material: 'catalogue-aluminium',
      property: 'alpha' as const,
      value: { value: 0, unit: '1/K' },
      source: 'NASA NTRS 20120014854, Section 2, PDF p. 36',
      cause: 'the resolved temperature field read the omitted thermal expansion coefficient as zero',
    };
    expect(resultAssumptions(JSON.stringify({ assumptions: [assumption] }))).toEqual([assumption]);

    const result = JSON.stringify({
      result: {
        paddingBeforeTheSolveResult: 'x'.repeat(13000),
        output: { type: 'solve', summary: { assumptions: [assumption] } },
      },
      console: [],
    });
    const root = document.createElement('div');
    document.body.append(root);
    render(
      <ToolCard call={{ id: 'script', tool: 'run_script', command: 'script.run', input: { code: 'return await fem.solve.run({ step: "thermal-explicit" })' }, ms: 4, status: 'succeeded', result }} />,
      root,
    );
    expect(root.querySelector('.out')!.textContent).not.toContain(assumption.cause);
    const shown = root.querySelector('.result-assumption')!.textContent!;
    for (const text of [assumption.step, assumption.body, assumption.material, assumption.property, '0 1/K', assumption.cause, assumption.source]) {
      expect(shown).toContain(text);
    }
    render(
      <ToolCard call={{ id: 'failed', tool: 'run_script', command: 'script.run', input: {}, ms: 4, status: 'failed', result }} />,
      root,
    );
    expect(root.querySelector('.result-assumption')).toBeNull();
  });

  it('shows a script error as a failed tool card with its partial console output', async () => {
    sessionStorage.setItem('femlab.ai.key', 'test-key');
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
      const dispatch = registry.dispatch.bind(registry);
      vi.spyOn(registry, 'dispatch').mockImplementation((cmd) => cmd.cmd === 'script.run'
        ? Promise.resolve({ result: null, console: ['built one body'], error: 'line 2: no such Set' })
        : dispatch(cmd));
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

  it('renders deltas before completion and finalizes prose and verification without duplicates', async () => {
    sessionStorage.setItem('femlab.ai.key', 'test-key');
    let resumeFirst!: () => void;
    let resumeVerification!: () => void;
    const first = new Promise<void>((resolve) => { resumeFirst = resolve; });
    const verification = new Promise<void>((resolve) => { resumeVerification = resolve; });
    let round = 0;
    const provider = vi.spyOn(anthropic, 'anthropicProvider').mockReturnValue({
      id: 'anthropic', models: ['test'],
      async *chat() {
        if (round++ === 0) {
          yield { type: 'text_delta', text: 'First' };
          await first;
          yield { type: 'text_delta', text: ' sentence.' };
          yield { type: 'tool_use', id: 'inspect', name: 'query_model', input: {} };
        } else {
          yield { type: 'text_delta', text: 'Solved.\n<ver' };
          await verification;
          yield { type: 'text_delta', text: 'ification>\nok | Reaction balance | 0 %\n</verification>\nDone.' };
        }
        yield { type: 'done', stopReason: 'end_turn' };
      },
    });
    try {
      const { root, registry, store } = await mount({ journal: { hash: 'empty', entries: [], revision: 0, canUndo: false, canRedo: false } });
      const original = registry.query.bind(registry);
      vi.spyOn(registry, 'query').mockImplementation((q) => q.query === 'query.journal' ? Promise.resolve({ hash: 'empty', entries: [], revision: 0, canUndo: false, canRedo: false }) : original(q));
      await type(root, 'Check it');
      root.querySelector<HTMLButtonElement>('button.send')!.click();
      await tick();
      expect(root.querySelector('.streaming')!.textContent).toBe('First');
      expect(root.querySelector('.card')).toBeNull();
      resumeFirst();
      await tick();
      await tick();
      expect(root.querySelector('.streaming')!.textContent).toBe('Solved.');
      expect(root.textContent).not.toContain('<ver');
      expect(root.querySelector('.verify')).toBeNull();
      resumeVerification();
      await tick();
      await tick();
      expect(root.querySelector('.streaming')).toBeNull();
      expect([...root.querySelectorAll('.prose p')].map((p) => p.textContent)).toEqual(['First sentence.', 'Solved.', 'Done.']);
      expect(root.querySelectorAll('.verify')).toHaveLength(1);
      expect(root.querySelector('.verify')!.textContent).toContain('Reaction balance');
      expect(root.querySelector('.suggestions')!.textContent).toContain('Check this Model');
      expect(root.querySelector('.suggestions')!.textContent).not.toContain('Build a cantilever');
      expect(store.state.assistantVerifications).toHaveLength(1);
      const checks = document.createElement('div');
      document.body.append(checks);
      const showChecks = () => render(<Checks s={store.state} dispatch={registry.dispatch.bind(registry)} query={registry.query.bind(registry)} />, checks);
      showChecks();
      expect(checks.textContent).toContain('Assistant-reported checks');
      expect(checks.textContent).toContain('not independently verified');
      expect(checks.querySelector('.assistant-check')!.textContent).toContain('Reaction balance');
      expect(checks.querySelector('.assistant-check')!.textContent).toContain('0 %');
      expect(checks.querySelector('.assistant-check')!.textContent).toContain('Recorded at Model rev 0');
      store.set({ journal: { ...store.state.journal!, hash: 'edited' }, revision: 1 });
      await tick();
      showChecks();
      expect(root.querySelector('.verify')!.textContent).toContain('Stale');
      expect(checks.querySelector('.assistant-check')!.textContent).toContain('Stale');
      chatBridge.clear();
      await tick();
      expect(root.querySelector('.verify')).toBeNull();
      expect(store.state.assistantVerifications).toHaveLength(1);
      expect(checks.textContent).toContain('Reaction balance');
    } finally { provider.mockRestore(); }
  });

  it('shows the key source and the model in the settings sub-panel', async () => {
    sessionStorage.setItem('femlab.ai.key', 'sk-ant-api03-abcdefgh7f2a');
    const { root } = await mount({ panels: { 'assistant.settings': true } });
    expect(root.textContent).toContain('from sessionStorage in this tab');
    expect(root.querySelector<HTMLInputElement>('.settings input[type=password]')!.placeholder).toBe('sk-ant-a…7f2a');
    expect([...root.querySelectorAll('.model-row option')].map((o) => o.textContent)).toContain('claude-opus-5');
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

  it('prepares editable suggestions and selects a skill without sending the draft', async () => {
    const { root, registry, store } = await mount();
    const dispatch = vi.spyOn(registry, 'dispatch');
    root.querySelector<HTMLButtonElement>('.suggestions button')!.click();
    await tick();
    const box = root.querySelector('textarea')!;
    expect(box.value).toContain('Help me build a cantilever');
    expect(document.activeElement).toBe(box);
    expect(root.querySelector('.user')).toBeNull();
    await type(root, 'Check my beam');
    root.querySelector<HTMLButtonElement>('[title="Choose a skill for this draft"]')!.click();
    await tick();
    expect(store.state.panels['assistant.skills']).toBe(true);
    const skill = [...root.querySelectorAll<HTMLButtonElement>('.popover button')].find((b) => b.textContent?.includes('beam-theory-check'))!;
    skill.click();
    await tick();
    expect(box.value).toBe('/beam-theory-check Check my beam');
    expect(document.activeElement).toBe(box);
    expect(root.querySelector('.popover')).toBeNull();
    expect(dispatch.mock.calls.some(([c]) => c.cmd === 'chat.send' || c.cmd === 'skill.invoke')).toBe(false);
    expect(dispatch).toHaveBeenCalledWith({ cmd: 'chat.setDraft', text: '/beam-theory-check Check my beam' });
  });

  it('loads a selected skill on Send while retaining existing reference chips', async () => {
    sessionStorage.setItem('femlab.ai.key', 'test-key');
    let received = '';
    const provider = vi.spyOn(anthropic, 'anthropicProvider').mockReturnValue({
      id: 'anthropic', models: ['test'],
      async *chat(request) {
        received = JSON.stringify(request.messages);
        yield { type: 'text_delta', text: 'Checked' };
        yield { type: 'done', stopReason: 'end_turn' };
      },
    });
    try {
      const { root, registry } = await mount();
      chatBridge.insertMention('body:beam');
      await type(root, 'Check my beam\nExplain assumptions');
      root.querySelector<HTMLButtonElement>('[title="Choose a skill for this draft"]')!.click();
      await tick();
      [...root.querySelectorAll<HTMLButtonElement>('.popover button')].find((b) => b.textContent?.includes('beam-theory-check'))!.click();
      await tick();
      expect(root.querySelector('.token')!.textContent).toContain('@body:beam');
      const dispatch = vi.spyOn(registry, 'dispatch');
      root.querySelector<HTMLButtonElement>('button.send')!.click();
      await tick();
      await tick();
      expect(dispatch).toHaveBeenCalledWith({ cmd: 'skill.invoke', name: 'beam-theory-check', args: 'Check my beam\nExplain assumptions @body:beam' });
      expect(received).toContain('Skill beam-theory-check');
      expect(received).toContain('A beam-shaped model has a closed-form answer.');
      expect(received).toContain('@body:beam');
    } finally { provider.mockRestore(); }
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

  it('discards a mention index that finishes after the panel changes sessions', async () => {
    const previous = await mount();
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const oldQuery = previous.registry.query.bind(previous.registry);
    previous.registry.query = async query => {
      const result = await oldQuery(query);
      if (query.query === 'query.objects') await gate;
      return result;
    };
    previous.root.querySelector('textarea')!.focus();
    await tick();
    const next = await mount();
    const nextQuery = next.registry.query.bind(next.registry);
    next.registry.query = async query => query.query === 'query.objects'
      ? { objects: [{ ref: 'body:new-part', kind: 'body', name: 'new-part', summary: 'new session' }] }
      : nextQuery(query);
    render(null, next.root);
    render(<AssistantPanel registry={next.registry} store={next.store} />, previous.root);
    await paint();
    previous.root.querySelector('textarea')!.blur();
    await type(previous.root, '@');
    expect(previous.root.querySelector('.popover')!.textContent).toContain('new-part');
    finish(); await paint();
    expect(previous.root.querySelector('.popover')!.textContent).toContain('new-part');
    expect(previous.root.querySelector('.popover')!.textContent).not.toContain('beam');
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

  it('loads the same built-in through the production host, slash picker and sent turn', async () => {
    sessionStorage.setItem('femlab.ai.key', 'test-key');
    const requests: ChatRequest[] = [];
    const provider = vi.spyOn(anthropic, 'anthropicProvider').mockReturnValue({
      id: 'anthropic', models: ['test'],
      async *chat(request) {
        requests.push({ ...request, messages: structuredClone(request.messages) });
        yield { type: 'text_delta', text: 'Skill received.' };
        yield { type: 'done', stopReason: 'end_turn' };
      },
    });
    try {
      const { root, registry } = await mount();
      const builtin = BUILTIN_SKILLS.find((s) => s.name === 'beam-theory-check')!;
      // Before the drawer can send anything, this same production host already resolves skills.
      expect(await registry.query({ query: 'query.skills' })).toContainEqual({ name: builtin.name, description: builtin.description, when: builtin.when, source: builtin.source });
      expect(await registry.dispatch({ cmd: 'skill.invoke', name: builtin.name, args: 'check the beam' })).toEqual({ name: builtin.name, body: builtin.body, source: 'builtin', args: 'check the beam' });
      await type(root, '/beam');
      root.querySelector<HTMLButtonElement>('.popover [data-cmd="chat.setDraft"]')!.click();
      await tick();
      expect(root.querySelector('textarea')!.value).toBe('/beam-theory-check ');
      root.querySelector<HTMLButtonElement>('button.send')!.click();
      await vi.waitFor(() => expect(root.textContent).toContain('Skill received.'));
      expect(requests).toHaveLength(1);
      expect(requests[0]!.messages[0]!.content).toEqual([{ type: 'text', text: `Skill ${builtin.name}:\n${builtin.body}\n\n` }]);
      expect(root.textContent).not.toContain('not-found');
    } finally { provider.mockRestore(); }
  });

  it('shares project overrides, refreshed content and close with the host and every skill menu', async () => {
    const skill = (name: string, body: string) => `---\nname: ${name}\ndescription: A project check.\n---\n\n${body}`;
    const files: Record<string, string> = {
      'AGENTS.md': 'Use the project rules.',
      'skills/beam-theory-check/SKILL.md': skill('beam-theory-check', 'First project instructions.'),
      'skills/project-check/SKILL.md': skill('project-check', 'A project-only skill.'),
    };
    const picker = vi.spyOn(project, 'pickFolder').mockResolvedValue(fakeDir(files));
    try {
      const browserProject = { id: 'saved-beam', name: 'Saved beam', at: 20, createdAt: 10, commands: 3, hash: 'saved-hash', thumbnail: null, saving: false, autosave: true };
      const { root, registry, store } = await mount({ project: browserProject });
      root.querySelector<HTMLButtonElement>('[data-cmd="folder.open"]')!.click();
      await vi.waitFor(() => expect(root.textContent).toContain('project-check'));
      expect(store.state.project).toBe(browserProject);
      expect(picker).toHaveBeenCalledTimes(1);
      // Full project I/O is #13: opening skills must not change file.save's download default.
      expect(await registry.query({ query: 'query.folder' })).toBeNull();
      const invoke = (name: string) => registry.dispatch({ cmd: 'skill.invoke', name });
      expect(await invoke('beam-theory-check')).toMatchObject({ source: 'project', body: 'First project instructions.' });
      await type(root, '/project');
      expect(root.querySelector('.popover')!.textContent).toContain('project-check');
      // Refresh changes the same ProjectFolder object and does not depend on AGENTS.md's mtime.
      const folder = store.state.folder;
      files['skills/beam-theory-check/SKILL.md'] = skill('beam-theory-check', 'Updated project instructions.');
      delete files['skills/project-check/SKILL.md'];
      files['skills/new-check/SKILL.md'] = skill('new-check', 'New skill instructions.');
      await registry.dispatch({ cmd: 'folder.refresh' });
      await tick();
      expect(store.state.folder).toBe(folder);
      expect(store.state.project).toBe(browserProject);
      expect(await invoke('beam-theory-check')).toMatchObject({ source: 'project', body: 'Updated project instructions.' });
      expect(root.querySelector('.chips')!.textContent).toContain('new-check');
      expect(root.querySelector('.chips')!.textContent).not.toContain('project-check');
      await type(root, '/new');
      expect(root.querySelector('.popover')!.textContent).toContain('new-check');
      await expect(invoke('project-check')).rejects.toMatchObject({ code: 'not-found' });
      const { buildTurn } = await import('../src/ai/context');
      const turn = await buildTurn({ text: '/beam-theory-check inspect', registry, skills: store.state.skills });
      expect(turn.message.content).toEqual([{ type: 'text', text: 'Skill beam-theory-check:\nUpdated project instructions.\n\ninspect' }]);

      const catalog = store.state.skills;
      const read = vi.spyOn(folder!, 'readText').mockRejectedValueOnce(new Error('folder permission lost'));
      await expect(registry.dispatch({ cmd: 'folder.refresh' })).rejects.toThrow('folder permission lost');
      read.mockRestore();
      expect(store.state.skills).toBe(catalog);
      expect(await invoke('beam-theory-check')).toMatchObject({ body: 'Updated project instructions.' });
      let release!: () => void;
      const inFlight = vi.spyOn(folder!, 'refresh').mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
      const pending = registry.dispatch({ cmd: 'folder.refresh' });
      await registry.dispatch({ cmd: 'folder.close' });
      release();
      await pending;
      inFlight.mockRestore();
      await tick();
      expect(root.textContent).toContain('open a project folder');
      expect(root.querySelector('.chips')!.textContent).not.toContain('new-check');
      expect(store.state.skills).toEqual(BUILTIN_SKILLS);
      expect(store.state.project).toBe(browserProject);
      expect(await invoke('beam-theory-check')).toMatchObject({ source: 'builtin', body: BUILTIN_SKILLS.find((s) => s.name === 'beam-theory-check')!.body });
      await expect(registry.dispatch({ cmd: 'folder.refresh' })).rejects.toMatchObject({ code: 'file.not-found', where: 'folder' });
    } finally { picker.mockRestore(); }

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

describe('Assistant queue and model controls', () => {
  beforeEach(() => {
    for (const root of [...document.body.children]) render(null, root as HTMLElement);
    document.body.innerHTML = '';
    chatBridge.pending = null;
    localStorage.clear();
    sessionStorage.clear();
    sessionStorage.setItem('femlab.ai.key', 'test-key');
  });

  it('preserves a missing-key draft and image until the key is saved and the person retries', async () => {
    localStorage.clear();
    sessionStorage.clear();
    const image = { type: 'image' as const, mediaType: 'image/png' as const, base64: 'AAAA', caption: 'reference' };
    const screenshot = vi.spyOn(context, 'screenshotBlock').mockResolvedValue(image);
    const seen: import('../src/ai/provider').Message[][] = [];
    const provider = vi.spyOn(anthropic, 'anthropicProvider').mockReturnValue({
      id: 'anthropic', models: ['test'],
      async *chat(req) { seen.push(structuredClone(req.messages)); yield { type: 'done', stopReason: 'end_turn' }; },
    });
    try {
      const { root } = await mount();
      root.querySelector<HTMLButtonElement>('button[data-cmd="query.screenshot"]')!.click();
      await tick();
      chatBridge.insertMention('body:beam');
      await tick();
      press(await type(root, 'build from this image'), 'Enter');
      await tick();
      expect(root.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('build from this image');
      expect(root.querySelector('.tokens .token')?.textContent).toContain('body:beam');
      expect(root.querySelector('.images img')?.getAttribute('src')).toContain('AAAA');
      expect(root.querySelector('.bubble')).toBeNull();
      expect(provider).not.toHaveBeenCalled();
      const key = root.querySelector<HTMLInputElement>('.settings input[type="password"]')!;
      key.value = 'test-key';
      key.dispatchEvent(new Event('input', { bubbles: true }));
      await tick();
      root.querySelector<HTMLButtonElement>('[data-cmd="ai.setKey"]')!.click();
      await tick();
      press(root.querySelector('textarea')!, 'Enter');
      await tick(); await tick();
      expect(seen).toHaveLength(1);
      expect(JSON.stringify(seen[0])).toContain('build from this image');
      expect(JSON.stringify(seen[0])).toContain('body:beam');
      expect(seen[0]![0]!.content).toContainEqual(image);
      expect(root.querySelector('.images img')).toBeNull();
    } finally { screenshot.mockRestore(); provider.mockRestore(); }
  });

  it('queues with Enter, then interrupts with empty Enter and starts the next message once', async () => {
    const seen: import('../src/ai/provider').ChatRequest[] = [];
    const provider = vi.spyOn(anthropic, 'anthropicProvider').mockReturnValue({
      id: 'anthropic', models: ['test'],
      async *chat(req) {
        seen.push(structuredClone({ ...req, signal: undefined }));
        if (seen.length === 1) {
          yield { type: 'text_delta', text: 'First tokens' };
          yield { type: 'tool_progress', id: 'draft', name: 'query_model', arguments: '{' };
          await new Promise<void>(resolve => req.signal!.addEventListener('abort', () => resolve(), { once: true }));
          return;
        }
        yield { type: 'text_delta', text: 'Next answer' };
        yield { type: 'done', stopReason: 'end_turn' };
      },
    });
    try {
      const { root } = await mount();
      press(await type(root, 'first'), 'Enter');
      await tick(); await tick();
      expect(root.querySelector('[data-status="preparing"]')?.textContent).toContain('{');
      press(await type(root, 'second'), 'Enter');
      await tick();
      expect(seen).toHaveLength(1);
      expect(root.querySelector('.queued')?.textContent).toContain('second');
      expect(root.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('');
      press(root.querySelector('textarea')!, 'Enter');
      await tick(); await tick();
      expect(seen).toHaveLength(2);
      expect(root.querySelector('.queued')).toBeNull();
      expect(root.querySelector('[data-status="cancelled"]')).not.toBeNull();
      expect(root.querySelectorAll('.bubble')).toHaveLength(2);
      expect(root.textContent).toContain('Next answer');
      expect(JSON.stringify(seen[1]!.messages)).not.toContain('tool_use');
      expect(JSON.stringify(seen[1]!.messages)).toContain('Response interrupted');
    } finally { provider.mockRestore(); }
  });

  it('drains queued messages in order after ordinary completion, preserving the next draft', async () => {
    let release!: () => void;
    const paused = new Promise<void>(resolve => { release = resolve; });
    const seen: string[] = [];
    const provider = vi.spyOn(anthropic, 'anthropicProvider').mockReturnValue({
      id: 'anthropic', models: ['test'],
      async *chat(req) {
        seen.push(JSON.stringify(req.messages.at(-1)));
        if (seen.length === 1) await paused;
        yield { type: 'text_delta', text: 'Done' };
        yield { type: 'done', stopReason: 'end_turn' };
      },
    });
    try {
      const { root } = await mount();
      chatBridge.send('first');
      chatBridge.send('second');
      chatBridge.send('third');
      await tick();
      expect(seen).toHaveLength(1);
      await type(root, 'unsent draft');
      release();
      await tick(); await tick();
      expect(seen).toHaveLength(3);
      expect(seen[1]).toContain('second');
      expect(seen[2]).toContain('third');
      expect(root.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('unsent draft');
    } finally { release(); provider.mockRestore(); }
  });

  it('shows the model selector without Settings and routes UI and registry changes to the next request', async () => {
    const seen: string[] = [];
    const provider = vi.spyOn(anthropic, 'anthropicProvider').mockReturnValue({
      id: 'anthropic', models: ['claude-haiku-4-5'],
      async *chat(req) { seen.push(req.model); yield { type: 'done', stopReason: 'end_turn' }; },
    });
    try {
      const { root, registry } = await mount();
      expect(root.querySelector('.settings')).toBeNull();
      const select = root.querySelector<HTMLSelectElement>('[data-cmd="ai.setModel"]')!;
      select.value = 'claude-haiku-4-5';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await paint(); await tick();
      expect(localStorage.getItem('femlab.ai.model')).toBe('claude-haiku-4-5');
      press(await type(root, 'hello'), 'Enter');
      await tick(); await tick();
      expect(seen).toEqual(['claude-haiku-4-5']);
      await registry.dispatch({ cmd: 'ai.setModel', model: 'gpt-5.4-mini' });
      await paint(); await tick();
      expect(select.value).toBe('gpt-5.4-mini');
      render(null, root);
      const remounted = await mount();
      expect(remounted.root.querySelector<HTMLSelectElement>('[data-cmd="ai.setModel"]')!.value).toBe('gpt-5.4-mini');
    } finally { provider.mockRestore(); }
  });
});
