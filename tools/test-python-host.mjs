import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname,'..');
const python = process.env.FEMLAB_PYTHON ?? 'python3';
const dir = await mkdtemp(path.join(tmpdir(),'femlab-python-'));
const externalURL = process.env.FEMLAB_SERVER_URL;
let url;
let replaySession;
const server = externalURL ? null : spawn(process.execPath, [path.join(root,'packages/server/dist/femlab-serve.js'),'--port','0'], {stdio:['ignore','pipe','inherit']});
try {
  url = externalURL ?? await new Promise((resolve,reject)=>{
    const lines=createInterface({input:server.stdout});
    server.once('error',reject);
    const timer=setTimeout(()=>{lines.close();reject(new Error('server did not listen'));},30000);
    lines.once('line',line=>{clearTimeout(timer);lines.close();resolve(JSON.parse(line).url);});
    server.once('exit',code=>{clearTimeout(timer);reject(new Error(`server exited ${code}`));});
  });
  const {stdout: installation}=await exec(python,['-c', 'import femlab, importlib.metadata, json; print(json.dumps({"path":femlab.__file__,"version":importlib.metadata.version("femlab")}))'],{cwd:dir});
  const installed=JSON.parse(installation);
  assert(path.relative(path.join(root,'python'),installed.path).startsWith('..'),'smoke must import an installed wheel, not the source tree');
  const expected=/^version = "([^"]+)"/m.exec(await readFile(path.join(root,'python/pyproject.toml'),'utf8'))[1];
  assert.equal(installed.version,expected);
  const out=path.join(dir,'heat-bar.png');
  const {stdout}=await exec(python,[path.join(root,'python/examples/heat_bar.py'),'--url',url,'--out',out],{cwd:dir});
  const receipt=JSON.parse(stdout.trim()); assert(receipt.max_error_K<1e-8);
  assert((await readFile(out)).subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])));
  const entries=JSON.parse(await readFile(out.replace('.png','.journal.json'),'utf8'));
  const first=await fetch(`${url}/session`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).then(r=>r.json());
  replaySession=first.session;
  const replay=await fetch(`${url}/rpc`,{method:'POST',headers:{'Content-Type':'application/json','X-Femlab-Session':first.session},body:JSON.stringify({id:1,op:'replaceCommands',payload:entries.map(entry=>entry.cmd)})}).then(r=>r.json());
  assert.equal(replay.ok,true,JSON.stringify(replay));
  assert.deepEqual(replay.value.entries.map(e=>e.hashAfter),entries.map(e=>e.hashAfter));
  // Execute the committed Jupyter cells against the same server, with a private capability.
  const notebook=JSON.parse(await readFile(path.join(root,'python/examples/heat_bar.ipynb'),'utf8'));
  const source=notebook.cells.filter(cell=>cell.cell_type==='code').map(cell=>cell.source.join('')).join('\n').replace('Client()',`Client(${JSON.stringify(url)})`);
  await exec(python,['-c',source],{cwd:dir});
  console.log(`Python wheel -> Node WASM: E1 error ${receipt.max_error_K} K, PNG signature, ${entries.length} identical replay hashes, and committed Jupyter cells passed.`);
} finally {
  if(url && replaySession) await fetch(`${url}/close`,{method:'POST',headers:{'Content-Type':'application/json','X-Femlab-Session':replaySession},body:'{}'}).catch(()=>undefined);
  server?.kill('SIGTERM');
  await rm(dir,{recursive:true,force:true});
}
