import { ScriptValidator } from '@femlab/registry';

/** Browser-owned worker and clock; the compiler remains in its lazy worker chunk. */
export function browserScriptValidator(spawn: () => Worker): ScriptValidator {
  return new ScriptValidator(() => {
    const worker = spawn();
    return {
      postMessage: (code) => worker.postMessage(code),
      onResult: (listener) => { worker.onmessage = (event) => listener(event.data); },
      onFailure: (listener) => { worker.onerror = (event) => listener(event.message); },
      terminate: () => worker.terminate(),
    };
  }, { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>) });
}
