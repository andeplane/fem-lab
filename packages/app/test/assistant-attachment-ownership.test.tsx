import { EMPTY_ACCOUNT, FemError, HOST_COMMANDS, Registry, type AccountState, type EngineSchema, type EngineTransport } from '@femlab/registry';
import { render } from 'preact';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fakeTransport } from '../../registry/test/fakes';
import schema from '../../registry/src/generated/engine.schema.json';
import { appHostCommands, makeHostContext } from '../src/host';
import { readHostCaps } from '../src/capabilities';
import { Store } from '../src/store';
import { bindRegistryProducer } from '../src/producer-registry';
import { AssistantPanel, chatBridge } from '../src/ai/AssistantPanel';
import * as context from '../src/ai/context';
import * as hosted from '../src/ai/hosted';
import type { ImageBlock, Message } from '../src/ai/provider';

const account = vi.hoisted(() => ({ state: {} as AccountState, version: 0, token: vi.fn(), refresh: vi.fn(async () => undefined) }));
vi.mock('../src/account/browser', () => ({ accounts: account }));
const image: ImageBlock = { type: 'image', mediaType: 'image/png', base64: 'OWNER_A_IMAGE', caption: 'private A reference' };
const paint = () => new Promise<void>(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, bad) => { resolve = ok; reject = bad; });
  return { promise, resolve, reject };
}
function identity(uid: string) {
  account.version++;
  account.state = { ...EMPTY_ACCOUNT, configured: true, uid, email: `${uid}@example.invalid`, status: 'active', disclosureAccepted: true };
}
function session() {
  const store = new Store();
  store.set({ ready: true, account: account.state });
  const transport = fakeTransport();
  transport.query = (async (q: { query: string }) => q.query === 'query.objects' ? { objects: [] }
    : q.query === 'query.results' ? { records: [] } : { entries: [], revision: 0 }) as EngineTransport['query'];
  const viewer = { current: null };
  const host = makeHostContext(store, transport, viewer, readHostCaps({}));
  host.chat.send = text => chatBridge.send(text);
  host.chat.clear = () => chatBridge.clear();
  const registry = new Registry({ schema: schema as unknown as EngineSchema, host,
    hostCommands: [...HOST_COMMANDS, ...appHostCommands(store, transport, viewer, async () => undefined)] });
  bindRegistryProducer(registry, async () => ({ registry, signal: new AbortController().signal, store: () => store, release: async () => undefined }));
  return { store, registry };
}
async function mount() {
  const owner = session(), root = document.createElement('div'); document.body.append(root);
  const draw = (next = owner, hidden = false) => render(<AssistantPanel {...next} hidden={hidden} />, root);
  draw(); await paint();
  return { ...owner, root, draw };
}
type Producer = 'image input' | 'paste' | 'drop' | 'view button' | 'view mention';
const producers: Producer[] = ['image input', 'paste', 'drop', 'view button', 'view mention'];
const imageProducer = (producer: Producer) => ['image input', 'paste', 'drop'].includes(producer);
async function start(root: HTMLElement, store: Store, producer: Producer) {
  const file = new File(['local'], 'reference.png', { type: 'image/png' });
  if (producer === 'image input') {
    const input = root.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    input.dispatchEvent(new Event('change', { bubbles: true }));
  } else if (producer === 'paste' || producer === 'drop') {
    // Like the existing tree drag tests, use Preact's fallback casing for Happy DOM's missing ondrop property.
    const event = producer === 'drop' ? new DragEvent('Drop', { bubbles: true, cancelable: true }) : new Event('paste', { bubbles: true, cancelable: true });
    const transfer = new DataTransfer(); transfer.items.add(file);
    Object.defineProperty(event, producer === 'paste' ? 'clipboardData' : 'dataTransfer', { value: producer === 'paste'
      ? { items: [{ type: file.type, getAsFile: () => file }] } : transfer });
    root.querySelector('textarea')!.dispatchEvent(event);
  } else if (producer === 'view button') root.querySelector<HTMLButtonElement>('.bar [data-cmd="query.screenshot"]')!.click();
  else {
    store.togglePanel('assistant.mentions', true); await paint();
    root.querySelector<HTMLButtonElement>('.popover [data-cmd="query.screenshot"]')!.click();
  }
}
async function cross(owner: Awaited<ReturnType<typeof mount>>, transition: string) {
  if (transition.startsWith('account')) {
    for (const uid of transition === 'account A-B-A' ? ['B', 'A'] : ['B']) {
      identity(uid); owner.store.set({ account: account.state }); await paint();
    }
  } else {
    owner.draw(session()); await paint();
    if (transition === 'session A-B-A') { owner.draw(); await paint(); }
  }
}
beforeEach(() => {
  expect(__HOSTED_AI__, 'these regressions execute the hosted identity branch').toBe(true);
  identity('A'); chatBridge.pending = null; chatBridge.pendingDraft = null; chatBridge.pendingMentions = [];
  account.refresh.mockClear();
});
afterEach(() => {
  for (const root of [...document.body.children]) render(null, root as HTMLElement);
  document.body.innerHTML = ''; vi.restoreAllMocks();
});

for (const producer of producers) {
  it.each(['account A-B', 'account A-B-A', 'session A-B', 'session A-B-A'])(`discards a pending ${producer} after %s without remounting the panel`, async transition => {
    const pending = deferred<ImageBlock>();
    const read = vi.spyOn(context, imageProducer(producer) ? 'downscaleImage' : 'screenshotBlock').mockReturnValue(pending.promise);
    const owner = await mount(), panel = owner.root.querySelector('.assistant');
    await start(owner.root, owner.store, producer);
    expect(read).toHaveBeenCalledOnce();
    await cross(owner, transition);
    expect(owner.root.querySelector('.assistant'), 'the same standalone panel survives the ownership transition').toBe(panel);
    expect(owner.root.querySelector('.images img')).toBeNull();
    pending.resolve(image); await paint();
    expect(owner.root.querySelector('.images img')).toBeNull();
    expect(owner.root.textContent).not.toContain(image.caption);
  });

  it.each(['account A-B', 'account A-B-A', 'session A-B', 'session A-B-A'])(`discards a pending ${producer} error after %s`, async transition => {
    const pending = deferred<ImageBlock>();
    vi.spyOn(context, imageProducer(producer) ? 'downscaleImage' : 'screenshotBlock').mockReturnValue(pending.promise);
    const owner = await mount(); await start(owner.root, owner.store, producer);
    await cross(owner, transition);
    pending.reject(new Error('PRIVATE_A_ATTACHMENT_ERROR')); await paint();
    expect(owner.root.textContent).not.toContain('PRIVATE_A_ATTACHMENT_ERROR');
    expect(owner.root.querySelector('.bad-line')).toBeNull();
    expect(owner.root.querySelector('.images img')).toBeNull();
  });

  it(`keeps a same-owner ${producer} through profile refresh/collapse and includes its edited caption in Send`, async () => {
    const pending = deferred<ImageBlock>();
    vi.spyOn(context, imageProducer(producer) ? 'downscaleImage' : 'screenshotBlock').mockReturnValue(pending.promise);
    const seen: Message[][] = [];
    vi.spyOn(hosted, 'hostedProvider').mockReturnValue({ id: 'openai', models: ['gpt-5.4-mini'],
      async *chat(request) { seen.push(structuredClone(request.messages)); yield { type: 'done', stopReason: 'end_turn' }; } });
    const owner = await mount(); await start(owner.root, owner.store, producer);
    account.state = { ...account.state, message: 'Profile refreshed' }; owner.store.set({ account: account.state });
    owner.draw(owner, true); await paint(); pending.resolve(image); await paint(); owner.draw(); await paint();
    expect(owner.root.querySelector('.images img')?.getAttribute('src')).toContain(image.base64);
    const caption = owner.root.querySelector<HTMLInputElement>('.image input')!;
    caption.value = 'Current owner caption'; caption.dispatchEvent(new Event('input', { bubbles: true })); await paint();
    chatBridge.send('Use my current attachment');
    await vi.waitFor(() => expect(seen, owner.root.textContent ?? '').toHaveLength(1));
    expect(seen[0]![0]!.content).toContainEqual({ ...image, caption: 'Current owner caption' });
    expect(owner.root.querySelector('.images img')).toBeNull();
  });

  it(`keeps current ${producer} errors visible but treats cancellation quietly`, async () => {
    const pending = deferred<ImageBlock>();
    const read = vi.spyOn(context, imageProducer(producer) ? 'downscaleImage' : 'screenshotBlock').mockReturnValue(pending.promise);
    const owner = await mount(); await start(owner.root, owner.store, producer);
    pending.reject(new FemError('cancelled', 'Attachment cancelled')); await paint();
    expect(owner.root.querySelector('.bad-line')).toBeNull();
    read.mockRejectedValue(new Error('Current attachment failed')); await start(owner.root, owner.store, producer); await paint();
    expect(owner.root.querySelector('.bad-line')?.textContent).toBe('Error: Current attachment failed');
    read.mockResolvedValue(image); await start(owner.root, owner.store, producer); await paint();
    expect(owner.root.querySelector('.images img')).not.toBeNull();
    owner.root.querySelector<HTMLElement>('[aria-label="remove the image"]')!.click(); await tick();
    expect(owner.root.querySelector('.images img')).toBeNull();
  });

  it(`drops a late ${producer} success or failure after unmount`, async () => {
    for (const failure of [false, true]) {
      const pending = deferred<ImageBlock>();
      const read = vi.spyOn(context, imageProducer(producer) ? 'downscaleImage' : 'screenshotBlock').mockReturnValue(pending.promise);
      const owner = await mount(); await start(owner.root, owner.store, producer); render(null, owner.root);
      const next = await mount();
      if (failure) pending.reject(new Error('UNMOUNTED_PRIVATE_ERROR')); else pending.resolve(image);
      await paint(); expect(next.root.querySelector('.images img')).toBeNull(); expect(next.root.textContent).not.toContain('UNMOUNTED_PRIVATE_ERROR');
      render(null, next.root); read.mockRestore();
    }
  });
}

it('does not copy an earlier account attachment into a queued message before the clearing render', async () => {
  vi.spyOn(context, 'screenshotBlock').mockResolvedValue(image);
  vi.spyOn(hosted, 'hostedProvider').mockReturnValue({ id: 'openai', models: ['gpt-5.4-mini'],
    async *chat() { yield { type: 'done', stopReason: 'end_turn' }; } });
  const owner = await mount();
  await start(owner.root, owner.store, 'view button'); await paint();
  expect(owner.root.querySelector('.images img')).not.toBeNull();
  identity('B'); // Controller changes synchronously; the Store/render has not caught up yet.
  chatBridge.send('B asks a new question');
  await paint();
  expect(owner.root.querySelector('.bubble img')).toBeNull();
  owner.store.set({ account: account.state }); await tick();
});

it('excludes an old pending image from the next account’s actual assembled provider payload', async () => {
  const pending = deferred<ImageBlock>();
  vi.spyOn(context, 'downscaleImage').mockReturnValue(pending.promise);
  const seen: Message[][] = [];
  vi.spyOn(hosted, 'hostedProvider').mockReturnValue({ id: 'openai', models: ['gpt-5.4-mini'],
    async *chat(request) { seen.push(structuredClone(request.messages)); yield { type: 'done', stopReason: 'end_turn' }; } });
  const owner = await mount();
  await start(owner.root, owner.store, 'image input');
  await cross(owner, 'account A-B');
  pending.resolve(image); await paint();
  chatBridge.send('B asks a new question');
  await vi.waitFor(() => expect(seen, owner.root.textContent ?? '').toHaveLength(1));
  expect(JSON.stringify(seen)).not.toContain(image.base64);
});
