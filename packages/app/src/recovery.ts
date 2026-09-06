import type { Engine } from './generated/wasm/femlab_engine_wasm.js';

/** Restore the active Journal and its redo tail without recomputing numerical Results. */
export async function restoreHistory(engine: Pick<Engine, 'replay_hashes' | 'revision' | 'dispatch'>, entries: unknown[], revision: number): Promise<void> {
  await engine.replay_hashes(JSON.stringify(entries), true, false);
  if (engine.revision() > revision) {
    await engine.dispatch(JSON.stringify({ cmd: 'journal.undo', steps: engine.revision() - revision }), undefined);
  }
}
