import {createHash} from 'node:crypto';
import {z} from 'zod';
import {PROJECT_CHUNK_BYTES,PROJECT_MAX_CHUNKS,PROJECT_STORAGE_QUOTAS,type AccountPlan,type CloudProject,type CloudProjectManifest,type CloudProjectUploadRequest,type CloudStorageStatus} from '@femlab/registry';
import type {Account,Sql} from './accounts';
import type {Database} from './transactions';
import {ServiceFailure} from './errors';

export interface ProjectObjectInfo {bytes:number;sha256:string;generation:string}
/** Keys are server-owned. Writes are create-only and must finish/cancel within 30 seconds. */
export interface ProjectObjects {
  put(name:string,bytes:Buffer,sha256:string):Promise<ProjectObjectInfo>;
  stat(name:string):Promise<ProjectObjectInfo|null>;
  read(name:string,generation:string):Promise<Buffer>;
  remove(name:string,generation:string|undefined):Promise<void>;
}
const METADATA_LIMITS={accounts:10000,rateAccounts:10000,accountProjects:10000,globalProjects:100000,accountUploads:100000,globalUploads:1000000,accountPending:4,globalPending:1000,accountChunks:100000,globalChunks:1000000};
interface Dependencies {db:Database;account(header:string|undefined):Promise<Account>;objects:ProjectObjects;now():Date;newId():string;globalBytes?:number;metadataLimits?:Partial<Record<keyof typeof METADATA_LIMITS,number>>}
type Row=Record<string,unknown>;
const hash=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const revision=z.string().regex(/^(0|[1-9][0-9]{0,17})$/);
const manifestSchema=z.strictObject({format:z.literal('femlab-project/1'),bytes:z.number().int().positive().max(50_000_000_000),chunks:z.array(z.strictObject({bytes:z.number().int().positive().max(PROJECT_CHUNK_BYTES),sha256:z.string().regex(/^[a-f0-9]{64}$/)})).min(1).max(PROJECT_MAX_CHUNKS)});
const reserveSchema=z.strictObject({projectId:z.string().uuid().optional(),baseRevision:revision.nullable(),name:z.string().trim().min(1).max(200),manifest:manifestSchema});
const keySchema=z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/);
const idSchema=z.string().uuid();
const denied=()=>new ServiceFailure(404,'project-not-found','This cloud project is not available.','project');
const invalid=(cause:string)=>new ServiceFailure(422,'invalid-project-request',cause,'project');
const summary=(row:Row):CloudProject=>({id:String(row.id),name:String(row.name),revision:String(row.revision),changeVersion:String(row.change_version),bytes:Number(row.bytes),updatedAt:(row.updated_at as Date).toISOString(),deletedAt:row.deleted_at?(row.deleted_at as Date).toISOString():null});
const conflict=(row:Row)=>new ServiceFailure(409,'project-conflict','The cloud project changed. Refresh it or save a separate copy.','project','project.refresh',{project:summary(row)});
const sameObject=(info:ProjectObjectInfo|null,row:Row)=>info&&info.bytes===Number(row.bytes)&&info.sha256===row.sha256&&info.generation===row.generation;

/** Account ownership and every byte counter commit under the same cross-instance storage lock. */
export function cloudProjects(deps:Dependencies) {
  const {db,objects,now,newId}=deps;
  const globalBytes=deps.globalBytes??100_000_000_000;
  const limits={...METADATA_LIMITS,...deps.metadataLimits};
  if(!Number.isSafeInteger(globalBytes)||globalBytes<1)throw new Error('Invalid project storage global byte cap.');
  async function atomic<T>(fn:(sql:Sql)=>Promise<T>):Promise<T>{const c=await db.connect();try{await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(774774)');const value=await fn(c);await c.query('COMMIT');return value}catch(error){await c.query('ROLLBACK');throw error}finally{c.release()}}
  async function active(sql:Sql,id:string,allocate=false){const row=(await sql.query('SELECT status FROM accounts WHERE id=$1 FOR UPDATE',[id])).rows[0];if(row?.status!=='active')throw new ServiceFailure(403,'account-inactive','This account cannot access cloud projects.','project');if(allocate){if(!(await sql.query('SELECT 1 FROM cloud_storage_accounts WHERE account_id=$1',[id])).rows.length&&Number((await sql.query('SELECT count(*) n FROM cloud_storage_accounts')).rows[0]!.n)>=limits.accounts)throw new ServiceFailure(503,'storage-metadata-capacity','Cloud project account capacity is temporarily unavailable.','project');await sql.query('INSERT INTO cloud_storage_accounts(account_id) VALUES($1) ON CONFLICT DO NOTHING',[id]);}}
  async function rate(sql:Sql,id:string,write:boolean){
    await active(sql,id);
    if(!(await sql.query('SELECT 1 FROM cloud_project_rates WHERE account_id=$1',[id])).rows.length&&Number((await sql.query('SELECT count(*) n FROM cloud_project_rates')).rows[0]!.n)>=limits.rateAccounts)throw new ServiceFailure(503,'storage-metadata-capacity','Cloud project request capacity is temporarily unavailable.','project');
    const row=(await sql.query(`INSERT INTO cloud_project_rates(account_id,starts_at,reads,writes) VALUES($1,$2,$3,$4)
      ON CONFLICT(account_id) DO UPDATE SET starts_at=CASE WHEN cloud_project_rates.starts_at <= $5 THEN $2 ELSE cloud_project_rates.starts_at END,
      reads=CASE WHEN cloud_project_rates.starts_at <= $5 THEN $3 ELSE cloud_project_rates.reads+$3 END,
      writes=CASE WHEN cloud_project_rates.starts_at <= $5 THEN $4 ELSE cloud_project_rates.writes+$4 END RETURNING reads,writes`,[id,now(),write?0:1,write?1:0,new Date(now().getTime()-60000)])).rows[0]!;
    if(Number(row.reads)>240||Number(row.writes)>240)throw new ServiceFailure(429,'project-rate-limit','Wait a minute before making more cloud project requests.','project');
  }
  async function storage(sql:Sql,id:string):Promise<CloudStorageStatus>{
    const paid=(await sql.query(`SELECT g.plan FROM credit_grants g LEFT JOIN billing_accounts b ON b.account_id=g.account_id WHERE g.account_id=$1 AND g.starts_at<=$2 AND g.expires_at>$2 AND g.plan<>'free' AND NOT COALESCE(b.blocked,false) ORDER BY CASE g.plan WHEN 'studio' THEN 3 WHEN 'pro' THEN 2 ELSE 1 END DESC LIMIT 1`,[id,now()])).rows[0];
    const plan=(paid?.plan??'free') as AccountPlan,limitBytes=PROJECT_STORAGE_QUOTAS[plan];
    const row=(await sql.query('SELECT used_bytes,reserved_bytes,pending_bytes FROM cloud_storage_accounts WHERE account_id=$1',[id])).rows[0];
    const cleanup=Number((await sql.query('SELECT COALESCE(sum(bytes),0) bytes FROM cloud_project_cleanup WHERE account_id=$1 AND NOT pending',[id])).rows[0]!.bytes);
    const usedBytes=Number(row?.used_bytes??0),reservedBytes=Number(row?.reserved_bytes??0),pendingBytes=Number(row?.pending_bytes??0)+cleanup;
    const available=Boolean(row)||Number((await sql.query('SELECT count(*) n FROM cloud_storage_accounts')).rows[0]!.n)<limits.accounts;
    return {available,plan,limitBytes,usedBytes,reservedBytes,pendingBytes,overQuota:usedBytes>limitBytes,maxChunkBytes:PROJECT_CHUNK_BYTES};
  }
  async function project(sql:Sql,id:string,owner:string){const row=(await sql.query('SELECT * FROM cloud_projects WHERE id=$1 AND account_id=$2',[id,owner])).rows[0];if(!row)throw denied();return row}
  async function upload(sql:Sql,id:string,owner:string){const row=(await sql.query('SELECT * FROM cloud_project_uploads WHERE id=$1 AND account_id=$2',[id,owner])).rows[0];if(!row)throw denied();return row}
  async function enqueue(sql:Sql,uploadId:string){await sql.query(`INSERT INTO cloud_project_cleanup(object_name,account_id,generation,pending,bytes,not_before)
    SELECT object_name,account_id,generation,pending_charged,bytes,GREATEST($2,COALESCE(lease_expires_at,$2)) FROM cloud_project_chunks WHERE upload_id=$1 AND NOT removed
    ON CONFLICT(object_name) DO UPDATE SET generation=COALESCE(EXCLUDED.generation,cloud_project_cleanup.generation),not_before=GREATEST(cloud_project_cleanup.not_before,EXCLUDED.not_before)`,[uploadId,now()]);}
  async function abort(sql:Sql,row:Row,state:'expired'|'aborted'){
    if(row.state!=='reserved')return;
    await sql.query('UPDATE cloud_project_uploads SET state=$2 WHERE id=$1',[row.id,state]);
    await sql.query('UPDATE cloud_storage_accounts SET reserved_bytes=reserved_bytes-$2 WHERE account_id=$1',[row.account_id,row.reserved_bytes]);
    await enqueue(sql,String(row.id));
    // A never-committed creation must not consume an invisible active-project slot forever.
    await sql.query("UPDATE cloud_projects SET name='',deleted_at=$3,updated_at=$3 WHERE id=$1 AND account_id=$2 AND revision=0",[row.project_id,row.account_id,now()]);
  }
  async function expire(sql:Sql){const rows=(await sql.query("SELECT * FROM cloud_project_uploads WHERE state='reserved' AND expires_at<=$1 ORDER BY expires_at LIMIT 100",[now()])).rows;for(const row of rows)await abort(sql,row,'expired');}
  function validId(id:string){if(!idSchema.safeParse(id).success)throw denied()}
  function validKey(key:unknown){const parsed=keySchema.safeParse(key);if(!parsed.success)throw new ServiceFailure(422,'idempotency-key-required','Supply a stable Idempotency-Key for this cloud project operation.','project');return parsed.data}
  async function status(accountId:string){return atomic(async sql=>{await active(sql,accountId);return storage(sql,accountId)})}
  async function list(header:string|undefined,after='0'){
    if(!revision.safeParse(after).success)throw invalid('Use a valid cloud project change cursor.');
    const owner=await deps.account(header);
    return atomic(async sql=>{await rate(sql,owner.id,false);const rows=(await sql.query('SELECT * FROM cloud_projects WHERE account_id=$1 AND revision>0 AND change_version>$2 ORDER BY change_version LIMIT 101',[owner.id,after])).rows;const page=rows.slice(0,100);return {projects:page.map(summary),nextCursor:rows.length>100?String(page.at(-1)!.change_version):null,storage:await storage(sql,owner.id)}});
  }
  async function read(header:string|undefined,id:string){validId(id);const owner=await deps.account(header);return atomic(async sql=>{await rate(sql,owner.id,false);const row=await project(sql,id,owner.id);if(row.deleted_at||!row.manifest)throw denied();return {project:summary(row),manifest:row.manifest as CloudProjectManifest}})}
  async function reserve(header:string|undefined,key:unknown,body:unknown){
    const requestKey=validKey(key),parsed=reserveSchema.safeParse(body);if(!parsed.success)throw invalid('Supply a name, base revision and a complete chunk manifest.');
    const input:CloudProjectUploadRequest=parsed.data;
    if(input.manifest.chunks.reduce((n,c)=>n+c.bytes,0)!==input.manifest.bytes||input.manifest.chunks.length!==Math.ceil(input.manifest.bytes/PROJECT_CHUNK_BYTES)||input.manifest.chunks.slice(0,-1).some(c=>c.bytes!==PROJECT_CHUNK_BYTES)||Boolean(input.projectId)!==(input.baseRevision!==null))throw invalid('Use fixed 8,000,000-byte chunks followed by one final chunk; existing projects require a base revision.');
    const owner=await deps.account(header),digest=hash(JSON.stringify(input));
    return atomic(async sql=>{
      await rate(sql,owner.id,true);await active(sql,owner.id,true);await expire(sql);
      const replay=(await sql.query('SELECT * FROM cloud_project_uploads WHERE account_id=$1 AND request_key=$2',[owner.id,requestKey])).rows[0];
      if(replay){if(replay.request_sha256!==digest)throw new ServiceFailure(409,'idempotency-conflict','This idempotency key was used for a different upload.','project');if(['expired','aborted'].includes(String(replay.state)))throw new ServiceFailure(410,'upload-expired','Start a new upload with a new idempotency key.','project');return uploadView(sql,replay)}
      const counts=(await sql.query(`SELECT
        (SELECT count(*) FROM cloud_projects WHERE account_id=$1) account_projects,(SELECT count(*) FROM cloud_projects) global_projects,
        (SELECT count(*) FROM cloud_project_uploads WHERE account_id=$1) account_uploads,(SELECT count(*) FROM cloud_project_uploads) global_uploads,
        (SELECT count(*) FROM cloud_project_uploads WHERE account_id=$1 AND state='reserved') account_pending,(SELECT count(*) FROM cloud_project_uploads WHERE state='reserved') global_pending,
        (SELECT count(*) FROM cloud_project_chunks WHERE account_id=$1) account_chunks,(SELECT count(*) FROM cloud_project_chunks) global_chunks`,[owner.id])).rows[0]!;
      if((!input.projectId&&(Number(counts.account_projects)>=limits.accountProjects||Number(counts.global_projects)>=limits.globalProjects))||Number(counts.account_uploads)>=limits.accountUploads||Number(counts.global_uploads)>=limits.globalUploads||Number(counts.account_pending)>=limits.accountPending||Number(counts.global_pending)>=limits.globalPending||Number(counts.account_chunks)+input.manifest.chunks.length>limits.accountChunks||Number(counts.global_chunks)+input.manifest.chunks.length>limits.globalChunks)throw new ServiceFailure(503,'storage-metadata-capacity','Cloud project upload capacity is temporarily unavailable. Finish pending uploads or retry later.','project');
      const state=await storage(sql,owner.id),projectId=input.projectId??newId();
      let previous:Row;
      if(input.projectId){previous=await project(sql,projectId,owner.id);if(previous.deleted_at||String(previous.revision)!==input.baseRevision)throw conflict(previous)}
      else {if(Number((await sql.query('SELECT count(*) n FROM cloud_projects WHERE account_id=$1 AND deleted_at IS NULL',[owner.id])).rows[0]!.n)>=1000)throw new ServiceFailure(409,'project-count-limit','Delete an unused cloud project before creating another.','project');previous=(await sql.query('INSERT INTO cloud_projects(id,account_id,name,updated_at) VALUES($1,$2,$3,$4) RETURNING *',[projectId,owner.id,input.name,now()])).rows[0]!}
      if((await sql.query("SELECT id FROM cloud_project_uploads WHERE project_id=$1 AND state='reserved'",[projectId])).rows.length)throw new ServiceFailure(409,'upload-in-progress','Finish or wait for the existing upload to expire.','project');
      const reserved=Math.max(0,input.manifest.bytes-Number(previous.bytes));
      if(state.usedBytes+state.reservedBytes+reserved>state.limitBytes||state.pendingBytes+input.manifest.bytes>state.limitBytes)throw new ServiceFailure(413,'storage-quota-exceeded','Delete cloud content or choose a plan with more storage before uploading.','project','account.open');
      const exposure=Number((await sql.query('SELECT COALESCE((SELECT sum(used_bytes+pending_bytes) FROM cloud_storage_accounts),0)+COALESCE((SELECT sum(bytes) FROM cloud_project_cleanup WHERE NOT pending),0) bytes')).rows[0]!.bytes);
      if(exposure+input.manifest.bytes>globalBytes)throw new ServiceFailure(503,'storage-capacity-unavailable','Cloud upload capacity is temporarily unavailable. Existing projects remain readable.','project');
      const row=(await sql.query(`INSERT INTO cloud_project_uploads(id,account_id,project_id,base_revision,request_key,request_sha256,name,manifest,bytes,reserved_bytes,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,[newId(),owner.id,projectId,previous.revision,requestKey,digest,input.name,JSON.stringify(input.manifest),input.manifest.bytes,reserved,now(),new Date(now().getTime()+1800000)])).rows[0]!;
      const chunks=input.manifest.chunks;await sql.query('INSERT INTO cloud_project_chunks(upload_id,account_id,chunk_index,bytes,sha256,object_name) SELECT $1,$2,* FROM unnest($3::integer[],$4::integer[],$5::text[],$6::text[])',[row.id,owner.id,chunks.map((_,index)=>index),chunks.map(c=>c.bytes),chunks.map(c=>c.sha256),chunks.map((_,index)=>`projects/${owner.id}/${row.id}/${index}`)]);
      await sql.query('UPDATE cloud_storage_accounts SET reserved_bytes=reserved_bytes+$2,pending_bytes=pending_bytes+$3 WHERE account_id=$1',[owner.id,reserved,input.manifest.bytes]);
      return uploadView(sql,row);
    });
  }
  async function uploadView(sql:Sql,row:Row){return {uploadId:String(row.id),projectId:String(row.project_id),expiresAt:(row.expires_at as Date).toISOString(),missingChunks:(await sql.query('SELECT chunk_index FROM cloud_project_chunks WHERE upload_id=$1 AND generation IS NULL ORDER BY chunk_index',[row.id])).rows.map(c=>Number(c.chunk_index))}}
  async function put(header:string|undefined,id:string,index:number,readBody:()=>Promise<Buffer>){
    validId(id);if(!Number.isInteger(index)||index<0||index>=PROJECT_MAX_CHUNKS)throw denied();
    const owner=await deps.account(header),lease=newId();
    const chunk=await atomic(async sql=>{await rate(sql,owner.id,true);const row=await upload(sql,id,owner.id);if(row.state!=='reserved'||(row.expires_at as Date)<=now())throw new ServiceFailure(410,'upload-expired','Start a new project upload.','project');const chunk=(await sql.query('SELECT * FROM cloud_project_chunks WHERE upload_id=$1 AND chunk_index=$2',[id,index])).rows[0];if(!chunk)throw denied();if(chunk.lease_owner&&(chunk.lease_expires_at as Date)>now())throw new ServiceFailure(409,'chunk-in-progress','This chunk is still uploading. Retry shortly.','project');await sql.query('UPDATE cloud_project_chunks SET lease_owner=$3,lease_expires_at=$4 WHERE upload_id=$1 AND chunk_index=$2',[id,index,lease,new Date(now().getTime()+300000)]);return chunk});
    try {
      const bytes=await readBody();if(bytes.length!==Number(chunk.bytes)||hash(bytes)!==chunk.sha256)throw invalid('Chunk bytes or SHA-256 do not match the reserved manifest.');
      const info=await objects.put(String(chunk.object_name),bytes,String(chunk.sha256));
      if(info.bytes!==bytes.length||info.sha256!==chunk.sha256)throw new ServiceFailure(503,'project-object-invalid','Cloud storage did not confirm the uploaded bytes.','project');
      const accepted=await atomic(async sql=>{const row=await upload(sql,id,owner.id);const fresh=(await sql.query('SELECT status FROM accounts WHERE id=$1 FOR UPDATE',[owner.id])).rows[0];await sql.query('UPDATE cloud_project_chunks SET generation=$3,removed=false WHERE upload_id=$1 AND chunk_index=$2 AND lease_owner=$4',[id,index,info.generation,lease]);if(row.state!=='reserved'||(row.expires_at as Date)<=now()||fresh?.status!=='active'){await enqueue(sql,id);return false}return true;});
      if(!accepted)throw new ServiceFailure(410,'upload-expired','This upload ended before the chunk was accepted.','project');
      return {status:'uploaded' as const};
    } finally {await atomic(async sql=>{await sql.query('UPDATE cloud_project_chunks SET lease_owner=NULL,lease_expires_at=NULL WHERE upload_id=$1 AND chunk_index=$2 AND lease_owner=$3',[id,index,lease]);});}
  }
  async function commit(header:string|undefined,id:string,body:unknown){
    validId(id);if(!z.strictObject({}).safeParse(body).success)throw invalid('Commit accepts no metadata changes.');const owner=await deps.account(header);
    const snapshot=await atomic(async sql=>{await rate(sql,owner.id,true);const row=await upload(sql,id,owner.id);if(row.state==='committed')return {row,chunks:[]};if(row.state!=='reserved'||(row.expires_at as Date)<=now())throw new ServiceFailure(410,'upload-expired','Start a new upload.','project');const chunks=(await sql.query('SELECT * FROM cloud_project_chunks WHERE upload_id=$1 ORDER BY chunk_index',[id])).rows;if(chunks.some(c=>!c.generation||c.lease_owner))throw new ServiceFailure(409,'upload-incomplete','Finish every chunk before committing.','project');return {row,chunks}});
    if(snapshot.row.state==='committed')return snapshot.row.receipt as CloudProject;
    let cursor=0,stopped=false;
    await Promise.all(Array.from({length:Math.min(32,snapshot.chunks.length)},async()=>{
      try {for(;;){if(stopped)return;const index=cursor++,chunk=snapshot.chunks[index];if(!chunk)return;
        if(!sameObject(await objects.stat(String(chunk.object_name)),chunk)){
          stopped=true;
          await atomic(async sql=>{await active(sql,owner.id);const row=await upload(sql,id,owner.id);if(row.state==='reserved')await sql.query('UPDATE cloud_project_chunks SET generation=NULL WHERE upload_id=$1 AND chunk_index=$2 AND generation=$3 AND lease_owner IS NULL',[id,index,chunk.generation]);});
          throw new ServiceFailure(409,'upload-object-missing','A reserved chunk is missing or changed. Resume the upload before committing.','project',null,{missingChunks:[index]});
        }
      }}catch(error){stopped=true;throw error}
    }));
    return atomic(async sql=>{await active(sql,owner.id);const row=await upload(sql,id,owner.id);if(row.state==='committed')return row.receipt as CloudProject;if(row.state!=='reserved'||(row.expires_at as Date)<=now())throw new ServiceFailure(410,'upload-expired','Start a new upload.','project');const previous=await project(sql,String(row.project_id),owner.id);if(previous.deleted_at||String(previous.revision)!==String(row.base_revision))throw conflict(previous);if((await sql.query('SELECT 1 FROM cloud_project_chunks WHERE upload_id=$1 AND lease_owner IS NOT NULL',[id])).rows.length)throw new ServiceFailure(409,'chunk-in-progress','A chunk is still uploading. Retry shortly.','project');const state=await storage(sql,owner.id);if(state.usedBytes-Number(previous.bytes)+Number(row.bytes)>state.limitBytes)throw new ServiceFailure(413,'storage-quota-exceeded','Your current plan does not have enough storage. Delete cloud content before retrying.','project');
      if(previous.current_upload_id)await enqueue(sql,String(previous.current_upload_id));
      const counter=(await sql.query('UPDATE cloud_storage_accounts SET used_bytes=used_bytes-$2+$3,reserved_bytes=reserved_bytes-$4,pending_bytes=pending_bytes-$3,change_version=change_version+1 WHERE account_id=$1 RETURNING change_version',[owner.id,previous.bytes,row.bytes,row.reserved_bytes])).rows[0]!;
      const saved=(await sql.query('UPDATE cloud_projects SET name=$3,revision=revision+1,change_version=$4,bytes=$5,manifest=$6,current_upload_id=$7,updated_at=$8 WHERE id=$1 AND account_id=$2 RETURNING *',[row.project_id,owner.id,row.name,counter.change_version,row.bytes,JSON.stringify(row.manifest),id,now()])).rows[0]!;
      const receipt=summary(saved);await sql.query("UPDATE cloud_project_uploads SET state='committed',receipt=$2 WHERE id=$1",[id,JSON.stringify(receipt)]);await sql.query('UPDATE cloud_project_chunks SET pending_charged=false WHERE upload_id=$1',[id]);return receipt;
    });
  }
  async function chunk(header:string|undefined,id:string,index:number,expected:string){validId(id);if(!revision.safeParse(expected).success||!Number.isInteger(index)||index<0||index>=PROJECT_MAX_CHUNKS)throw invalid('Read a specific project revision and chunk index.');const owner=await deps.account(header);const row=await atomic(async sql=>{await rate(sql,owner.id,false);const saved=await project(sql,id,owner.id);if(saved.deleted_at||!saved.current_upload_id)throw denied();if(String(saved.revision)!==expected)throw conflict(saved);const row=(await sql.query('SELECT * FROM cloud_project_chunks WHERE upload_id=$1 AND chunk_index=$2 AND account_id=$3',[saved.current_upload_id,index,owner.id])).rows[0];if(!row?.generation)throw denied();return row});const bytes=await objects.read(String(row.object_name),String(row.generation));if(bytes.length!==Number(row.bytes)||hash(bytes)!==row.sha256)throw new ServiceFailure(503,'project-object-invalid','The saved project bytes could not be verified. Retry later.','project');await atomic(async sql=>{await active(sql,owner.id);const current=await project(sql,id,owner.id);if(current.deleted_at||String(current.revision)!==expected)throw conflict(current)});return bytes}
  async function remove(header:string|undefined,id:string,key:unknown,body:unknown){validId(id);const requestKey=validKey(key),parsed=z.strictObject({baseRevision:revision}).safeParse(body);if(!parsed.success)throw invalid('Delete requires the current base revision.');const owner=await deps.account(header),digest=hash(JSON.stringify({id,baseRevision:parsed.data.baseRevision}));return atomic(async sql=>{await rate(sql,owner.id,true);const replay=(await sql.query('SELECT request_sha256,receipt FROM cloud_project_operations WHERE account_id=$1 AND request_key=$2',[owner.id,requestKey])).rows[0];if(replay){if(replay.request_sha256!==digest)throw new ServiceFailure(409,'idempotency-conflict','This key was used for another project operation.','project');return replay.receipt as CloudProject}const saved=await project(sql,id,owner.id);if(saved.deleted_at||String(saved.revision)!==parsed.data.baseRevision)throw conflict(saved);const pending=(await sql.query("SELECT * FROM cloud_project_uploads WHERE project_id=$1 AND state='reserved'",[id])).rows;for(const row of pending)await abort(sql,row,'aborted');if(saved.current_upload_id)await enqueue(sql,String(saved.current_upload_id));const counter=(await sql.query('UPDATE cloud_storage_accounts SET used_bytes=used_bytes-$2,change_version=change_version+1 WHERE account_id=$1 RETURNING change_version',[owner.id,saved.bytes])).rows[0]!;const deleted=(await sql.query("UPDATE cloud_projects SET name='',bytes=0,manifest=NULL,current_upload_id=NULL,deleted_at=$3,updated_at=$3,revision=revision+1,change_version=$4 WHERE id=$1 AND account_id=$2 RETURNING *",[id,owner.id,now(),counter.change_version])).rows[0]!;const receipt=summary(deleted);await sql.query('INSERT INTO cloud_project_operations(account_id,request_key,request_sha256,receipt,created_at) VALUES($1,$2,$3,$4,$5)',[owner.id,requestKey,digest,JSON.stringify(receipt),now()]);return receipt})}
  async function recover(){await atomic(expire);let removed=0,failed=0;const rows=(await db.query('SELECT * FROM cloud_project_cleanup WHERE not_before<=$1 ORDER BY not_before LIMIT 100',[now()])).rows;for(const row of rows)try{await objects.remove(String(row.object_name),row.generation?String(row.generation):undefined);await atomic(async sql=>{const fresh=(await sql.query('SELECT * FROM cloud_project_cleanup WHERE object_name=$1 FOR UPDATE',[row.object_name])).rows[0];if(!fresh||fresh.generation!==row.generation||(fresh.not_before as Date)>now())return;const chunk=(await sql.query('SELECT bytes,pending_charged FROM cloud_project_chunks WHERE object_name=$1 FOR UPDATE',[row.object_name])).rows[0];if(chunk?.pending_charged)await sql.query('UPDATE cloud_storage_accounts SET pending_bytes=pending_bytes-$2 WHERE account_id=$1',[row.account_id,chunk.bytes]);await sql.query('UPDATE cloud_project_chunks SET pending_charged=false,removed=true WHERE object_name=$1',[row.object_name]);await sql.query('DELETE FROM cloud_project_cleanup WHERE object_name=$1',[row.object_name]);removed++})}catch{failed++;await db.query('UPDATE cloud_project_cleanup SET attempts=attempts+1 WHERE object_name=$1',[row.object_name])}await atomic(async sql=>{await sql.query("DELETE FROM cloud_project_chunks c WHERE c.removed AND c.lease_owner IS NULL AND NOT EXISTS(SELECT 1 FROM cloud_project_cleanup q WHERE q.object_name=c.object_name)");await sql.query("UPDATE cloud_project_uploads u SET manifest='{}'::jsonb WHERE u.state<>'reserved' AND NOT EXISTS(SELECT 1 FROM cloud_project_chunks c WHERE c.upload_id=u.id) AND NOT EXISTS(SELECT 1 FROM cloud_projects p WHERE p.current_upload_id=u.id)")});return {removed,failed}}
  async function purge(accountId:string){await atomic(async sql=>{const rows=(await sql.query('SELECT * FROM cloud_project_uploads WHERE account_id=$1',[accountId])).rows;for(const row of rows){if(row.state==='reserved')await abort(sql,row,'aborted');else await enqueue(sql,String(row.id));}});await recover();return atomic(async sql=>{if((await sql.query('SELECT 1 FROM cloud_project_cleanup WHERE account_id=$1 LIMIT 1',[accountId])).rows.length)return false;if((await sql.query('SELECT 1 FROM cloud_project_chunks WHERE account_id=$1 AND lease_owner IS NOT NULL LIMIT 1',[accountId])).rows.length)return false;await sql.query('UPDATE cloud_projects SET current_upload_id=NULL WHERE account_id=$1',[accountId]);for(const table of ['cloud_project_chunks','cloud_project_uploads','cloud_project_operations','cloud_projects','cloud_storage_accounts','cloud_project_rates'])await sql.query(`DELETE FROM ${table} WHERE account_id=$1`,[accountId]);return true})}
  async function metadata(accountId:string){return (await db.query('SELECT id,name,revision,bytes,updated_at,deleted_at FROM cloud_projects WHERE account_id=$1 ORDER BY updated_at LIMIT 100001',[accountId])).rows}
  return {status,list,read,reserve,put,commit,chunk,remove,recover,purge,metadata};
}
export type CloudProjects=ReturnType<typeof cloudProjects>;
