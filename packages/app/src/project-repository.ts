// Durable project ownership. A save owns its destination, generation, version and bytes before
// any thumbnail, debounce or storage await. Tombstones retain revocation after deletion.
import { FemError, scientificJson, type DocumentSnapshot, type ProjectMeta, type StateVersion, type SessionRef, type ModelFile, type CloudProject } from '@femlab/registry';
import { JOURNALS, PROJECTS, done, openDb } from './db';
import type { ShareCommand } from './share';

export interface PendingProjectUpload { key:string; tag:string; name:string; projectId?:string; baseRevision:string|null; bytes:Uint8Array }
export interface ProjectCloudRecord {remote:CloudProject|null;dirty:boolean;deleted:boolean;upload?:PendingProjectUpload;deleteKey?:string;conflict?:CloudProject}
export interface ProjectRecord {
  id: string;
  generation: string | null;
  version: StateVersion;
  meta: ProjectMeta | null;
  cmds: ShareCommand[];
  journal?:ModelFile['journal'];
  artifact?:Uint8Array;
  artifactTag?:string;
  artifactError?:string;
  saveSequence?:number;
  cloud?:ProjectCloudRecord;
}
export interface AtomicProjects {
  list(): Promise<ProjectMeta[]>;
  /** Includes tombstones so pending cloud deletes survive a reload. */
  scan():Promise<ProjectRecord[]>;
  read(id: string): Promise<ProjectRecord | null>;
  /** Compare and mutation share one transaction; callbacks cannot await or do I/O. */
  update(id: string, change: (previous: ProjectRecord | null) => ProjectRecord): Promise<ProjectRecord>;
}
const clone = <T>(value: T): T => structuredClone(value);
// A bit-significant -0 must remain different from +0 when comparing checked history.
const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,child])=>[key,canonical(child)])):value;
const identity=(value:unknown):string|undefined=>value===undefined?undefined:scientificJson(canonical(value));
const conflict = (): FemError => new FemError('session.conflict', 'the saved project changed or was deleted after this save was prepared', 'project');
const later = (a: StateVersion, b: StateVersion): boolean => a.length > b.length || a.length === b.length && a > b;

export function memoryAtomicProjects(): AtomicProjects {
  const rows = new Map<string, ProjectRecord>();
  return {
    scan: async()=>[...rows.values()].map(clone),
    list: async () => [...rows.values()].flatMap(row => row.meta ? [clone(row.meta)] : []),
    read: async (id) => clone(rows.get(id) ?? null),
    update: async (id, change) => { const next = change(clone(rows.get(id) ?? null)); rows.set(id, clone(next)); return clone(next); },
  };
}

interface StoredJournal { id: string; cmds: ShareCommand[];journal?:ModelFile['journal']; generation?: string; version?: StateVersion; deleted?: boolean;artifact?:Uint8Array;artifactTag?:string;artifactError?:string;saveSequence?:number;cloud?:ProjectCloudRecord }
const record = (meta: ProjectMeta | undefined, journal: StoredJournal | undefined): ProjectRecord | null => {
  if (!journal && !meta) return null;
  return { id: meta?.id ?? journal!.id, generation: journal?.generation ?? null, version: journal?.version ?? '0', meta: journal?.deleted ? null : meta ?? null, cmds: journal?.cmds ?? [],...(journal?.journal?{journal:journal.journal}:{}),...(journal?.artifactError?{artifactError:journal.artifactError}:{}),...(journal?.saveSequence!==undefined?{saveSequence:journal.saveSequence}:{}),...(journal?.artifact?{artifact:journal.artifact,artifactTag:journal.artifactTag}:{}),...(journal?.cloud?{cloud:journal.cloud}:{}) };
};
/** Existing version-3 records acquire a generation on first activation, without rewriting history. */
export function indexedDbAtomicProjects(factory: IDBFactory): AtomicProjects {
  const transaction = async (id: string, change?: (previous: ProjectRecord | null) => ProjectRecord): Promise<ProjectRecord | null> => {
    const db = await openDb(factory);
    try {
      const tx = db.transaction([PROJECTS, JOURNALS], change ? 'readwrite' : 'readonly');
      const committed = new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('project transaction aborted'));
      });
      // Attach a rejection handler immediately; a failed read may abort before we await commit.
      void committed.catch(() => undefined);
      try {
        const metas = tx.objectStore(PROJECTS); const journals = tx.objectStore(JOURNALS);
        const [meta, journal] = await Promise.all([
          done(metas.get(id) as IDBRequest<ProjectMeta | undefined>),
          done(journals.get(id) as IDBRequest<StoredJournal | undefined>),
        ]);
        const previous = record(meta, journal);
        const next = change ? change(previous) : previous;
        if (change && next) {
          if (next.meta) metas.put(next.meta); else metas.delete(id);
          journals.put({ id, cmds: next.cmds,journal:next.journal, generation: next.generation, version: next.version, deleted: next.meta === null,artifact:next.artifact,artifactTag:next.artifactTag,artifactError:next.artifactError,saveSequence:next.saveSequence,cloud:next.cloud });
        }
        await committed;
        return next;
      } catch (error) { try { tx.abort(); } catch { /* already complete/aborted */ } throw error; }
    } finally { db.close(); }
  };
  return {
    scan:async()=>{const db=await openDb(factory);try{const tx=db.transaction([PROJECTS,JOURNALS],'readonly');const [metas,journals]=await Promise.all([done(tx.objectStore(PROJECTS).getAll() as IDBRequest<ProjectMeta[]>),done(tx.objectStore(JOURNALS).getAll() as IDBRequest<StoredJournal[]>)]);const byId=new Map(metas.map(meta=>[meta.id,meta]));const rows=journals.map(journal=>{const value=record(byId.get(journal.id),journal)!;byId.delete(journal.id);return value;});return [...rows,...[...byId.values()].map(meta=>record(meta,undefined)!)];}finally{db.close();}},
    list: async () => {
      const db = await openDb(factory);
      try { return await done(db.transaction(PROJECTS, 'readonly').objectStore(PROJECTS).getAll() as IDBRequest<ProjectMeta[]>); }
      finally { db.close(); }
    },
    read: (id) => transaction(id),
    update: async (id, change) => (await transaction(id, change))!,
  };
}

export interface SaveJob {
  readonly id: string;
  readonly generation: string;
  readonly version: StateVersion;
  readonly meta: ProjectMeta;
  readonly cmds: ShareCommand[];
  readonly journal: ModelFile['journal'];
  readonly artifact?:Uint8Array;
  readonly artifactTag?:string;
  readonly artifactError?:string;
  readonly sequence:number;
}
export class ProjectRepository {
  constructor(private readonly storage: AtomicProjects, private readonly generation: () => string) {}
  list(): Promise<ProjectMeta[]> { return this.storage.list().then(rows => rows.sort((a, b) => b.at - a.at)); }
  async read(id: string): Promise<ProjectRecord> {
    const row = await this.storage.read(id);
    if (!row?.meta) throw new FemError('not-found', `project '${id}' is not saved in this browser`, 'project');
    return row;
  }
  async claim(meta: ProjectMeta, snapshot: DocumentSnapshot, expected: ProjectRecord | null, restored:Pick<ProjectRecord,'artifact'|'artifactTag'|'artifactError'|'cloud'>&{restoreDeleted?:boolean}={}): Promise<ProjectBinding> {
    const generation = this.generation();
    const captured = clone(snapshot);
    let previousClaim: ProjectRecord | null = null;
    const claimed = await this.storage.update(meta.id, previous => {
      if(expected===null){if(previous!==null)throw conflict();}
      else if(!previous||previous.meta===null&&!restored.restoreDeleted||Boolean(previous.meta)!==Boolean(expected.meta)||previous.generation!==expected.generation||previous.version!==expected.version||identity(previous.cmds)!==identity(expected.cmds)||previous.artifactTag!==expected.artifactTag||previous.meta?.name!==expected.meta?.name||previous.cloud?.remote?.revision!==expected.cloud?.remote?.revision||identity(previous.cloud?.conflict)!==identity(expected.cloud?.conflict))throw conflict();
      previousClaim = clone(previous);
      const {restoreDeleted:_restoreDeleted,...payload}=restored;
      return { ...previous,...clone(payload),saveSequence:0,id: meta.id, generation, version: captured.stamp.stateVersion, journal:captured.file.journal,meta: { ...clone(meta), commands: captured.file.journal.entries.length, hash: captured.model.hash }, cmds: captured.file.journal.entries.map(entry => entry.cmd as ShareCommand) };
    });
    return new ProjectBinding(this, clone(meta), generation, captured.stamp.session, async () => {
      const tombstoneGeneration = this.generation();
      await this.storage.update(meta.id, current => {
        if (identity(current) !== identity(claimed)) throw conflict();
        return previousClaim ?? { id: meta.id, generation: tombstoneGeneration, version: claimed.version, meta: null, cmds: [] };
      });
    });
  }
  async save(job: SaveJob): Promise<ProjectMeta> {
    const captured = clone(job);
    const saved = await this.storage.update(job.id, previous => {
      if (!previous?.meta || previous.generation !== captured.generation || later(previous.version, captured.version)) throw conflict();
      if (previous.version === captured.version) {
        if (identity(previous.cmds) !== identity(captured.cmds)) throw conflict();
        if (previous.meta.thumbnail === captured.meta.thumbnail && previous.artifactTag===captured.artifactTag&&previous.artifactError===captured.artifactError) return previous;
      }
      if((previous.saveSequence??0)>captured.sequence)throw conflict();
      return { ...previous,id: captured.id, generation: captured.generation, version: captured.version, meta: { ...captured.meta, name: previous.meta.name }, cmds: captured.cmds,journal:captured.journal,artifact:captured.artifactError?previous.artifact:captured.artifact,artifactTag:captured.artifactError?previous.artifactTag:captured.artifactTag,artifactError:captured.artifactError,saveSequence:captured.sequence,cloud:previous.cloud?{...previous.cloud,dirty:true}:undefined };
    });
    return saved.meta!;
  }
  async rename(id: string, name: string): Promise<ProjectMeta> {
    const result = await this.storage.update(id, previous => {
      if (!previous?.meta) throw conflict();
      return { ...previous, meta: { ...previous.meta, name },cloud:previous.cloud?{...previous.cloud,dirty:true}:undefined };
    });
    return result.meta!;
  }
  async delete(id: string): Promise<void> {
    const generation = this.generation();
    await this.storage.update(id, previous => {
      if (!previous?.meta) throw new FemError('not-found', `project '${id}' is not saved in this browser`, 'project');
      return { ...previous,id,generation,version:previous.version,meta:null,cmds:[],cloud:previous.cloud?{...previous.cloud,dirty:true,deleted:true}:undefined };
    });
  }
}
/** The binding has no pointer to a current project, so late saves cannot choose a new target. */
export class ProjectBinding {
  private sequence=0;
  constructor(private readonly repository: ProjectRepository, readonly meta: ProjectMeta, readonly generation: string, private readonly session: SessionRef, private readonly rollbackClaim: () => Promise<void>) {}
  /** Only an unpublished activation may give its durable ownership back. */
  abandon(): Promise<void> { return this.rollbackClaim(); }
  capture(snapshot: DocumentSnapshot, at: number, thumbnail: string | null = this.meta.thumbnail): SaveJob {
    if (snapshot.stamp.session.backendEpoch !== this.session.backendEpoch || snapshot.stamp.session.sessionId !== this.session.sessionId) throw conflict();
    return clone({ sequence:++this.sequence,id: this.meta.id, generation: this.generation, version: snapshot.stamp.stateVersion,
      meta: { ...this.meta, at, thumbnail, commands: snapshot.file.journal.entries.length, hash: snapshot.model.hash },
      journal: snapshot.file.journal, cmds: snapshot.file.journal.entries.map(entry => entry.cmd as ShareCommand) });
  }
  save(job: SaveJob): Promise<ProjectMeta> { return this.repository.save(job); }
}
