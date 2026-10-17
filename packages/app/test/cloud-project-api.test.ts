import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { PROJECT_CHUNK_BYTES, type CloudProject, type CloudProjectManifest, type CloudStorageStatus } from '@femlab/registry';
import { CloudProjectApi, type CloudProjectEnvironment } from '../src/cloud-project-api';

const ID = '11111111-1111-4111-8111-111111111111';
const UPLOAD = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const origin = 'https://projects.example.test';
const time = '2026-10-16T12:00:00Z';
const project = (patch: Partial<CloudProject> = {}): CloudProject => ({ id: ID, name: 'Beam', revision: '7', changeVersion: '90071992547409931', bytes: 3, updatedAt: time, deletedAt: null, ...patch });
const quota = (patch: Partial<CloudStorageStatus> = {}): CloudStorageStatus => ({ available: true, plan: 'free', limitBytes: 100_000_000, usedBytes: 3, reservedBytes: 0, pendingBytes: 0, overQuota: false, maxChunkBytes: PROJECT_CHUNK_BYTES, ...patch });
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const manifest = (bytes = new Uint8Array([1, 2, 3])): CloudProjectManifest => ({ format: 'femlab-project/1', bytes: bytes.length, chunks: [{ bytes: bytes.length, sha256: hash(bytes) }] });
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function setup(handler: (url: string, options?: RequestInit) => Promise<Response> = async () => json({ projects: [project()], nextCursor: null, storage: quota() })) {
  let identity: { uid: string | null; epoch: number } = { uid: 'A', epoch: 1 };
  const fetch = vi.fn<CloudProjectEnvironment['fetch']>(async (url, options) => handler(String(url), options));
  const token = vi.fn<CloudProjectEnvironment['token']>(async uid => `token-for-${uid}`);
  const sha256 = vi.fn<CloudProjectEnvironment['sha256']>(async bytes => hash(bytes));
  const env: CloudProjectEnvironment = { origin, fetch, token, sha256, identity: () => identity, maxArtifactBytes: 128 * 1024 * 1024 };
  const api = new CloudProjectApi(env);
  return { api, env, fetch, token, sha256, switchTo: (uid: string | null, epoch: number) => { identity = { uid, epoch }; } };
}

describe('cloud project API ownership and metadata', () => {
  it('requires an account and captures UID plus full epoch', () => {
    const fixture = setup();
    expect(fixture.api.capture()).toEqual({ uid: 'A', epoch: 1 });
    fixture.switchTo(null, 2);
    expect(() => fixture.api.capture()).toThrow();
    expect(fixture.fetch).not.toHaveBeenCalled();
  });

  it('rejects A → B → A while waiting for a token before any fetch', async () => {
    const fixture = setup(); const ready = deferred<string>();
    fixture.token.mockImplementationOnce(() => ready.promise);
    const pending = fixture.api.list(fixture.api.capture());
    fixture.switchTo('B', 2); fixture.switchTo('A', 3); ready.resolve('old-token');
    await expect(pending).rejects.toMatchObject({ code: 'account.changed' });
    expect(fixture.fetch).not.toHaveBeenCalled();
  });

  it('rejects a reply after A → B → A even when its UID matches again', async () => {
    const ready = deferred<Response>();
    const fixture = setup(() => ready.promise);
    const pending = fixture.api.list(fixture.api.capture());
    await vi.waitFor(() => expect(fixture.fetch).toHaveBeenCalledOnce());
    fixture.switchTo('B', 2); fixture.switchTo('A', 3);
    ready.resolve(json({ projects: [project()], nextCursor: null, storage: quota() }));
    await expect(pending).rejects.toMatchObject({ code: 'account.changed' });
  });

  it('passes the captured abort signal to fetch and stops an aborted request without retry', async () => {
    const controller = new AbortController();
    const fixture = setup(async (_url, options) => new Promise<Response>((_resolve, reject) => {
      options!.signal!.addEventListener('abort', () => reject(new DOMException('stopped', 'AbortError')), { once: true });
    }));
    const pending = fixture.api.list({ ...fixture.api.capture(), signal: controller.signal });
    await vi.waitFor(() => expect(fixture.fetch).toHaveBeenCalledOnce());
    expect(fixture.fetch.mock.calls[0]![1]!.signal).toBe(controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'account.changed' });
    expect(fixture.fetch).toHaveBeenCalledOnce();
  });

  it('lists validated metadata, decimal cursors and storage without losing large versions', async () => {
    const fixture = setup();
    const result = await fixture.api.list(fixture.api.capture(), '90071992547409931');
    expect(result).toEqual({ projects: [project()], nextCursor: null, storage: quota() });
    expect(fixture.token).toHaveBeenCalledWith('A');
    expect(fixture.fetch).toHaveBeenCalledWith(`${origin}/v1/projects?after=90071992547409931`, expect.objectContaining({ headers: { Authorization: 'Bearer token-for-A' } }));
    await expect(fixture.api.list(fixture.api.capture(), '01')).rejects.toMatchObject({ code: 'project.invalid-response' });
    expect(fixture.fetch).toHaveBeenCalledOnce();
  });

  it('rejects malformed lists, metadata and quota responses', async () => {
    const invalid = [
      { projects: {}, nextCursor: null, storage: quota() },
      { projects: [project()], nextCursor: '01', storage: quota() },
      ...[{ plan: 'enterprise' }, { usedBytes: -1 }, { reservedBytes: 0.5 }, { limitBytes: Number.MAX_SAFE_INTEGER + 1 }, { pendingBytes: -1 }, { maxChunkBytes: 0 }, { maxChunkBytes: PROJECT_CHUNK_BYTES + 1 }, { available: 'yes' }, { overQuota: null }].map(patch => ({ projects: [project()], nextCursor: null, storage: { ...quota(), ...patch } })),
      ...[{ id: '../other' }, { revision: '1.5' }, { changeVersion: '-1' }, { bytes: -1 }, { updatedAt: 'never' }, { deletedAt: 'never' }].map(patch => ({ projects: [{ ...project(), ...patch }], nextCursor: null, storage: quota() })),
    ];
    for (const body of invalid) {
      const fixture = setup(async () => json(body));
      await expect(fixture.api.list(fixture.api.capture())).rejects.toMatchObject({ code: 'project.invalid-response' });
    }
  });

  it('preserves structured conflict details with the current remote metadata', async () => {
    const current = project({ revision: '8', name: 'Other tab', bytes: 10 });
    const fixture = setup(async () => json({ code: 'project.conflict', cause: 'The project changed.', details: { project: current } }, 409));
    await expect(fixture.api.delete(fixture.api.capture(), ID, '7', 'delete-key')).rejects.toMatchObject({ status: 409, code: 'project.conflict', message: 'The project changed.', project: current });
    expect(fixture.fetch).toHaveBeenCalledOnce();
  });

  it('deletes only the requested ID with its explicit base revision and idempotency key', async () => {
    const tombstone = project({ revision: '8', deletedAt: time, bytes: 0 });
    const fixture = setup(async () => json(tombstone));
    expect(await fixture.api.delete(fixture.api.capture(), ID, '7', 'delete-key')).toEqual(tombstone);
    expect(fixture.fetch).toHaveBeenCalledWith(`${origin}/v1/projects/${ID}/delete`, expect.objectContaining({ method: 'POST', body: '{"baseRevision":"7"}', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'delete-key', Authorization: 'Bearer token-for-A' } }));
    for (const [id, revision, key] of [['../other', '7', 'key'], [ID, '01', 'key'], [ID, '7', '']]) await expect(fixture.api.delete(fixture.api.capture(), id!, revision!, key!)).rejects.toMatchObject({ code: 'project.invalid-response' });
    expect(fixture.fetch).toHaveBeenCalledOnce();
  });

  it('rejects delete replies that have no tombstone or name another project', async () => {
    for (const remote of [project(), project({ id: OTHER, deletedAt: time })]) {
      const fixture = setup(async () => json(remote));
      await expect(fixture.api.delete(fixture.api.capture(), ID, '7', 'delete-key')).rejects.toMatchObject({ code: 'project.invalid-response' });
    }
  });
});

describe('resumable cloud artifact uploads', () => {
  it('uploads only missing chunks, handles 204 PUTs and commits with the same key', async () => {
    const bytes = new Uint8Array(PROJECT_CHUNK_BYTES + 3); bytes.fill(7); bytes.set([11, 12, 13], PROJECT_CHUNK_BYTES);
    const progress = vi.fn();
    const fixture = setup(async url => {
      if (url.endsWith('/uploads')) return json({ uploadId: UPLOAD, projectId: ID, expiresAt: time, missingChunks: [1] });
      if (url.endsWith('/chunks/1')) return new Response(null, { status: 204 });
      if (url.endsWith('/commit')) return json(project({ bytes: bytes.length, revision: '8' }));
      throw new Error(`unexpected route ${url}`);
    });
    const result = await fixture.api.upload(fixture.api.capture(), { id: ID, name: 'Beam', baseRevision: '7', key: 'stable-key', bytes }, progress);
    expect(result.revision).toBe('8');
    expect(fixture.fetch).toHaveBeenCalledTimes(3);
    const [begin, chunk, commit] = fixture.fetch.mock.calls;
    expect(JSON.parse(begin![1]!.body as string)).toEqual({ projectId: ID, name: 'Beam', baseRevision: '7', manifest: { format: 'femlab-project/1', bytes: bytes.length, chunks: [{ bytes: PROJECT_CHUNK_BYTES, sha256: hash(bytes.subarray(0, PROJECT_CHUNK_BYTES)) }, { bytes: 3, sha256: hash(bytes.subarray(PROJECT_CHUNK_BYTES)) }] } });
    expect(chunk![0]).toBe(`${origin}/v1/projects/uploads/${UPLOAD}/chunks/1`);
    expect(chunk![1]!.body).toEqual(new Uint8Array([11, 12, 13]));
    expect(commit![0]).toBe(`${origin}/v1/projects/uploads/${UPLOAD}/commit`);
    expect(commit![1]!.headers).toMatchObject({ 'Idempotency-Key': 'stable-key' });
    expect(progress.mock.calls).toEqual([[PROJECT_CHUNK_BYTES, bytes.length], [bytes.length, bytes.length]]);
  });

  it('captures byte contents before hashing awaits and rejects an account change during hashing', async () => {
    const fixture = setup(async url => url.endsWith('/uploads') ? json({ uploadId: UPLOAD, projectId: ID, expiresAt: time, missingChunks: [0] }) : url.endsWith('/commit') ? json(project()) : new Response(null, { status: 204 }));
    const gate = deferred<string>();
    fixture.sha256.mockImplementationOnce(() => gate.promise);
    const bytes = new Uint8Array([1, 2, 3]);
    const pending = fixture.api.upload(fixture.api.capture(), { name: 'Beam', baseRevision: null, key: 'key', bytes });
    bytes.fill(99); gate.resolve(hash(new Uint8Array([1, 2, 3])));
    await pending;
    expect(fixture.fetch.mock.calls[1]![1]!.body).toEqual(new Uint8Array([1, 2, 3]));
    const changed = setup(); const wait = deferred<string>(); changed.sha256.mockImplementationOnce(() => wait.promise);
    const rejected = changed.api.upload(changed.api.capture(), { name: 'Beam', baseRevision: null, key: 'key', bytes });
    changed.switchTo('B', 2); wait.resolve(hash(bytes));
    await expect(rejected).rejects.toMatchObject({ code: 'account.changed' });
    expect(changed.fetch).not.toHaveBeenCalled();
  });

  it('never retries a POST automatically and reuses the exact key/body on explicit retry', async () => {
    let requests = 0;
    const fixture = setup(async url => {
      if (++requests === 1) throw new Error('offline');
      return url.endsWith('/uploads') ? json({ uploadId: UPLOAD, projectId: ID, expiresAt: time, missingChunks: [] }) : json(project());
    });
    const input = { name: 'Beam', baseRevision: null, key: 'same-key', bytes: new Uint8Array([1, 2, 3]) };
    const actor = fixture.api.capture();
    await expect(fixture.api.upload(actor, input)).rejects.toMatchObject({ status: 0, code: 'project.offline' });
    expect(fixture.fetch).toHaveBeenCalledOnce();
    await fixture.api.upload(actor, input);
    expect(fixture.fetch.mock.calls[0]![1]!.body).toBe(fixture.fetch.mock.calls[1]![1]!.body);
    expect(fixture.fetch.mock.calls[0]![1]!.headers).toEqual(fixture.fetch.mock.calls[1]![1]!.headers);
    const unauthorized = setup(async () => json({ code: 'account.expired', cause: 'Sign in again.' }, 401));
    await expect(unauthorized.api.upload(unauthorized.api.capture(), input)).rejects.toMatchObject({ status: 401, code: 'account.expired' });
    expect(unauthorized.fetch).toHaveBeenCalledOnce();
    expect(unauthorized.token).toHaveBeenCalledOnce();
  });

  it('rejects invalid upload IDs, revision pairs, keys and limits before hashing or fetching', async () => {
    const fixture = setup(); fixture.env.maxArtifactBytes = 3;
    const valid = { name: 'Beam', baseRevision: null, key: 'key', bytes: new Uint8Array([1, 2, 3]) };
    for (const input of [{ ...valid, id: '../other' }, { ...valid, id: ID }, { ...valid, baseRevision: '1' }, { ...valid, id: ID, baseRevision: '01' }, { ...valid, key: '' }, { ...valid, bytes: new Uint8Array() }, { ...valid, bytes: new Uint8Array(4) }]) await expect(fixture.api.upload(fixture.api.capture(), input)).rejects.toMatchObject({ code: 'project.limit' });
    expect(fixture.sha256).not.toHaveBeenCalled(); expect(fixture.fetch).not.toHaveBeenCalled();
  });

  it('rejects invalid resumable responses without sending chunk bytes or commit', async () => {
    const valid = { uploadId: UPLOAD, projectId: ID, expiresAt: time, missingChunks: [0] };
    for (const patch of [{ uploadId: 'bad' }, { projectId: OTHER }, { expiresAt: 'never' }, { missingChunks: [0, 0] }, { missingChunks: [1] }, { missingChunks: [-1] }]) {
      const fixture = setup(async () => json({ ...valid, ...patch }));
      await expect(fixture.api.upload(fixture.api.capture(), { id: ID, name: 'Beam', baseRevision: '7', key: 'key', bytes: new Uint8Array([1, 2, 3]) })).rejects.toMatchObject({ code: 'project.invalid-response' });
      expect(fixture.fetch).toHaveBeenCalledOnce();
    }
  });
});

describe('verified revision-pinned cloud artifact downloads', () => {
  it('pins every chunk to the described revision, verifies hashes and reports byte progress', async () => {
    const first = new Uint8Array(PROJECT_CHUNK_BYTES); first.fill(1);
    const second = new Uint8Array([3]); const total = first.length + second.length; const progress = vi.fn();
    const expected = new Uint8Array(total); expected.set(first); expected.set(second, first.length);
    const current = project({ bytes: total });
    const fixture = setup(async url => url.endsWith(ID) ? json({ project: current, manifest: { format: 'femlab-project/1', bytes: total, chunks: [{ bytes: first.length, sha256: hash(first) }, { bytes: second.length, sha256: hash(second) }] } }) : new Response(url.includes('/chunks/0?') ? first : second));
    const result = await fixture.api.download(fixture.api.capture(), ID, progress);
    expect(result.project).toEqual(current);
    expect(result.bytes.length).toBe(total);
    expect(hash(result.bytes)).toBe(hash(expected));
    expect(fixture.fetch.mock.calls.map(([url]) => url)).toEqual([`${origin}/v1/projects/${ID}`, `${origin}/v1/projects/${ID}/chunks/0?revision=7`, `${origin}/v1/projects/${ID}/chunks/1?revision=7`]);
    expect(progress.mock.calls).toEqual([[first.length, total], [total, total]]);
  });

  it('rejects invalid IDs before fetch and malformed manifests before downloading content', async () => {
    const fixture = setup();
    await expect(fixture.api.download(fixture.api.capture(), '../other')).rejects.toMatchObject({ code: 'project.invalid-response' });
    expect(fixture.fetch).not.toHaveBeenCalled();
    const valid = manifest();
    for (const data of [{ ...valid, format: 'other' }, { ...valid, bytes: 4 }, { ...valid, bytes: 0 }, { ...valid, bytes: 128 * 1024 * 1024 + 1 }, { ...valid, chunks: [] }, { ...valid, chunks: [{ bytes: 2, sha256: hash(new Uint8Array([1, 2])) }, { bytes: 1, sha256: hash(new Uint8Array([3])) }] }, { ...valid, chunks: [{ bytes: 0, sha256: 'a'.repeat(64) }] }, { ...valid, chunks: [{ bytes: PROJECT_CHUNK_BYTES + 1, sha256: 'a'.repeat(64) }] }, { ...valid, chunks: [{ bytes: 3, sha256: 'uppercase'.repeat(8) }] }]) {
      const invalid = setup(async () => json({ project: project(), manifest: data }));
      await expect(invalid.api.download(invalid.api.capture(), ID)).rejects.toMatchObject({ code: 'project.invalid-response' });
      expect(invalid.fetch).toHaveBeenCalledOnce();
    }
  });

  it('rejects truncated and corrupt chunks without exposing partial artifact bytes', async () => {
    for (const bytes of [new Uint8Array([1, 2]), new Uint8Array([9, 9, 9])]) {
      const progress = vi.fn();
      const fixture = setup(async url => url.endsWith(ID) ? json({ project: project(), manifest: manifest() }) : new Response(bytes));
      await expect(fixture.api.download(fixture.api.capture(), ID, progress)).rejects.toMatchObject({ code: 'project.corrupt' });
      expect(progress).not.toHaveBeenCalled();
    }
  });

  it('rejects missing binary bodies and account changes during hash verification', async () => {
    const missing = setup(async url => url.endsWith(ID) ? json({ project: project(), manifest: manifest() }) : new Response(null, { status: 204 }));
    await expect(missing.api.download(missing.api.capture(), ID)).rejects.toMatchObject({ code: 'project.invalid-response' });
    const fixture = setup(async url => url.endsWith(ID) ? json({ project: project(), manifest: manifest() }) : new Response(new Uint8Array([1, 2, 3])));
    const gate = deferred<string>(); fixture.sha256.mockImplementationOnce(() => gate.promise);
    const progress = vi.fn(); const pending = fixture.api.download(fixture.api.capture(), ID, progress);
    await vi.waitFor(() => expect(fixture.sha256).toHaveBeenCalledOnce());
    fixture.switchTo('B', 2); gate.resolve(hash(new Uint8Array([1, 2, 3])));
    await expect(pending).rejects.toMatchObject({ code: 'account.changed' });
    expect(progress).not.toHaveBeenCalled();
  });

  it('cancels streamed chunks as soon as they exceed the manifest length', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(4)); }, cancel });
    const fixture = setup(async url => url.endsWith(ID) ? json({ project: project(), manifest: manifest() }) : new Response(stream));
    await expect(fixture.api.download(fixture.api.capture(), ID)).rejects.toMatchObject({ code: 'project.invalid-response' });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('cancels an active body when its captured account changes during a stream read', async () => {
    const cancel = vi.fn(); const reading = deferred<void>(); const release = deferred<void>();
    const stream = new ReadableStream<Uint8Array>({ async pull(controller) { reading.resolve(); await release.promise; controller.enqueue(new Uint8Array([1, 2, 3])); }, cancel });
    const fixture = setup(async url => url.endsWith(ID) ? json({ project: project(), manifest: manifest() }) : new Response(stream));
    const pending = fixture.api.download(fixture.api.capture(), ID);
    await reading.promise;
    await vi.waitFor(() => expect(fixture.fetch).toHaveBeenCalledTimes(2));
    fixture.switchTo('B', 2); release.resolve();
    await expect(pending).rejects.toMatchObject({ code: 'account.changed' });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
