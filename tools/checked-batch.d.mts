import type * as Wasm from '../packages/app/src/generated/wasm/femlab_engine_wasm';
export interface BatchEngine {
  dispatch(json: string, progress?: (value: unknown) => void): Promise<string>;
  query(json: string): string;
  replay_hashes(json: string, skip: boolean, verify: boolean): Promise<string>;
  import_file(json: string): Promise<void>;
  export_file(): string;
  model_hash(): string;
  revision(): number;
  surface(): unknown;
  field(step: string, field: string, component?: number): Float32Array;
  gpu_self_test(n: number): Promise<number>;
  free(): void;
}
export function batchModule(wasm: typeof Wasm): typeof Wasm & { Engine: new (threads: number) => BatchEngine };
