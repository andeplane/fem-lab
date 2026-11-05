import { afterEach, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { request as httpRequest, type Server } from 'node:http';
import { scientificJson } from '@femlab/registry';
import { listen } from '../src/serve';
import { loadEngine } from '../../mcp/src/engine';
const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve())); });
async function open(maxSessions = 16) {
  let time = 1;
  const { server, port } = await listen({ engine: () => loadEngine(path.dirname(fileURLToPath(import.meta.url)).replace('/test','/src')), now: () => time, token: () => `test-${time++}`, maxSessions, sessionMs: 100 }, 0);
  servers.push(server);
  const base = `http://127.0.0.1:${port}`;
  const request = async (route: string, payload: unknown = {}, session?: string, headers: Record<string, string> = {}) => {
    return new Promise<{status:number;body:Record<string,any>}>((resolve,reject)=> {
      const bytes=Buffer.from(scientificJson(payload));
      const req=httpRequest(base+route,{method:'POST',headers:{'Content-Type':'application/json','Content-Length':bytes.length,...(session?{'X-Femlab-Session':session}:{}),...headers}},res=>{
        const chunks:Buffer[]=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode!,body:JSON.parse(Buffer.concat(chunks).toString())}));
      });req.on('error',reject);req.end(bytes);
    });
  };
  return { request, advance: () => { time += 101; }, base };
}
it('isolates actual WASM owners and preserves structured errors, scientific signed zero and replay hashes', async () => {
  const { request } = await open();
  const a = (await request('/session')).body.session;
  const b = (await request('/session')).body.session;
  const rpc = (session: string, op: string, payload: unknown) => request('/rpc', {id:1,op,payload}, session);
  await rpc(a, 'dispatch', {cmd:'model.new',name:'alpha'});
  await rpc(b, 'dispatch', {cmd:'model.new',name:'beta'});
  await rpc(a, 'dispatch', {cmd:'geometry.addBox',name:'signed-zero',size:['1 m','1 m','1 m'],at:[{value:-0,unit:'m'},'0 m','0 m']});
  const document=(await rpc(a,'query',{query:'query.document'})).body.value;
  expect(Object.is(document.file.journal.entries.at(-1).cmd.at[0].value,-0)).toBe(true);
  expect((await rpc(a,'query',{query:'query.model'})).body.value.name).toBe('alpha');
  expect((await rpc(b,'query',{query:'query.model'})).body.value.name).toBe('beta');
  for (const cmd of ['script.run','chat.send','billing.checkout']) {
    const refused=await rpc(a,'dispatch',{cmd,code:'from js import fetch',language:'python'});
    expect(refused.status).toBe(400); expect(refused.body.error.code).toBe('schema');
  }
  const before = (await rpc(a,'query',{query:'query.journal'})).body.value;
  const replay = await rpc(b,'replaceCommands',before.entries.map((entry: any) => entry.cmd));
  expect(replay.body.value.entries.map((entry: any) => entry.hashAfter)).toEqual(before.entries.map((entry: any) => entry.hashAfter));
  const bad = await rpc(a,'dispatch',{cmd:'geometry.addBox',name:'bad',size:['1 kg','1 m','1 m']});
  expect(bad.status).toBe(400); expect(bad.body.error.code).toBe('unit.dimension');
  expect((await request('/close',{},a)).body.closed).toBe(true);
  expect((await rpc(a,'query',{query:'query.model'})).status).toBe(401);
});
it('rejects browser/rebinding origins, invalid protocols and expired/overflow sessions', async () => {
  const { request, base, advance } = await open(1);
  expect((await request('/session',{},undefined,{Origin:'https://evil.example'})).status).toBe(403);
  expect((await request('/session',{},undefined,{Host:'evil.example'})).status).toBe(403);
  expect((await fetch(base)).status).toBe(405);
  expect((await request('/session',{},undefined,{'Content-Type':'text/plain'})).status).toBe(400);
  const session = (await request('/session')).body.session;
  expect((await request('/session')).status).toBe(400);
  const invalid=await request('/rpc',{id:1,op:'script',payload:{}},session);
  expect(invalid.status).toBe(400);
  expect(invalid.body.error).toEqual({code:'schema',cause:'invalid registry request',where:'rpc',suggestion:null});
  expect((await request('/rpc',{id:1,op:'query',payload:[]},session)).status).toBe(400);
  expect((await request('/rpc',{id:1,op:'replaceCommands',payload:{}},session)).status).toBe(400);
  expect((await request('/missing',{},session)).status).toBe(404);
  advance();
  expect((await request('/rpc',{id:1,op:'query',payload:{query:'query.model'}},session)).status).toBe(401);
  expect((await request('/session')).status).toBe(201);
});
