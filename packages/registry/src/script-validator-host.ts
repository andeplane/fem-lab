import { MAX_SCRIPT_CHARACTERS, validationFailure, type ScriptValidation } from './script-validation-types';

export interface ValidationWorker {
  postMessage(code: string): void;
  onResult(listener: (result: ScriptValidation) => void): void;
  onFailure(listener: (cause: string) => void): void;
  terminate(): void;
}
export interface ValidationClock {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** One bounded validation at a time; compilation is performed only by the injected worker. */
export class ScriptValidator {
  private active = false;
  private cancel: (() => void) | null = null;
  get running(): boolean { return this.active; }
  stop(): void { this.cancel?.(); }
  constructor(private readonly spawn: () => ValidationWorker, private readonly clock: ValidationClock) {}

  validate(code: string, timeoutMs = 10_000): Promise<ScriptValidation> {
    if (this.active) return Promise.resolve(validationFailure('script.busy', 'another script validation is running', 'Wait for it to finish and retry.'));
    if (code.length > MAX_SCRIPT_CHARACTERS) return Promise.resolve(validationFailure('script.limit', `script exceeds ${MAX_SCRIPT_CHARACTERS} characters`, 'Split the script into smaller validated runs.'));
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) return Promise.resolve(validationFailure('script.limit', 'validation timeout must be greater than 0 and at most 30000 ms', 'Choose a timeout within the supported range.'));
    let worker: ValidationWorker;
    try {
      worker = this.spawn();
    } catch (error) {
      return Promise.resolve(validationFailure('script.worker', String(error), 'Retry validation after checking host worker support.'));
    }
    this.active = true;
    return new Promise((resolve) => {
      let finished = false;
      const settle = (result: ScriptValidation) => {
        if (finished) return;
        finished = true;
        this.clock.clearTimeout(timer);
        worker.terminate();
        this.active = false;
        this.cancel = null;
        resolve(result);
      };
      const timer = this.clock.setTimeout(() => settle(validationFailure('script.timeout', `validation exceeded ${timeoutMs} ms`, 'Simplify the script or retry with a longer supported timeout.')), timeoutMs);
      this.cancel = () => settle(validationFailure('script.stopped', 'validation was stopped', 'Retry validation when ready.'));
      worker.onResult(settle);
      worker.onFailure((cause) => settle(validationFailure('script.worker', cause, 'Retry validation after checking host worker support.')));
      try {
        worker.postMessage(code);
      } catch (error) {
        settle(validationFailure('script.worker', String(error), 'Retry validation after checking host worker support.'));
      }
    });
  }
}
