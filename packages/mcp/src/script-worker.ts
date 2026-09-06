// Process wiring only; user code executes in QuickJS, never in the worker's Node realm.
import { parentPort, workerData } from 'node:worker_threads';
import { createScriptContext } from './script-context';
import { describe } from './script';

try {
  const context = await createScriptContext(workerData as string, (text) => parentPort!.postMessage(text));
  parentPort!.on('message', (text: string) => {
    try { context.receive(text); }
    catch (error) { parentPort!.postMessage(JSON.stringify({ kind: 'failed', value: { message: describe(error) } })); }
  });
} catch (error) {
  parentPort!.postMessage(JSON.stringify({ kind: 'failed', value: { message: describe(error) } }));
}
