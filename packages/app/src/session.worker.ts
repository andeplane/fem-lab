/// <reference lib="webworker" />
import { BrowserEngine } from './browser-engine';
import { SessionRuntime } from './session-runtime';
import type { SessionRequest } from './session-protocol';

const engine = new BrowserEngine({
  canThread: self.crossOriginIsolated === true && typeof SharedArrayBuffer === 'function',
  portable: async () => ({
    module: await import('./generated/wasm/femlab_engine_wasm.js'),
    wasmUrl: (await import('./generated/wasm/femlab_engine_wasm_bg.wasm?url')).default,
  }),
  threaded: async () => {
    const module = await import('./generated/wasm-threads/femlab_engine_wasm.js');
    return { module, initThreadPool: module.initCpuThreadPool,
      wasmUrl: (await import('./generated/wasm-threads/femlab_engine_wasm_bg.wasm?url')).default };
  },
});
const runtime = new SessionRuntime((options, epoch) => engine.create(options, epoch),
  (ticket, options) => engine.candidate(ticket, options));
self.onmessage = (event: MessageEvent<SessionRequest>) => {
  void runtime.accept(event.data, (reply, raw = []) => self.postMessage(reply, raw));
};
