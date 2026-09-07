import type { OpenProject, ProjectMeta, ProjectSaveReceipt } from '@femlab/registry';

/** Services bound to one activation's captured persistence destination. */
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
  /** `file.autosave { on }`. Off stops writing; it never deletes what is already saved. */
  setEnabled(on: boolean): void;
  enabled(): boolean;
  /** The pending write, awaited — for `project.save`, the tests and `beforeunload`. */
  flush(): Promise<void>;
}
