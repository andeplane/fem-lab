// User code executes in QuickJS. This Worker owns only the disposable runtime and a JSON
// MessagePort; registry calls remain on the main thread and Commands still enter the Journal.
import { createScriptContext } from '@femlab/registry/script-runtime';

export interface ScriptRequest {
  code: string;
  port: MessagePort;
}
export interface ScriptCall {
  id: number;
  kind: 'dispatch' | 'query';
  value: Record<string, unknown>;
}
export type ScriptReply = { id: number; value?: unknown; error?: string; timer?: true };
export interface ScriptDone {
  result?: unknown;
  console: string[];
  error?: string;
}

/** Preserve registry causes and map the QuickJS wrapper's line back to the person's source. */
export function describe(e: unknown): string {
  const err = e as { code?: string; cause?: string; message?: string; stack?: string };
  const head = err?.code ? `${err.code}: ${err.cause}` : (err?.message ?? String(e));
  const at = /(?:script.js|<anonymous>):(\d+)(?::\d+)?/.exec(err?.stack ?? '');
  const line = at ? Number(at[1]) - (at[0].startsWith('script.js') ? 1 : 3) : 0;
  return line > 0 ? `${head} (line ${line})` : head;
}

/** Start one bounded QuickJS context and connect its JSON bridge to the host MessagePort. */
export async function runScript(code: string, port: MessagePort): Promise<{ dispose(): void } | null> {
  try {
    const context = await createScriptContext(code, (text) => port.postMessage(text));
    port.onmessage = (event: MessageEvent<unknown>) => {
      try {
        if (typeof event.data !== 'string') throw new Error('invalid script host message');
        context.receive(event.data);
      } catch (error) {
        port.postMessage(JSON.stringify({ kind: 'failed', value: { message: describe(error) } }));
      }
    };
    return context;
  } catch (error) {
    port.postMessage(JSON.stringify({ kind: 'failed', value: { message: describe(error) } }));
    return null;
  }
}

// `self.onmessage` only exists in the real Worker; the unit test imports `runScript` directly.
if (typeof self !== 'undefined' && 'postMessage' in self) {
  self.onmessage = (event: MessageEvent<ScriptRequest>) => {
    void runScript(event.data.code, event.data.port);
  };
}
