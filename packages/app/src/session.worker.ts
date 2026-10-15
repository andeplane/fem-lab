/// <reference lib="webworker" />
import init, { SessionEngine, PreparedEngine } from './generated/wasm/femlab_engine_wasm.js';
import wasmUrl from './generated/wasm/femlab_engine_wasm_bg.wasm?url';
import { SessionRuntime } from './session-runtime';
import type { SessionRequest } from './session-protocol';

const runtime = new SessionRuntime(async (options, epoch) => {
  await init({ module_or_path: wasmUrl });
  return SessionEngine.create(options, epoch);
}, (ticket, options) => PreparedEngine.create(ticket, options));
self.onmessage = (event: MessageEvent<SessionRequest>) => {
  void runtime.accept(event.data, (reply, raw = []) => self.postMessage(reply, raw));
};
