// The engine behind every tool call. The MCP host is Node, so the engine is the wasm build
// `tools/build-wasm.mjs` writes to `tools/wasm-node` — the same module `tools/replay-wasm.mjs`
// loads, and the same engine the browser runs, so a Journal built here replays there.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { sessionEngine, type CheckedModule } from './session-engine';

/** What this host uses of the wasm-bindgen `Engine`; the rest of its surface is the viewer's. */
export interface WasmEngine {
  dispatch(cmdJson: string): Promise<string>;
  query(queryJson: string): string;
  export_file(): string;
}
export interface WasmModule {
  Engine: new (threads: number) => WasmEngine;
}

/** JSON in, JSON out: everything a tool call needs from the engine, and nothing else. */
export interface EngineHandle {
  /** Only the request admission boundary may acquire the current session. */
  acquire?(): Promise<EngineHandle>;
  release?(): Promise<void>;
  dispatch(cmd: Record<string, unknown>): Promise<unknown>;
  query(q: Record<string, unknown>): Promise<unknown>;
  /** The `femlab/1` file: the Model snapshot plus its Journal. */
  modelFile(): unknown;
}

/** The wasm build's entry file, wherever it may be. */
export const WASM_ENTRY = 'femlab_engine_wasm.js';

/**
 * Where to look for the Node wasm build: `FEMLAB_WASM` is the whole answer when it is set, so an
 * explicit override that points at nothing says so rather than quietly loading another engine;
 * otherwise a copy packaged next to `dist/`, then the checkout this file was built in. The build
 * is gitignored, so a fresh clone has none until `node tools/build-wasm.mjs` runs.
 */
export function wasmCandidates(here: string): string[] {
  const override = process.env['FEMLAB_WASM'];
  const dirs =
    override === undefined ? [path.join(here, 'wasm-node'), path.join(here, '..', '..', '..', 'tools', 'wasm-node')] : [override];
  return dirs.map((d) => path.join(d, WASM_ENTRY));
}

/** The message a person can act on when the engine is not built yet. */
export function missingEngine(here: string): Error {
  return new Error(
    `femlab-mcp cannot find the engine (${WASM_ENTRY}). Looked in:\n` +
      wasmCandidates(here)
        .map((p) => `  ${p}`)
        .join('\n') +
      '\nBuild it with `node tools/build-wasm.mjs` in a checkout, or point FEMLAB_WASM at the folder that holds it.',
  );
}

/** `require` the wasm module and wrap one engine instance; throws [`missingEngine`] when absent. */
export function loadEngine(here: string, threads = 1): EngineHandle {
  const found = wasmCandidates(here).find((p) => existsSync(p));
  if (found === undefined) throw missingEngine(here);
  const wasm = createRequire(import.meta.url)(found) as CheckedModule;
  return sessionEngine(wasm, threads, randomUUID());
}

/** The wasm engine as an [`EngineHandle`]; errors come back as the engine's structured object. */
export function handleOf(engine: WasmEngine): EngineHandle {
  return {
    dispatch: async (cmd) => JSON.parse(await engine.dispatch(JSON.stringify(cmd))) as unknown,
    query: (q) => Promise.resolve(JSON.parse(engine.query(JSON.stringify(q))) as unknown),
    modelFile: () => JSON.parse(engine.export_file()) as unknown,
  };
}
