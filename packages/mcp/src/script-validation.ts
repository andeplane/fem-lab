import { Worker } from 'node:worker_threads';
import { ScriptValidator, type ScriptValidation } from '@femlab/registry';

interface NodeValidationWorker {
  on(event: 'message', listener: (value: ScriptValidation) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'exit', listener: (code: number) => void): void;
  postMessage(code: string): void;
  terminate(): Promise<number>;
}

/** Node owns its worker and timer; no compiler work blocks the MCP event loop. */
export function nodeScriptValidator(spawn: () => NodeValidationWorker = () => new Worker(new URL('../dist/script-validation-worker.js', import.meta.url), { resourceLimits: { maxOldGenerationSizeMb: 128 } })): ScriptValidator {
  return new ScriptValidator(() => {
    const worker = spawn();
    return {
      postMessage: (code) => worker.postMessage(code),
      onResult: (listener) => { worker.on('message', listener); },
      onFailure: (listener) => {
        worker.on('error', (error) => listener(error.message));
        worker.on('exit', (code) => { if (code !== 0) listener(`validation worker exited with code ${code}`); });
      },
      terminate: () => { void worker.terminate(); },
    };
  }, { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>) });
}
