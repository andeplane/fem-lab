// An infinite-loop regression must not be able to hang Vitest or its MCP host.
import { Worker } from 'node:worker_threads';
import { createRegistry, callTool } from '../../src/server';
import { nodeScriptValidator } from '../../src/script-validation';
import { runScript, type ScriptDeps } from '../../src/script';
import type { EngineHandle } from '../../src/engine';

let started!: () => void;
const scriptStarted = new Promise<void>((resolve) => { started = resolve; });
const engine: EngineHandle = {
  dispatch: async () => null,
  query: async () => { started(); return { name: 'still alive' }; },
  modelFile: () => ({}),
};
const script: ScriptDeps = {
  launch: (code) => new Worker(process.argv[2]!, { workerData: code }),
  now: () => performance.now(),
  later: (fn, ms) => setTimeout(fn, ms),
  cancel: (id) => clearTimeout(id),
};
const registry = createRegistry({ engine, script, validator: nodeScriptValidator(() => new Worker(process.argv[3]!)) });
let finished = false;
const loop = callTool(registry, 'run_script', { code: 'await fem.query.model(); while (true) {}', timeoutMs: 2000 }).then((out) => { finished = true; return out as { error?: string }; });
await scriptStarted;
await new Promise((r) => setTimeout(r, 30));
await callTool(registry, 'query_model', {});
const responsive = !finished;
const timedOut = (await loop).error?.includes('did not finish') === true;
for (const code of ["__send('not json')", "__send('null')", "__send('{\"kind\":\"dispatch\",\"id\":1,\"value\":null}')"]) {
  const outcome = await runScript(code, (cmd) => registry.dispatch(cmd), (query) => registry.query(query), undefined, script) as { error?: string };
  if (!outcome.error?.includes('__send')) throw new Error('native bridge exposed');
}
const after = (await callTool(registry, 'query_model', {}) as { name: string }).name;
process.stdout.write(JSON.stringify({ responsive, timedOut, after }));
