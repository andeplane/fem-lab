// Python is optional and only loaded after an explicit Python run. It never holds the engine.
// Version pinned to the documented Pyodide release, separate from the landing bundle.
import client from '../../../python/femlab/client.py?raw';
import generated from '../../../python/femlab/generated.py?raw';
import init from '../../../python/femlab/__init__.py?raw';
interface Pyodide {
  FS: { mkdirTree(path: string): void; writeFile(path: string, value: string): void };
  runPythonAsync(code: string): Promise<unknown>;
  loadPackage(name: string | string[]): Promise<void>;
  loadPackagesFromImports(code: string): Promise<void>;
  registerJsModule(name: string, value: unknown): void;
  setStdout(options: { batched(value: string): void }): void;
  setStderr(options: { batched(value: string): void }): void;
}
let python: Pyodide;
let seq = 0;
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
const rpc = (op: string, proxy: { toJs(options: unknown): Record<string, unknown> }) => new Promise((resolve, reject) => {
  const id = ++seq; pending.set(id, { resolve, reject });
  self.postMessage({ kind: 'rpc', id, op, payload: proxy.toJs({ dict_converter: Object.fromEntries }) });
});
const post = (kind: string, value?: unknown) => self.postMessage({ kind, value });
self.onmessage = async (event: MessageEvent<{ kind: string; id?: number; value?: unknown; error?: string; code?: string }>) => {
  const msg = event.data;
  if (msg.kind === 'reply') {
    const entry = pending.get(msg.id!); pending.delete(msg.id!);
    if (msg.error) entry?.reject(new Error(msg.error)); else entry?.resolve(msg.value);
    return;
  }
  try {
    if (msg.kind === 'init') {
      const url = 'https://cdn.jsdelivr.net/pyodide/v0.29.3/full/pyodide.mjs';
      const module = await import(/* @vite-ignore */ url) as { loadPyodide(options: { indexURL: string; enableRunUntilComplete: boolean }): Promise<Pyodide> };
      python = await module.loadPyodide({ indexURL: url.replace('pyodide.mjs', ''), enableRunUntilComplete: false });
      python.FS.mkdirTree('/home/pyodide/femlab');
      for (const [name, code] of [['client.py', client], ['generated.py', generated], ['__init__.py', init]]) python.FS.writeFile(`/home/pyodide/femlab/${name}`, code!);
      python.registerJsModule('_femlab_bridge', { rpc, plot: (image: string) => post('plot', image) });
      python.setStdout({ batched: value => post('log', value) }); python.setStderr({ batched: value => post('log', value) });
      await python.loadPackage('numpy');
      await python.runPythonAsync(`import femlab, numpy as np
from _femlab_bridge import rpc
async def _registry(op, payload):
    value = await rpc(op, payload)
    if op == 'query' and payload.get('query') == 'query.field':
        # to_py preserves typed buffers as memoryviews; numpy is a view, not a JSON list.
        result = value.to_py()
        result['values'] = np.asarray(result['values'])
        return result
    return value.to_py()
fem = femlab.AsyncClient(_registry)
`);
      post('ready');
    } else if (msg.kind === 'run') {
      await python.loadPackagesFromImports(msg.code!);
      if (/\bmatplotlib\b/.test(msg.code!)) await python.runPythonAsync(`import matplotlib
matplotlib.use('agg')
`);
      await python.runPythonAsync(msg.code!);
      if (/\bmatplotlib\b/.test(msg.code!)) await python.runPythonAsync(`import io, base64
import matplotlib.pyplot as plt
from _femlab_bridge import plot
for _n in plt.get_fignums():
    _out = io.BytesIO()
    plt.figure(_n).savefig(_out, format='png')
    plot(base64.b64encode(_out.getvalue()).decode())
plt.close('all')
`);
      post('done');
    }
  } catch (error) { post('failed', error instanceof Error ? error.message : String(error)); }
};
