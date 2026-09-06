// Projects: one saved Model's Journal plus its metadata, kept in this browser (issue #41).
//
// The rule is one sentence — **the open project is where the Journal goes, and a project appears
// the moment a Model does**. `note()` runs at the end of `refresh()`, which already runs after
// every journaled Command; with no project open and a non-empty Journal it creates one named
// after the Model, and otherwise it debounces a write. That single rule covers `model.new`,
// `file.open`, `file.openExample`, `example.open`, a share link and the Assistant's first
// `model.new`: none of them has to know projects exist. The Commands that replace the whole
// Model call `fork()` first, so opening an example starts a project instead of overwriting one.
//
// Nothing here is journaled: `project.*` is host state, and the Journal holds engine Commands
// only, so a project's Journal is byte-identical to what `file.save` writes and replays on a
// server unchanged. Storage, the engine and the clock all arrive as injected interfaces, so
// every unit is testable with a fake (AGENTS: dependency injection everywhere a boundary exists).
import { FemError, type ModelFile, type OpenProject, type ProjectMeta, type ProjectSaveReceipt } from '@femlab/registry';
import { JOURNALS, PROJECTS, done, openDb, tx, type JournalRecord } from './db';
import type { ShareCommand } from './share';

export type { ProjectMeta } from '@femlab/registry';

/** Where projects live. One implementation per storage; the app injects the real one. */
export interface ProjectStore {
  list(): Promise<ProjectMeta[]>;
  /** The Commands of one project, or `null` when there is no such record. */
  journal(id: string): Promise<ShareCommand[] | null>;
  writeMeta(meta: ProjectMeta): Promise<void>;
  writeJournal(meta: ProjectMeta, cmds: ShareCommand[]): Promise<void>;
  remove(id: string): Promise<void>;
}

/** The real one: the `projects` and `journals` stores of `db.ts`. */
export function indexedDbProjects(factory: IDBFactory): ProjectStore {
  return {
    list: () => tx(factory, PROJECTS, 'readonly', (s) => s.getAll() as IDBRequest<ProjectMeta[]>),
    journal: async (id) => (await tx(factory, JOURNALS, 'readonly', (s) => s.get(id) as IDBRequest<JournalRecord | undefined>))?.cmds ?? null,
    writeMeta: (meta) => tx(factory, PROJECTS, 'readwrite', (s) => s.put(meta)).then(() => undefined),
    writeJournal: async (meta, cmds) => {
      // One transaction over both stores: a Journal without its metadata is invisible, and
      // metadata without its Journal opens to nothing.
      const db = await openDb(factory);
      try {
        const t = db.transaction([PROJECTS, JOURNALS], 'readwrite');
        await done(t.objectStore(PROJECTS).put(meta));
        await done(t.objectStore(JOURNALS).put({ id: meta.id, cmds } satisfies JournalRecord));
      } finally {
        db.close();
      }
    },
    remove: async (id) => {
      const db = await openDb(factory);
      try {
        const t = db.transaction([PROJECTS, JOURNALS], 'readwrite');
        await done(t.objectStore(PROJECTS).delete(id));
        await done(t.objectStore(JOURNALS).delete(id));
      } finally {
        db.close();
      }
    },
  };
}

/** For tests, and for a browser that refuses IndexedDB (private mode): projects then cost nothing. */
export function memoryProjects(): ProjectStore {
  const metas = new Map<string, ProjectMeta>();
  const journals = new Map<string, ShareCommand[]>();
  return {
    list: () => Promise.resolve([...metas.values()]),
    journal: (id) => Promise.resolve(journals.get(id) ?? null),
    writeMeta: (meta) => {
      metas.set(meta.id, meta);
      return Promise.resolve();
    },
    writeJournal: (meta, cmds) => {
      metas.set(meta.id, meta);
      journals.set(meta.id, cmds);
      return Promise.resolve();
    },
    remove: (id) => {
      metas.delete(id);
      journals.delete(id);
      return Promise.resolve();
    },
  };
}

/** What `HostContext.projects` is, and what `projects.test.ts` holds both implementations to. */
export interface Projects {
  /** Read the store once at boot, so `list()` and `current()` can answer synchronously. */
  prime(): Promise<ProjectMeta[]>;
  /** The Recent list, newest first. Synchronous: a memory cache every write keeps up to date. */
  list(): ProjectMeta[];
  /** The open project, or `null` while the Model is still empty. Synchronous, same cache. */
  current(): OpenProject | null;
  'new'(name?: string): Promise<ProjectMeta>;
  open(id: string): Promise<ProjectMeta>;
  rename(id: string | undefined, name: string): Promise<ProjectMeta>;
  delete(id: string): Promise<void>;
  save(): Promise<ProjectSaveReceipt | null>;
  /** Called at the end of every `refresh()`: creates the project, or debounces its write. */
  note(name: string, journal: ModelFile['journal'], hash: string | null): void;
  /** The Model is about to be replaced, so the next `note` starts a project instead of writing. */
  fork(): void;
  /** `file.autosave { on }`. Off stops writing; it never deletes what is already saved. */
  setEnabled(on: boolean): void;
  enabled(): boolean;
  /** The pending write, awaited — for `project.save`, the tests and `beforeunload`. */
  flush(): Promise<void>;
}

export interface ProjectsOptions {
  store: ProjectStore;
  /** Replays a Journal onto the engine; the app's own, so a solve at the end comes back solved. */
  replay(cmds: ShareCommand[]): Promise<void>;
  /** Starts an empty Model under `name` — `project.new` is `model.new` plus a record. */
  reset(name: string): Promise<void>;
  /** A small `data:` URL of the viewer for the Recent card; `null` when there is nothing to shoot. */
  thumbnail?(): Promise<string | null>;
  /** Debounce: a burst of Commands costs one write. */
  delayMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  initiallyOn?: boolean;
  /** Told about a write that failed, and about every change, so the UI can follow. */
  onError?: (e: unknown) => void;
  onChange?: () => void;
  /** Injected so a test gets stable ids and times. */
  now?: () => number;
  newId?: () => string;
}

const newest = (a: ProjectMeta, b: ProjectMeta): number => b.at - a.at;

interface Snapshot {
  meta: ProjectMeta;
  journal: ModelFile['journal'];
  cmds: ShareCommand[];
}

/** A query result is fresh data, but copy it so an awaited save owns an immutable payload. */
function snapshotOf(meta: ProjectMeta, journal: ModelFile['journal']): Snapshot {
  const captured = structuredClone(journal);
  return { meta, journal: captured, cmds: captured.entries.map((entry) => entry.cmd as ShareCommand) };
}

export function makeProjects({
  store,
  replay,
  reset,
  thumbnail,
  delayMs = 500,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  initiallyOn = true,
  onError,
  onChange,
  now = () => Date.now(),
  newId = () => crypto.randomUUID(),
}: ProjectsOptions): Projects {
  /** The memory cache `list()` and `current()` answer from; every write keeps it up to date. */
  let cache: ProjectMeta[] = [];
  let current: ProjectMeta | null = null;
  let on = initiallyOn;
  let timer: unknown = null;
  let latest: Snapshot | null = null;
  const pending = new Map<string, Snapshot>();
  const writes = new Map<number, { id: string; promise: Promise<unknown> }>();
  const failures: { id: string; seq: number; error: unknown }[] = [];
  const thumbnails = new Map<string, string | null>();
  const writing = new Map<string, number>();
  let tail: Promise<void> = Promise.resolve();
  let writeSeq = 0;

  const changed = (): void => onChange?.();
  const put = (meta: ProjectMeta): void => {
    cache = [meta, ...cache.filter((p) => p.id !== meta.id)].sort(newest);
  };

  const saving = (id: string): boolean => pending.has(id) || (writing.get(id) ?? 0) > 0;
  const countWrite = (id: string, delta: number): void => {
    const count = (writing.get(id) ?? 0) + delta;
    if (count === 0) writing.delete(id);
    else writing.set(id, count);
  };

  const enqueue = <T>(id: string, operation: () => Promise<T>): Promise<T> => {
    const seq = ++writeSeq;
    countWrite(id, 1);
    const queued = tail.then(operation);
    tail = queued.then(() => undefined, () => undefined);
    const promise = queued.finally(() => {
      countWrite(id, -1);
      writes.delete(seq);
      changed();
    });
    writes.set(seq, { id, promise });
    void promise.then(
      () => {
        // A later exact write for this project supersedes any earlier failed attempt.
        for (let i = failures.length - 1; i >= 0; --i) {
          if (failures[i]!.id === id && failures[i]!.seq <= seq) failures.splice(i, 1);
        }
      },
      (error: unknown) => {
        failures.push({ id, seq, error });
        onError?.(error);
      },
    );
    changed();
    return promise;
  };

  const persist = (snapshot: Snapshot): Promise<ProjectMeta> => {
    const thumbnail = thumbnails.get(snapshot.meta.id);
    const meta = thumbnail === undefined ? snapshot.meta : { ...snapshot.meta, thumbnail };
    return store.writeJournal(meta, snapshot.cmds).then(() => meta);
  };

  const write = (): void => {
    const snapshots = [...pending.values()];
    timer = null;
    pending.clear();
    for (const snapshot of snapshots) enqueue(snapshot.meta.id, () => persist(snapshot));
  };

  const flush = async (): Promise<void> => {
    if (timer !== null) {
      clearTimer(timer);
      write();
    }
    const through = writeSeq;
    await Promise.allSettled([...writes].filter(([seq]) => seq <= through).map(([, active]) => active.promise));
    const failed = failures.find((failure) => failure.seq <= through);
    if (failed) {
      for (let i = failures.length - 1; i >= 0; --i) if (failures[i]!.seq <= through) failures.splice(i, 1);
      throw failed.error;
    }
  };

  const create = (name: string): ProjectMeta => {
    const at = now();
    const meta: ProjectMeta = { id: newId(), name, at, createdAt: at, commands: 0, hash: null, thumbnail: null };
    current = meta;
    put(meta);
    return meta;
  };

  const find = (id: string): ProjectMeta => {
    const meta = cache.find((p) => p.id === id);
    if (!meta) throw new FemError('not-found', `no project with id '${id}' in this browser`, `project '${id}'`, 'query.projects lists what is saved here');
    return meta;
  };

  return {
    async prime() {
      cache = (await store.list()).sort(newest);
      changed();
      return cache;
    },
    list: () => cache,
    current: () => (current === null ? null : { ...current, saving: saving(current.id), autosave: on }),

    note(name, journal, hash) {
      if (journal.entries.length === 0) return;
      const meta = current ?? create(name);
      current = { ...meta, at: now(), commands: journal.entries.length, hash };
      put(current);
      latest = snapshotOf(current, journal);
      if (on) {
        pending.set(current.id, latest);
        if (timer === null) timer = setTimer(write, delayMs);
      }
      changed();
    },

    fork() {
      current = null;
      latest = null;
      changed();
    },

    async new(name = 'model') {
      await flush();
      current = null;
      const meta = create(name);
      await store.writeJournal(meta, []);
      changed();
      await reset(name);
      return meta;
    },

    async open(id) {
      await flush();
      const meta = find(id);
      const cmds = await store.journal(id);
      if (cmds === null) throw new FemError('not-found', `project '${meta.name}' has no Journal in this browser`, `journal '${id}'`, 'project.delete removes it, or open a femlab/1 file instead');
      // `current` stays null across the replay so a half-replayed Model cannot be written back
      // over the record it came from; the refresh that follows `project.open` notes it instead.
      current = null;
      latest = null;
      await replay(cmds);
      current = meta;
      changed();
      return meta;
    },

    async rename(id, name) {
      await flush();
      const meta = { ...find(id ?? current?.id ?? ''), name };
      if (current?.id === meta.id) current = meta;
      if (latest?.meta.id === meta.id) latest = { ...latest, meta };
      put(meta);
      await store.writeMeta(meta);
      changed();
      return meta;
    },

    async delete(id) {
      await flush();
      const meta = find(id);
      cache = cache.filter((p) => p.id !== meta.id);
      if (current?.id === meta.id) {
        current = null;
        latest = null;
      }
      await store.remove(meta.id);
      changed();
    },

    async save() {
      if (!current || !latest || latest.meta.id !== current.id) return null;
      // Capture both identity and payload before the first await. A refresh may note another
      // edit, or a Model-replacing Command may fork, while the thumbnail decodes or IDB writes.
      const captured = latest;
      pending.delete(captured.meta.id);
      if (pending.size === 0 && timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      const at = now();
      const shot = thumbnail?.().catch(() => null) ?? Promise.resolve(null);
      const explicit = enqueue(captured.meta.id, async () => {
        const thumbnail = (await shot) ?? thumbnails.get(captured.meta.id) ?? captured.meta.thumbnail;
        const meta = { ...captured.meta, at, thumbnail };
        await store.writeJournal(meta, captured.cmds);
        thumbnails.set(meta.id, meta.thumbnail);
        return meta;
      });
      const saved = await explicit;
      const sameVersion = (meta: ProjectMeta): boolean => meta.id === captured.meta.id && meta.at === captured.meta.at && meta.commands === captured.meta.commands && meta.hash === captured.meta.hash;
      cache = cache.map((meta) => sameVersion(meta) ? saved : meta.id === saved.id ? { ...meta, thumbnail: saved.thumbnail } : meta).sort(newest);
      if (current?.id === saved.id) current = sameVersion(current) ? saved : { ...current, thumbnail: saved.thumbnail };
      if (latest?.meta.id === saved.id) latest = { ...latest, meta: sameVersion(latest.meta) ? saved : { ...latest.meta, thumbnail: saved.thumbnail } };
      const waiting = pending.get(saved.id);
      if (waiting) pending.set(saved.id, { ...waiting, meta: { ...waiting.meta, thumbnail: saved.thumbnail } });
      changed();
      return { ...saved, saving: false, autosave: on, journal: captured.journal };
    },

    setEnabled(next) {
      on = next;
      if (on) return;
      // Off stops writing. It never deletes: with a background save there is nothing to lose,
      // and clearing the store the way the old autosave did would now be data loss.
      if (timer !== null) clearTimer(timer);
      timer = null;
      pending.clear();
      changed();
    },
    enabled: () => on,
    flush,
  };
}
