// The assistant drawer of docs/design/README.md. It owns the conversation (never persisted, never
// journaled) and nothing else: every effect it has on the Model goes through `registry.dispatch`,
// and every clickable carries the `data-cmd` of the Command behind it, so `test/data-cmd.test.tsx`
// holds this panel against `registry.list()` the same way it holds the shell.
import { FemError, parseMentions, toToolDefinitions, type JournalEntry, type Registry } from '@femlab/registry';
import type { ComponentChildren } from 'preact';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Store, UiState } from '../store';
import { runTurn, undoTurn, type ToolCall, type TurnResult } from './agent';
import { anthropicProvider } from './anthropic';
import './assistant.css';
import { buildSystem, buildTurn, downscaleImage, objectIndex, parseVerification, screenshotBlock, type IndexEntry, type VerifyRow } from './context';
import { defaultProvider, maskKey, MODELS, resolveKey, storedModel, storeKey } from './keys';
import { openaiProvider } from './openai';
import { ProjectFolder, pickFolder, projectSkills, watchAgents, type DirHandle } from './project';
import type { ImageBlock, Message, Provider, ProviderId } from './provider';
import { BUILTIN_SKILLS } from './skills';

export interface AssistantPanelProps {
  registry: Registry;
  store: Store;
  /** Collapse keeps local conversation state and active tool calls alive. */
  hidden?: boolean;
  /**
   * Accepted for symmetry with the rest of the shell and unused: the panel reaches the engine
   * through the registry and nothing else, which is what makes a remote host a transport change.
   */
  transport?: unknown;
}

/** What `chat.send`, `chat.insertMention` and `chat.clear` do once this panel is mounted. Wire the
 *  app's `HostContext.chat` to it in one line and those Commands work from a script and the palette.
 *
 *  Before the panel is mounted `send` keeps the line in `pending` instead of dropping it, and the
 *  panel drains it the moment it mounts (issue #40). Without that, "open the drawer, then
 *  `chat.send`" is a race that both callers lose: the start screen's composer and the error card's
 *  "Send this error to the Assistant" each toggle the panel and send in the same tick. */
export const chatBridge = {
  /** The one line a `chat.send` before the drawer left behind; the panel takes it on mount. */
  pending: null as string | null,
  pendingDraft: null as string | null,
  setDraft: (text: string): void => { chatBridge.pendingDraft = text; },
  send: (text: string): void => {
    chatBridge.pending = text;
  },
  insertMention: (ref: string): void => void ref,
  clear: (): void => {
    chatBridge.pending = null;
  },
};

/** What `chatBridge.send` goes back to when the panel unmounts: buffer again, never a no-op. */
const buffer = (text: string): void => {
  chatBridge.pending = text;
};

type Item =
  | { kind: 'user'; text: string; images: ImageBlock[] }
  | { kind: 'prose'; text: string }
  | { kind: 'verify'; rows: VerifyRow[] }
  | { kind: 'skill'; name: string; note: string }
  | { kind: 'tool'; call: ToolCall }
  | { kind: 'diff'; entries: JournalEntry[]; steps: number; journal: string | null }
  | { kind: 'files'; files: string[] }
  | { kind: 'bad'; text: string };

const WROTE = new Set(['file.write', 'file.save', 'file.export']);
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

function useStore(store: Store): UiState {
  const [state, setState] = useState(store.state);
  useEffect(() => store.subscribe(() => setState(store.state)), [store]);
  return state;
}

/** Every clickable in the drawer: one Command name, one `data-cmd`, errors shown not thrown. */
function Cmd({ cmd, run, children, ...rest }: { cmd: string; run: () => void | Promise<unknown>; children: ComponentChildren; class?: string; title?: string; disabled?: boolean; pressed?: boolean }) {
  return (
    <button
      type="button"
      data-cmd={cmd}
      class={rest.class}
      title={rest.title ?? cmd}
      disabled={rest.disabled ?? false}
      {...(rest.pressed === undefined ? {} : { 'aria-pressed': rest.pressed })}
      onClick={() => void Promise.resolve(run()).catch(() => undefined)}
    >
      {children}
    </button>
  );
}

/** A draft-editing affordance (remove a chip, remove an image). No Command exists for editing an
 *  unsent line, and inventing one would be a lie in `data-cmd`, so these are not buttons. */
const X = ({ onRemove, label }: { onRemove: () => void; label: string }) => (
  <span class="x" role="button" tabIndex={0} aria-label={label} onClick={onRemove} onKeyDown={(e) => e.key === 'Enter' && onRemove()}>
    ×
  </span>
);

/** `@face:beam.top` in a user bubble is drawn as the chip it was typed as. */
function withRefs(text: string) {
  return text.split(/(@[a-z]+:[^\s,;)]+|@selection\b)/g).map((part, i) => (part.startsWith('@') ? <span class="ref" key={i}>{part}</span> : part));
}

function ToolCard({ call }: { call: ToolCall }) {
  return (
    <div class={`card${call.status === 'failed' ? ' bad' : ''}`} data-status={call.status}>
      <div class="head">
        <span class={call.status === 'pending' ? 'tool-pending' : call.status === 'succeeded' ? 'ok' : 'fail'} role="img" aria-label={call.status === 'pending' ? 'Running' : call.status === 'succeeded' ? 'Succeeded' : 'Failed'}>
          {call.status === 'pending' ? '' : call.status === 'succeeded' ? '✓' : '✕'}
        </span>
        <span class="cmd">{call.command}</span>
        <span class="ms">{call.status === 'pending' ? '…' : `${call.ms} ms`}</span>
      </div>
      <div class="args">{JSON.stringify(call.input)}</div>
      {call.result ? <div class="out">{call.result.slice(0, 400)}</div> : null}
    </div>
  );
}

export function AssistantPanel({ registry, store, hidden = false }: AssistantPanelProps) {
  const ui = useStore(store);
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState('');
  const [streaming, setStreaming] = useState('');
  const [draft, setDraft] = useState('');
  const [tokens, setTokens] = useState<string[]>([]);
  const [images, setImages] = useState<ImageBlock[]>([]);
  const [index, setIndex] = useState<IndexEntry[]>([]);
  const [folder, setFolder] = useState<ProjectFolder | null>(null);
  const [provider, setProvider] = useState<ProviderId>(() => defaultProvider());
  const [model, setModel] = useState(() => storedModel(defaultProvider()));
  const [keyDraft, setKeyDraft] = useState('');
  const [turn, setTurn] = useState<TurnResult | null>(null);
  const messages = useRef<Message[]>([]);
  const composer = useRef<HTMLTextAreaElement>(null);
  const focusDraft = useRef(false);
  useLayoutEffect(() => {
    if (focusDraft.current && !hidden) {
      composer.current?.focus();
      focusDraft.current = false;
    }
  });

  const key = resolveKey(provider);
  const openPanel = (name: string, fallback = false) => ui.panels[`assistant.${name}`] ?? fallback;
  const dispatch = useCallback((cmd: { cmd: string } & Record<string, unknown>) => registry.dispatch(cmd), [registry]);

  const skills = useMemo(() => projectSkills(BUILTIN_SKILLS, folder), [folder]);
  const enabled = skills.filter((s) => ui.panels[`skill:${s.name}`] !== false);

  const add = (item: Item) => setItems((cur) => [...cur, item]);

  // The project folder's AGENTS.md changes under us whenever the person edits it in their editor.
  useEffect(() => (folder ? watchAgents(folder, () => setFolder(folder)) : undefined), [folder]);

  const openFolder = async () => {
    let handle: DirHandle;
    try {
      // The host Command owns this when the app wires it; until then the panel opens it itself.
      await dispatch({ cmd: 'project.open', picker: true });
      return;
    } catch {
      handle = await pickFolder();
    }
    setFolder(await ProjectFolder.fromHandle(handle));
  };

  const insert = (ref: string) => {
    setTokens((cur) => (cur.includes(ref) ? cur : [...cur, ref]));
    store.togglePanel('assistant.mentions', false);
  };

  const attach = async (blob: Blob) => {
    try {
      const image = await downscaleImage(blob);
      setImages((cur) => [...cur, image]);
    } catch (e) {
      add({ kind: 'bad', text: e instanceof FemError ? e.cause : String(e) });
    }
  };

  const send = useCallback(
    async (text: string) => {
      const line = text.trim();
      if (!line || busy) return;
      const providerImpl: Provider = provider === 'anthropic' ? anthropicProvider(key.key ?? '') : openaiProvider(key.key ?? '');
      if (!key.key) {
        add({ kind: 'bad', text: `no ${provider} API key yet — open Settings and paste one; it stays in this browser` });
        store.togglePanel('assistant.settings', true);
        return;
      }
      const attached = images;
      setDraft('');
      setTokens([]);
      setImages([]);
      setBusy('thinking…');
      add({ kind: 'user', text: line, images: attached });
      let prose = '';
      const finishProse = () => {
        if (prose.trim()) flushProse(prose, add);
        prose = '';
        setStreaming('');
      };
      try {
        const built = await buildTurn({ text: line, registry, images: attached, selection: ui.selection, skills });
        if (built.skill) add({ kind: 'skill', name: built.skill, note: 'loaded into this turn' });
        for (const bad of built.unresolved) add({ kind: 'bad', text: `${bad.ref}: ${bad.cause}` });
        messages.current.push(built.message);

        const system = buildSystem({ registry, skills: enabled, project: folder ? { name: folder.name, files: folder.files, agentsMd: folder.agentsMd } : null });
        for await (const event of runTurn({ provider: providerImpl, registry, model, system, tools: toToolDefinitions(registry), messages: messages.current })) {
          if (event.type === 'text') {
            prose += event.text;
            setStreaming(streamingProse(prose));
            setBusy('writing…');
          } else if (event.type === 'tool_start') {
            finishProse();
            setBusy(`${event.call.command}…`);
            add({ kind: 'tool', call: event.call });
          } else if (event.type === 'tool_end') {
            setItems((cur) => cur.map((i) => (i.kind === 'tool' && i.call.id === event.call.id ? { kind: 'tool', call: { ...event.call } } : i)));
          } else if (event.type === 'error') {
            finishProse();
            add({ kind: 'bad', text: event.message });
          } else if (event.type === 'turn') {
            finishProse();
            const wrote = event.turn.calls.filter((c) => c.status === 'succeeded' && WROTE.has(c.command)).map((c) => String((c.input as { path?: string; name?: string })?.path ?? (c.input as { name?: string })?.name ?? c.command));
            if (wrote.length > 0) add({ kind: 'files', files: wrote });
            if (event.turn.diff.length > 0) add({ kind: 'diff', entries: event.turn.diff, steps: event.turn.undoSteps, journal: event.turn.undoJournal });
            setTurn(event.turn);
          }
        }
        await refreshIndex();
      } catch (e) {
        finishProse();
        add({ kind: 'bad', text: e instanceof FemError ? `${e.code}: ${e.cause}` : String(e) });
      } finally {
        finishProse();
        setBusy('');
      }
    },
    [busy, provider, key.key, images, registry, ui.selection, skills, enabled, folder, model, store],
  );

  const refreshIndex = useCallback(async () => {
    setIndex(await objectIndex(registry).catch(() => []));
  }, [registry]);

  // `chat.send` from a script, the palette or a viewer click reaches the same code the Send button
  // does — including one that arrived before this panel existed, which is what `pending` holds.
  useEffect(() => {
    chatBridge.send = (text) => {
      store.togglePanel('assistant', true);
      void send(text);
    };
    chatBridge.setDraft = (text) => {
      store.togglePanel('assistant', true);
      setDraft(text);
      store.togglePanel('assistant.skills', false);
      focusDraft.current = true;
    };
    if (chatBridge.pendingDraft !== null) {
      chatBridge.setDraft(chatBridge.pendingDraft);
      chatBridge.pendingDraft = null;
    }
    chatBridge.insertMention = insert;
    chatBridge.clear = () => {
      chatBridge.pending = null;
      messages.current = [];
      setItems([]);
      setStreaming('');
      setTurn(null);
    };
    const queued = chatBridge.pending;
    chatBridge.pending = null;
    if (queued !== null) void send(queued);
    return () => {
      chatBridge.send = buffer;
      chatBridge.setDraft = (text) => { chatBridge.pendingDraft = text; };
    };
  });

  const query = draft.startsWith('@') ? draft.slice(1) : '';
  const shown = index.filter((e) => !query || e.ref.toLowerCase().includes(query.toLowerCase()));
  const slash = /^\/(\S*)$/.exec(draft);
  const skillMenu = openPanel('skills') ? enabled : slash ? enabled.filter((s) => s.name.startsWith(slash[1]!)) : [];

  const compose = () => [draft, ...tokens.map((t) => `@${t}`)].join(' ').trim();
  const rules = folder?.agentsMd?.text.split('\n').filter((l) => l.trim()) ?? [];

  return (
    <aside class="assistant" hidden={hidden}>
      <header>
        <span class="ring">✳</span>
        <span class="title">Assistant</span>
        <span class="note">shares this Model</span>
        <span class="grow" />
        <Cmd cmd="panel.toggle" title="Settings" run={() => store.togglePanel('assistant.settings')}>
          ⚙
        </Cmd>
        <Cmd cmd="chat.clear" title="Start a new conversation" run={() => chatBridge.clear()}>
          ⟲
        </Cmd>
        <Cmd cmd="panel.toggle" title="Close the assistant" run={() => store.togglePanel('assistant', false)}>
          ×
        </Cmd>
      </header>

      <div class="strip">
        {folder ? (
          <Cmd cmd="panel.toggle" class="agents" title="The project rules in force" run={() => store.togglePanel('assistant.rules')}>
            <span class="mono">{openPanel('rules') ? '▾' : '▸'}</span>
            <span class="file">{folder.agentsMd?.file ?? 'no AGENTS.md'}</span>
            <span class="count">{folder.agentsMd ? `${rules.length} project rules in force` : 'no project rules'}</span>
            <span class="paths">/{folder.name}</span>
          </Cmd>
        ) : (
          <Cmd cmd="project.open" class="agents" title="Open a project folder" run={openFolder}>
            <span class="mono">＋</span>
            <span class="file">open a project folder</span>
            <span class="count">for AGENTS.md, skills and files</span>
          </Cmd>
        )}
        {folder && openPanel('rules') ? <div class="rules">{folder.agentsMd?.text}</div> : null}
        <div class="chips">
          <span class="section-label">Skills</span>
          {skills.map((s) => {
            const on = ui.panels[`skill:${s.name}`] !== false;
            return (
              <Cmd key={s.name} cmd="panel.toggle" title={s.description} pressed={on} run={() => store.togglePanel(`skill:${s.name}`, !on)}>
                <span class="dot" />
                <span>{s.name}</span>
              </Cmd>
            );
          })}
        </div>
      </div>

      <div class="messages">
        {items.map((item, i) => (
          <Item key={i} item={item} registry={registry} dispatch={dispatch} />
        ))}
        {streaming ? <div class="prose streaming">{streaming}</div> : null}
        {busy ? (
          <div class="thinking">
            <i />
            <span>{busy}</span>
          </div>
        ) : null}
      </div>

      <div class="composer">
        {openPanel('mentions') || query ? (
          <div class="popover">
            <div class="hint">@{query} — reference anything in the Model, the Journal or the project folder</div>
            <div class="list">
              {shown.slice(0, 40).map((entry) => (
                <Cmd key={entry.ref} cmd="chat.insertMention" title={entry.summary} run={() => insert(entry.ref)}>
                  <span class="kind">{entry.kind}</span>
                  <span class="name">{entry.name}</span>
                  <span class="meta">{entry.summary}</span>
                </Cmd>
              ))}
            </div>
          </div>
        ) : null}
        {skillMenu.length > 0 ? (
          <div class="popover">
            <div class="hint">/{slash?.[1] ?? 'skill'} — a skill is loaded into the turn it is used in</div>
            <div class="list">
              {skillMenu.map((s) => (
                <Cmd key={s.name} cmd="chat.setDraft" title={s.description} run={() => dispatch({ cmd: 'chat.setDraft', text: `/${s.name} ${draft.replace(/^\/\S*\s*/, '')}` })}>
                  <span class="kind">{s.source}</span>
                  <span class="name">{s.name}</span>
                  <span class="meta">{s.description}</span>
                </Cmd>
              ))}
            </div>
          </div>
        ) : null}

        {images.length > 0 ? (
          <div class="images">
            {images.map((img, i) => (
              <span class="image" key={i}>
                <img src={`data:${img.mediaType};base64,${img.base64}`} alt="" />
                <input
                  placeholder="caption"
                  value={img.caption ?? ''}
                  onInput={(e) => setImages((cur) => cur.map((c, j) => (i === j ? { ...c, caption: (e.target as HTMLInputElement).value } : c)))}
                />
                <X label="remove the image" onRemove={() => setImages((cur) => cur.filter((_, j) => j !== i))} />
              </span>
            ))}
          </div>
        ) : null}

        <div class="suggestions" aria-label="Prompt suggestions">
          {(items.some((item) => item.kind === 'user')
            ? [{ label: 'Check this Model', text: 'Inspect the current Model and identify checks to run before trusting its results.' }, { label: 'Explain the next step', text: 'Explain the next useful modeling or verification step and why.' }]
            : [{ label: 'Build a cantilever', text: 'Help me build a cantilever beam. Ask for the dimensions, material and load that you need.' }, { label: 'Inspect this Model', text: 'Inspect the current Model and explain its geometry, materials, boundary conditions and loads.' }]
          ).map((suggestion) => <Cmd key={suggestion.label} cmd="chat.setDraft" disabled={busy !== ''} run={() => dispatch({ cmd: 'chat.setDraft', text: suggestion.text })}>{suggestion.label}</Cmd>)}
        </div>

        <div class="box">
          <div class="tokens">
            {tokens.map((t) => (
              <span class="token" key={t}>
                <span>@{t}</span>
                <X label={`remove ${t}`} onRemove={() => setTokens((cur) => cur.filter((c) => c !== t))} />
              </span>
            ))}
            <textarea
              ref={composer}
              rows={1}
              placeholder={items.length === 0 ? 'Describe the model, or ask for a check…' : 'Reply, or ask for the next step…'}
              value={draft}
              onFocus={refreshIndex}
              onInput={(e) => setDraft((e.target as HTMLTextAreaElement).value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send(compose());
                }
              }}
              onPaste={(e) => {
                const file = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'))?.getAsFile();
                if (file) {
                  e.preventDefault();
                  void attach(file);
                  return;
                }
                const text = e.clipboardData?.getData('text/plain') ?? '';
                const { chips } = parseMentions(text);
                if (chips.length > 0 && chips.map((c) => `@${c.ref}`).join(' ') === text.trim()) {
                  e.preventDefault();
                  chips.forEach((c) => insert(c.ref));
                }
              }}
              onDrop={(e) => {
                const file = e.dataTransfer?.files?.[0];
                const ref = e.dataTransfer?.getData('text/plain') ?? '';
                if (file?.type.startsWith('image/')) {
                  e.preventDefault();
                  void attach(file);
                } else if (parseMentions(ref).chips.length > 0) {
                  e.preventDefault();
                  parseMentions(ref).chips.forEach((c) => insert(c.ref));
                }
              }}
            />
          </div>
          <div class="bar">
            <Cmd cmd="panel.toggle" class="at" title="Reference a Model object, a file or a Result" run={() => void refreshIndex().then(() => store.togglePanel('assistant.mentions'))}>
              @
            </Cmd>
            <Cmd cmd="chat.insertMention" title="Reference the current selection" disabled={ui.selection.refs.length === 0} run={() => ui.selection.refs.forEach(insert)}>
              @selection
            </Cmd>
            <Cmd cmd="panel.toggle" title="Choose a skill for this draft" disabled={busy !== ''} run={() => dispatch({ cmd: 'panel.toggle', panel: 'assistant.skills' })}>
              /skill
            </Cmd>
            <Cmd
              cmd="query.screenshot"
              title="Attach the current view as an image"
              run={async () => {
                const view = await screenshotBlock(registry);
                setImages((cur) => [...cur, view]);
              }}
            >
              view
            </Cmd>
            <label title="Attach an image (PNG, JPEG or WebP)">
              image
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(e) => {
                  const file = (e.target as HTMLInputElement).files?.[0];
                  if (file) void attach(file);
                }}
              />
            </label>
            <Cmd cmd="chat.send" class="send" disabled={busy !== '' || compose() === ''} run={() => send(compose())}>
              Send
            </Cmd>
          </div>
        </div>

        <div class="cost">
          <span>{turn ? `this turn: ${turn.calls.length} commands · ${turn.skills.length} skills · ${seconds(turn.ms)}${turn.cost === null ? '' : ` · $${turn.cost.toFixed(3)}`}` : `${model} · ${skills.length} skills`}</span>
          <span>{key.source === 'stored' ? 'key stored in this browser' : key.source === 'dev' ? 'key from the dev server' : 'no key yet'}</span>
        </div>
      </div>

      {openPanel('settings') ? (
        <div class="settings">
          <label>
            <span>Provider</span>
            <select
              value={provider}
              onChange={(e) => {
                const next = (e.target as HTMLSelectElement).value as ProviderId;
                setProvider(next);
                setModel(storedModel(next));
              }}
            >
              <option value="anthropic">Anthropic</option>
              <option value="openai">OpenAI</option>
            </select>
          </label>
          <label>
            <span>Model</span>
            <select
              data-cmd="ai.setModel"
              value={model}
              onChange={(e) => {
                const next = (e.target as HTMLSelectElement).value;
                setModel(next);
                void dispatch({ cmd: 'ai.setModel', model: next }).catch(() => undefined);
              }}
            >
              {MODELS[provider].map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>API key</span>
            <input type="password" placeholder={key.key ? maskKey(key.key) : `paste your ${provider} key`} value={keyDraft} onInput={(e) => setKeyDraft((e.target as HTMLInputElement).value)} />
            <Cmd
              cmd="ai.setKey"
              title="Keep this key in this browser only"
              run={() => {
                storeKey(provider, keyDraft || null);
                setKeyDraft('');
                setProvider(provider);
              }}
            >
              {keyDraft ? 'save' : 'forget'}
            </Cmd>
          </label>
          <span class="source">
            {key.source === 'stored' ? 'from localStorage in this browser' : key.source === 'dev' ? 'from the dev server’s shell environment; never in a build' : 'no key: the assistant cannot send anything'}
          </span>
        </div>
      ) : null}
    </aside>
  );
}

/** Keep verification markup private while its tag or block is still arriving. */
function streamingProse(text: string): string {
  let visible = parseVerification(text).prose.replace(/<verification>[\s\S]*$/i, '');
  const start = visible.lastIndexOf('<');
  if (start >= 0 && '<verification>'.startsWith(visible.slice(start).toLowerCase())) visible = visible.slice(0, start);
  return visible;
}

/** Prose is split on its `<verification>` block, so the card and the sentences both survive. */
function flushProse(text: string, add: (item: Item) => void): void {
  const { rows, prose } = parseVerification(text);
  if (prose) add({ kind: 'prose', text: prose });
  if (rows.length > 0) add({ kind: 'verify', rows });
}

function Item({ item, registry, dispatch }: { item: Item; registry: Registry; dispatch: (cmd: { cmd: string } & Record<string, unknown>) => Promise<unknown> }) {
  const [undoState, setUndoState] = useState<'ready' | 'pending' | 'done' | 'failed'>('ready');
  const [undoError, setUndoError] = useState('');
  if (item.kind === 'user') {
    return (
      <div class="bubble">
        {withRefs(item.text)}
        {item.images.map((img, i) => (
          <img key={i} src={`data:${img.mediaType};base64,${img.base64}`} alt={img.caption ?? ''} style="display:block;margin-top:6px;max-width:100%;border-radius:3px" />
        ))}
      </div>
    );
  }
  if (item.kind === 'prose') return <div class="prose">{item.text}</div>;
  if (item.kind === 'bad') return <div class="bad-line">{item.text}</div>;
  if (item.kind === 'tool') return <ToolCard call={item.call} />;
  if (item.kind === 'skill') {
    return (
      <div class="skill-card">
        <span class="warn">◆</span>
        <span class="name">skill: {item.name}</span>
        <span>{item.note}</span>
      </div>
    );
  }
  if (item.kind === 'verify') {
    return (
      <div class="card verify">
        <div class="head">
          <span>◎</span>
          <span>VERIFICATION</span>
        </div>
        <div class="rows">
          {item.rows.map((row, i) => (
            <div key={i}>
              <span class={`icon ${row.status}`}>{row.status === 'ok' ? '✓' : row.status === 'warn' ? '!' : '✕'}</span>
              <span class="what">{row.what}</span>
              <span class={`val ${row.status}`}>{row.value}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }
  if (item.kind === 'files') {
    return (
      <div class="card">
        <div class="head">Wrote {item.files.length} files</div>
        {item.files.map((path) => (
          <div class="files-row" key={path}>
            <span class="path">{path}</span>
            <Cmd cmd="clipboard.copy" title="Copy the path" run={() => dispatch({ cmd: 'clipboard.copy', what: { kind: 'text', text: path } })}>
              copy
            </Cmd>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div class="card diff">
      <div class="head">
        <span>Journal diff · this turn</span>
        <Cmd cmd="journal.undo" class="undo" title="Take the whole turn back" disabled={undoState !== 'ready' || item.steps === 0} run={async () => {
          setUndoState('pending');
          try {
            await undoTurn(registry, item.steps, item.journal);
            setUndoState('done');
          } catch (e) {
            setUndoState('failed');
            setUndoError(e instanceof FemError ? e.cause : String(e));
          }
        }}>
          {undoState === 'done' ? 'Turn undone' : undoState === 'pending' ? 'Undoing…' : 'Undo turn'}
        </Cmd>
      </div>
      {undoError ? <div class="bad-line">{undoError} — inspect the Journal before undoing later changes.</div> : null}
      {item.journal === null ? <div class="mark">{item.entries.some((entry) => entry.cmd.cmd === 'model.new') ? 'This turn created or reset the Model; the engine cannot undo that boundary.' : 'A complete turn boundary could not be verified. Undo individual Commands in the Journal.'}</div> : null}
      <div class="lines">
        <div class="mark">— turn start —</div>
        {item.entries.map((entry) => (
          <div class="add" key={entry.seq}>
            + {entry.seq} {entry.cmd.cmd}
          </div>
        ))}
      </div>
    </div>
  );
}
