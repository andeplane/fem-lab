import {createHash,randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import pg from 'pg';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import type {CloudProject,CloudProjectManifest} from '@femlab/registry';
import {cloudProjects,type ProjectObjects,type ProjectObjectInfo} from '../src/cloud-projects';
import {postgresAccounts,type Account} from '../src/accounts';
import {creditLedger} from '../src/ledger';
import {migrate} from '../src/migrations';
import {ServiceFailure} from '../src/errors';
import {serviceServer} from '../src/http';
import {accountPrivacy} from '../src/privacy';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';

const digest=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
class Objects implements ProjectObjects {
  rows=new Map<string,{data:Buffer;info:ProjectObjectInfo}>();
  sequence=0;failDelete=false;gate:Promise<void>|undefined;
  async put(name:string,data:Buffer,sha256:string){await this.gate;const previous=this.rows.get(name);if(previous){if(previous.info.sha256!==sha256)throw new Error('immutable');return previous.info}const info={bytes:data.length,sha256,generation:String(++this.sequence)};this.rows.set(name,{data,info});return info}
  async stat(name:string){return this.rows.get(name)?.info??null}
  async read(name:string,generation:string){const row=this.rows.get(name);if(!row||row.info.generation!==generation)throw new Error('missing');return row.data}
  async remove(name:string,generation:string|undefined){if(this.failDelete)throw new Error('storage unavailable');const row=this.rows.get(name);if(row&&generation&&row.info.generation!==generation)throw new Error('generation mismatch');this.rows.delete(name)}
}
const manifest=(chunks:Buffer[]):CloudProjectManifest=>({format:'femlab-project/1',bytes:chunks.reduce((sum,b)=>sum+b.length,0),chunks:chunks.map(b=>({bytes:b.length,sha256:digest(b)}))});
describe.skipIf(!process.env.TEST_DATABASE_URL)('private complete project artifacts on real Postgres',()=>{
  const schema=`cloud_${randomUUID().replaceAll('-','')}`,admin=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL}),db=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`,max:20});
  let clock=new Date('2026-10-16T12:00:00Z');const now=()=>clock;
  const accounts=postgresAccounts(db,now,randomUUID),identities=new Map<string,Account>();
  const account=async(header:string|undefined)=>{const owner=header&&identities.get(header);if(!owner)throw new ServiceFailure(401,'login-required','Sign in.','identity');return owner};
  const objects=new Objects(),service=cloudProjects({db,account,objects,now,newId:randomUUID});
  async function owner(){const row=await accounts.provision({uid:randomUUID(),email:'project-fixture@example.invalid'});identities.set(row.id,row);return row.id}
  async function reserve(uid:string,chunks:Buffer[],previous?:CloudProject,key=randomUUID()){return service.reserve(uid,key,{name:'complete project',baseRevision:previous?.revision??null,...(previous?{projectId:previous.id}:{}),manifest:manifest(chunks)})}
  async function save(uid:string,chunks:Buffer[],previous?:CloudProject){const upload=await reserve(uid,chunks,previous);for(const [index,data] of chunks.entries())await service.put(uid,upload.uploadId,index,async()=>data);return {upload,project:await service.commit(uid,upload.uploadId,{})}}
  beforeAll(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);const directory=new URL('../migrations/',import.meta.url),migrations=await Promise.all((await readdir(directory)).filter(n=>n.endsWith('.sql')).sort().map(async name=>({name,sql:await readFile(new URL(name,directory),'utf8')})));const c=await db.connect();try{await migrate(c,migrations)}finally{c.release()}});
  afterAll(async()=>{await db.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end()});

  it('stores exact opaque binary content, keeps all chunk bytes and idempotently commits one revision',async()=>{
    const uid=await owner(),chunks=[Buffer.alloc(8_000_000,255),Buffer.from('complete retained results and output files')],key=randomUUID(),body={name:'complete project',baseRevision:null,manifest:manifest(chunks)};
    const a=await service.reserve(uid,key,body),b=await service.reserve(uid,key,body);expect(b).toEqual(a);
    for(const [i,data] of chunks.entries())await service.put(uid,a.uploadId,i,async()=>data);
    const saved=await service.commit(uid,a.uploadId,{});expect(await service.commit(uid,a.uploadId,{})).toEqual(saved);expect(saved).toMatchObject({revision:'1',changeVersion:'1',bytes:body.manifest.bytes});
    expect(await service.read(uid,saved.id)).toEqual({project:saved,manifest:body.manifest});expect((await service.chunk(uid,saved.id,0,'1')).equals(chunks[0]!)).toBe(true);expect(await service.chunk(uid,saved.id,1,'1')).toEqual(chunks[1]);
    expect(await service.status(uid)).toMatchObject({limitBytes:100_000_000,usedBytes:body.manifest.bytes,reservedBytes:0,pendingBytes:0,plan:'free'});
    await expect(service.reserve(uid,key,{...body,name:'different'})).rejects.toMatchObject({code:'idempotency-conflict'});
  });
  it('denies other accounts on metadata, download, put, commit and deletion before touching object/body data',async()=>{
    const uid=await owner(),other=await owner(),{upload,project}=await save(uid,[Buffer.from('private')]),body=vi.fn(async()=>Buffer.from('private'));
    await expect(service.read(other,project.id)).rejects.toMatchObject({status:404});await expect(service.chunk(other,project.id,0,'1')).rejects.toMatchObject({status:404});await expect(service.put(other,upload.uploadId,0,body)).rejects.toMatchObject({status:404});await expect(service.commit(other,upload.uploadId,{})).rejects.toMatchObject({status:404});await expect(service.remove(other,project.id,randomUUID(),{baseRevision:'1'})).rejects.toMatchObject({status:404});expect(body).not.toHaveBeenCalled();expect((await service.list(other)).projects).toEqual([]);
    await expect(service.put(undefined,upload.uploadId,0,body)).rejects.toMatchObject({status:401});await expect(service.list(undefined)).rejects.toMatchObject({status:401});expect(body).not.toHaveBeenCalled();
  });
  it('atomically bounds concurrent quota reservations without reserving more than the account owns',async()=>{
    const uid=await owner(),chunk={bytes:8_000_000,sha256:'a'.repeat(64)},body={name:'large',baseRevision:null,manifest:{format:'femlab-project/1',bytes:64_000_000,chunks:Array.from({length:8},()=>chunk)}};
    const results=await Promise.allSettled([service.reserve(uid,randomUUID(),body),service.reserve(uid,randomUUID(),body)]);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.find(r=>r.status==='rejected')).toMatchObject({reason:{code:'storage-quota-exceeded'}});expect(await service.status(uid)).toMatchObject({usedBytes:0,reservedBytes:64_000_000,pendingBytes:64_000_000});
  });
  it('serializes competing updates, rejects stale revisions, and never mixes chunk revisions',async()=>{
    const uid=await owner(),first=await save(uid,[Buffer.from('first')]);const a=await reserve(uid,[Buffer.from('second')],first.project);
    await expect(reserve(uid,[Buffer.from('competing')],first.project)).rejects.toMatchObject({code:'upload-in-progress'});await service.put(uid,a.uploadId,0,async()=>Buffer.from('second'));const second=await service.commit(uid,a.uploadId,{});
    expect(second.revision).toBe('2');await expect(reserve(uid,[Buffer.from('stale')],first.project)).rejects.toMatchObject({code:'project-conflict',details:{project:{revision:'2'}}});await expect(service.chunk(uid,second.id,0,'1')).rejects.toMatchObject({code:'project-conflict'});expect(await service.chunk(uid,second.id,0,'2')).toEqual(Buffer.from('second'));
    expect(await service.commit(uid,a.uploadId,{})).toEqual(second);
  });
  it('verifies reserved length/SHA, rejects incomplete or missing-object commits and repairs retries',async()=>{
    const uid=await owner(),data=Buffer.from('all results'),upload=await reserve(uid,[data]);
    await expect(service.put(uid,upload.uploadId,0,async()=>Buffer.from('wrong'))).rejects.toMatchObject({code:'invalid-project-request'});await expect(service.commit(uid,upload.uploadId,{})).rejects.toMatchObject({code:'upload-incomplete'});
    await service.put(uid,upload.uploadId,0,async()=>data);const key=(await db.query('SELECT object_name FROM cloud_project_chunks WHERE upload_id=$1',[upload.uploadId])).rows[0].object_name;objects.rows.delete(key);
    await expect(service.commit(uid,upload.uploadId,{})).rejects.toMatchObject({code:'upload-object-missing'});await service.put(uid,upload.uploadId,0,async()=>data);expect((await service.commit(uid,upload.uploadId,{})).bytes).toBe(data.length);
  });
  it('keeps failed-expiry cleanup physically charged and releases bytes only after confirmed deletion',async()=>{
    const uid=await owner(),data=Buffer.from('expired artifact'),upload=await reserve(uid,[data]);await service.put(uid,upload.uploadId,0,async()=>data);clock=new Date(clock.getTime()+1800001);objects.failDelete=true;
    expect(await service.recover()).toMatchObject({failed:expect.any(Number)});expect(await service.status(uid)).toMatchObject({reservedBytes:0,pendingBytes:data.length});await expect(service.commit(uid,upload.uploadId,{})).rejects.toMatchObject({code:'upload-expired'});
    objects.failDelete=false;await service.recover();expect(await service.status(uid)).toMatchObject({pendingBytes:0});expect((await db.query('SELECT count(*) n FROM cloud_project_cleanup WHERE account_id=$1',[uid])).rows[0].n).toBe('0');
  });
  it('deletes idempotently, records tombstones, and keeps deleted content unavailable during cleanup failure',async()=>{
    const uid=await owner(),{project}=await save(uid,[Buffer.from('delete privately')]),key=randomUUID(),body={baseRevision:project.revision};
    objects.failDelete=true;const deleted=await service.remove(uid,project.id,key,body);expect(deleted.deletedAt).not.toBeNull();expect(deleted.name).toBe('');expect(await service.remove(uid,project.id,key,body)).toEqual(deleted);expect((await service.list(uid)).projects).toEqual([deleted]);await expect(service.read(uid,project.id)).rejects.toMatchObject({status:404});await expect(service.chunk(uid,project.id,0,'1')).rejects.toMatchObject({status:404});expect((await service.status(uid)).usedBytes).toBe(0);expect(await service.purge(uid)).toBe(false);
    objects.failDelete=false;expect(await service.purge(uid)).toBe(true);expect(await service.metadata(uid)).toEqual([]);
  });
  it('rechecks downgrade entitlements at commit while retaining reads and deletes of existing projects',async()=>{
    const uid=await owner(),small=await save(uid,[Buffer.from('old')]);await creditLedger(db,now,randomUUID).grant({accountId:uid,source:`fixture:${randomUUID()}`,plan:'plus',startsAt:clock,expiresAt:new Date(clock.getTime()+30_000)});
    expect((await service.status(uid)).limitBytes).toBe(2_000_000_000);const data=Buffer.alloc(8_000_000,7),chunks=Array.from({length:13},()=>data),upload=await reserve(uid,chunks,small.project);for(const [index,bytes] of chunks.entries())await service.put(uid,upload.uploadId,index,async()=>bytes);
    clock=new Date(clock.getTime()+60_000);await expect(service.commit(uid,upload.uploadId,{})).rejects.toMatchObject({code:'storage-quota-exceeded'});expect((await service.read(uid,small.project.id)).project.revision).toBe('1');expect((await service.remove(uid,small.project.id,randomUUID(),{baseRevision:'1'})).deletedAt).not.toBeNull();
  });
  it('freezes late writes during account deletion and waits for in-flight object cleanup before purging',async()=>{
    const uid=await owner(),data=Buffer.from('late result'),upload=await reserve(uid,[data]);let release!:()=>void;objects.gate=new Promise<void>(resolve=>{release=resolve});const writing=service.put(uid,upload.uploadId,0,async()=>data);await vi.waitFor(async()=>expect((await db.query('SELECT lease_owner FROM cloud_project_chunks WHERE upload_id=$1',[upload.uploadId])).rows[0].lease_owner).not.toBeNull());await db.query("UPDATE accounts SET status='deleting' WHERE id=$1",[uid]);expect(await service.purge(uid)).toBe(false);release();objects.gate=undefined;await expect(writing).rejects.toMatchObject({code:'upload-expired'});clock=new Date(clock.getTime()+300001);expect(await service.purge(uid)).toBe(true);expect((await db.query('SELECT count(*) n FROM cloud_projects WHERE account_id=$1',[uid])).rows[0].n).toBe('0');await expect(service.list(uid)).rejects.toMatchObject({code:'account-inactive'});
  });
  it('bounds global physical exposure, malformed requests and per-owner rates independently of AI credits',async()=>{
    const uid=await owner(),tiny=cloudProjects({db,account,objects,now,newId:randomUUID,globalBytes:1});await expect(tiny.reserve(uid,randomUUID(),{name:'bounded',baseRevision:null,manifest:manifest([Buffer.from('two')])})).rejects.toMatchObject({code:'storage-capacity-unavailable'});
    await expect(service.reserve(uid,randomUUID(),{name:'bad',baseRevision:null,manifest:{format:'femlab-project/1',bytes:9_000_000,chunks:[{bytes:9_000_000,sha256:'a'.repeat(64)}]}})).rejects.toMatchObject({code:'invalid-project-request'});await expect(service.reserve(uid,'bad key',{})).rejects.toMatchObject({code:'idempotency-key-required'});
    await expect(service.reserve(uid,randomUUID(),{name:'metadata amplification',baseRevision:null,manifest:{format:'femlab-project/1',bytes:8192,chunks:Array.from({length:8192},()=>({bytes:1,sha256:'a'.repeat(64)}))}})).rejects.toMatchObject({code:'invalid-project-request'});
    await db.query('INSERT INTO cloud_project_rates(account_id,starts_at,reads,writes) VALUES($1,$2,240,0) ON CONFLICT(account_id) DO UPDATE SET starts_at=$2,reads=240',[uid,clock]);await expect(service.list(uid)).rejects.toMatchObject({code:'project-rate-limit'});clock=new Date(clock.getTime()+60001);expect((await service.list(uid)).storage.limitBytes).toBe(100_000_000);
  });
  it('bounds tiny-project metadata across many different accounts under the same admission lock',async()=>{
    const body={name:'one byte',baseRevision:null,manifest:manifest([Buffer.from('x')])};
    for(const [field,table] of [['globalProjects','cloud_projects'],['globalUploads','cloud_project_uploads'],['globalChunks','cloud_project_chunks']] as const){
      const before=Number((await db.query(`SELECT count(*) n FROM ${table}`)).rows[0].n),bounded=cloudProjects({db,account,objects,now,newId:randomUUID,metadataLimits:{[field]:before+2}}),uids=await Promise.all(Array.from({length:5},()=>owner()));
      const results=await Promise.allSettled(uids.map(uid=>bounded.reserve(uid,randomUUID(),body)));
      expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(2);expect(results.filter(r=>r.status==='rejected')).toHaveLength(3);expect(Number((await db.query(`SELECT count(*) n FROM ${table}`)).rows[0].n)).toBe(before+2);
    }
    const uid=await owner(),bounded=cloudProjects({db,account,objects,now,newId:randomUUID,metadataLimits:{accountPending:2}});
    await bounded.reserve(uid,randomUUID(),body);await bounded.reserve(uid,randomUUID(),body);await expect(bounded.reserve(uid,randomUUID(),body)).rejects.toMatchObject({code:'storage-metadata-capacity'});expect((await service.status(uid)).pendingBytes).toBe(2);
  });
  it('reads quota without consuming storage account slots and keeps profiles available when upload capacity is full',async()=>{
    const baseline=Number((await db.query('SELECT count(*) n FROM cloud_storage_accounts')).rows[0].n),bounded=cloudProjects({db,account,objects,now,newId:randomUUID,metadataLimits:{accounts:baseline+1}}),first=await owner(),second=await owner();
    expect(await bounded.status(first)).toMatchObject({available:true,usedBytes:0});expect((await db.query('SELECT count(*) n FROM cloud_storage_accounts')).rows[0].n).toBe(String(baseline));
    await bounded.reserve(first,randomUUID(),{name:'uses one slot',baseRevision:null,manifest:manifest([Buffer.from('x')])});expect(await bounded.status(second)).toMatchObject({available:false,usedBytes:0,limitBytes:100_000_000});await expect(bounded.reserve(second,randomUUID(),{name:'full',baseRevision:null,manifest:manifest([Buffer.from('x')])})).rejects.toMatchObject({code:'storage-metadata-capacity'});expect((await db.query('SELECT 1 FROM cloud_storage_accounts WHERE account_id=$1',[second])).rows).toHaveLength(0);
  });
  it('preserves HTTP authentication, conflict details and private binary download headers',async()=>{
    const uid=await owner(),data=Buffer.from('model, files, retained results and outputs'),server=serviceServer({now,newId:randomUUID,ready:async()=>true,projects:service,origins:['https://femlab.app']});server.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://127.0.0.1:${(server.address() as AddressInfo).port}`,json={'content-type':'application/json',authorization:uid,'idempotency-key':randomUUID()};
    try{
      const preflight=await fetch(origin+'/v1/projects',{method:'OPTIONS',headers:{origin:'https://femlab.app'}});expect(preflight.headers.get('access-control-allow-methods')).toContain('PUT');expect(preflight.headers.get('access-control-allow-origin')).toBe('https://femlab.app');
      expect((await fetch(origin+'/v1/projects')).status).toBe(401);
      const reserved=await fetch(origin+'/v1/projects/uploads',{method:'POST',headers:json,body:JSON.stringify({name:'HTTP project',baseRevision:null,manifest:manifest([data])})});expect(reserved.status).toBe(200);const upload=await reserved.json() as {uploadId:string;projectId:string};
      expect((await fetch(origin+`/v1/projects/uploads/${upload.uploadId}/chunks/0`,{method:'PUT',headers:{authorization:uid,'content-type':'text/plain'},body:data})).status).toBe(415);
      expect((await fetch(origin+`/v1/projects/uploads/${upload.uploadId}/chunks/0`,{method:'PUT',headers:{authorization:uid,'content-type':'application/octet-stream'},body:data})).status).toBe(200);
      const saved=await (await fetch(origin+`/v1/projects/uploads/${upload.uploadId}/commit`,{method:'POST',headers:json,body:'{}'})).json() as CloudProject;
      const response=await fetch(origin+`/v1/projects/${saved.id}/chunks/0?revision=1`,{headers:{authorization:uid}});expect(response.status).toBe(200);expect(response.headers.get('content-type')).toBe('application/octet-stream');expect(response.headers.get('content-disposition')).toContain('attachment');expect(response.headers.get('cache-control')).toBe('no-store');expect(response.headers.get('x-content-type-options')).toBe('nosniff');expect(Buffer.from(await response.arrayBuffer())).toEqual(data);
      const conflict=await fetch(origin+`/v1/projects/${saved.id}/chunks/0?revision=0`,{headers:{authorization:uid}});expect(conflict.status).toBe(409);expect(await conflict.json()).toMatchObject({code:'project-conflict',details:{project:{id:saved.id,revision:'1'}}});
      const another=await reserve(uid,[data]);const tooLarge=await fetch(origin+`/v1/projects/uploads/${another.uploadId}/chunks/0`,{method:'PUT',headers:{authorization:uid,'content-type':'application/octet-stream'},body:Buffer.alloc(8_000_001)});expect(tooLarge.status).toBe(413);
    }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))}
  });
  it('account deletion cannot finish while cloud content remains and removes all project metadata before identity deletion',async()=>{
    const uid=await owner(),{project}=await save(uid,[Buffer.from('personal cloud data')]),identityRemove=vi.fn(async()=>{}),privacy=accountPrivacy({db,account,recentIdentity:async header=>{const row=(await db.query('SELECT firebase_uid,email FROM accounts WHERE id=$1',[header])).rows[0];return {uid:String(row.firebase_uid),email:String(row.email)}},objects:{write:async()=>{},url:async()=>'',remove:async()=>{}},identity:{remove:identityRemove},projects:service,now,newId:randomUUID});
    expect(await privacy.delete(uid,{confirm:'DELETE'})).toEqual({status:'queued'});objects.failDelete=true;expect(await privacy.recover()).toMatchObject({pending:1});expect(identityRemove).not.toHaveBeenCalled();expect((await db.query('SELECT status FROM accounts WHERE id=$1',[uid])).rows[0].status).toBe('deleting');
    objects.failDelete=false;expect(await privacy.recover()).toMatchObject({deleted:1});expect(identityRemove).toHaveBeenCalledOnce();expect((await db.query('SELECT status FROM accounts WHERE id=$1',[uid])).rows[0].status).toBe('deleted');expect((await db.query('SELECT count(*) n FROM cloud_projects WHERE id=$1',[project.id])).rows[0].n).toBe('0');expect((await db.query('SELECT count(*) n FROM cloud_project_chunks WHERE account_id=$1',[uid])).rows[0].n).toBe('0');
  });
});
