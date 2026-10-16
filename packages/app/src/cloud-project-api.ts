import {PROJECT_CHUNK_BYTES,PROJECT_MAX_CHUNKS,type CloudProject,type CloudProjectList,type CloudProjectManifest,type CloudProjectRead,type CloudProjectUpload,type CloudProjectUploadRequest,type CloudStorageStatus} from '@femlab/registry';

export interface CloudActor {uid:string;epoch:number;signal?:AbortSignal}
export interface CloudProjectEnvironment {
  origin:string;
  fetch:typeof fetch;
  identity():{uid:string|null;epoch:number};
  token(uid:string):Promise<string>;
  sha256(bytes:Uint8Array):Promise<string>;
  maxArtifactBytes:number;
}
export class CloudProjectError extends Error {
  constructor(readonly status:number,readonly code:string,cause:string,readonly project?:CloudProject){super(cause);}
}
const invalid=()=>new CloudProjectError(502,'project.invalid-response','The project service returned invalid data. Your browser copy is unchanged.');
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const decimal=(value:unknown):value is string=>typeof value==='string'&&/^(?:0|[1-9][0-9]*)$/.test(value);
const count=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const timestamp=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value));
export function readCloudProject(value:unknown):CloudProject {
  if(!object(value)||!uuid(value.id)||typeof value.name!=='string'||!decimal(value.revision)||!decimal(value.changeVersion)||!count(value.bytes)||!timestamp(value.updatedAt)||value.deletedAt!==null&&!timestamp(value.deletedAt))throw invalid();
  return {id:value.id,name:value.name,revision:value.revision,changeVersion:value.changeVersion,bytes:value.bytes,updatedAt:value.updatedAt,deletedAt:value.deletedAt};
}
function storage(value:unknown):CloudStorageStatus {
  if(!object(value)||typeof value.available!=='boolean'||!['free','plus','pro','studio'].includes(String(value.plan))||!count(value.limitBytes)||!count(value.usedBytes)||!count(value.reservedBytes)||!count(value.pendingBytes)||typeof value.overQuota!=='boolean'||!count(value.maxChunkBytes)||value.maxChunkBytes<1||value.maxChunkBytes>PROJECT_CHUNK_BYTES)throw invalid();
  return value as unknown as CloudStorageStatus;
}
function manifest(value:unknown,maxBytes:number):CloudProjectManifest {
  if(!object(value)||value.format!=='femlab-project/1'||!count(value.bytes)||value.bytes<1||value.bytes>maxBytes||!Array.isArray(value.chunks)||!value.chunks.length||value.chunks.length>PROJECT_MAX_CHUNKS||value.chunks.length!==Math.ceil(value.bytes/PROJECT_CHUNK_BYTES))throw invalid();
  let total=0;const chunks=value.chunks.map((chunk:unknown)=>{if(!object(chunk)||!count(chunk.bytes)||chunk.bytes<1||chunk.bytes>PROJECT_CHUNK_BYTES||typeof chunk.sha256!=='string'||!/^[a-f0-9]{64}$/.test(chunk.sha256))throw invalid();total+=chunk.bytes;return {bytes:chunk.bytes,sha256:chunk.sha256};});
  if(total!==value.bytes||chunks.slice(0,-1).some(chunk=>chunk.bytes!==PROJECT_CHUNK_BYTES))throw invalid();return {format:'femlab-project/1',bytes:value.bytes,chunks};
}

/** All network authority is captured by UID and full authentication epoch, including A→B→A. */
export class CloudProjectApi {
  constructor(private readonly env:CloudProjectEnvironment){}
  capture():CloudActor {const value=this.env.identity();if(!value.uid)throw new CloudProjectError(401,'account.required','Sign in to sync this project.');return {uid:value.uid,epoch:value.epoch};}
  assert(actor:CloudActor):void {const value=this.env.identity();if(actor.signal?.aborted||value.uid!==actor.uid||value.epoch!==actor.epoch)throw new CloudProjectError(409,'account.changed','The account changed. Your browser copy remains with its original owner.');}
  private async request(actor:CloudActor,path:string,options:RequestInit={},binaryLimit=0):Promise<unknown> {
    this.assert(actor);const token=await this.env.token(actor.uid);this.assert(actor);
    let response:Response;
    try{response=await this.env.fetch(this.env.origin+path,{...options,signal:actor.signal,headers:{...options.headers,Authorization:`Bearer ${token}`}});}catch(error){this.assert(actor);throw new CloudProjectError(0,'project.offline',error instanceof Error?error.message:'The network is unavailable.');}
    this.assert(actor);
    if(binaryLimit&&response.ok){
      if(!response.body)throw invalid();const reader=response.body.getReader(),chunks:Uint8Array[]=[];let length=0;
      try{for(;;){const part=await reader.read();this.assert(actor);if(part.done)break;length+=part.value.length;if(length>binaryLimit)throw invalid();chunks.push(part.value);}}catch(error){await reader.cancel().catch(()=>undefined);throw error;}finally{reader.releaseLock();}
      const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return bytes;
    }
    if(response.ok&&(response.status===204||response.status===205))return null;
    let value:unknown;try{value=await response.json();}catch{throw invalid();}this.assert(actor);
    if(!response.ok){let project:CloudProject|undefined;if(object(value)&&object(value.details)&&value.details.project)project=readCloudProject(value.details.project);throw new CloudProjectError(response.status,object(value)&&typeof value.code==='string'?value.code:'project.failed',object(value)&&typeof value.cause==='string'?value.cause:'Project sync failed. Your browser copy is unchanged.',project);}
    return value;
  }
  async list(actor:CloudActor,after?:string):Promise<CloudProjectList> {
    if(after!==undefined&&!decimal(after))throw invalid();const value=await this.request(actor,'/v1/projects'+(after===undefined?'':`?after=${after}`));
    if(!object(value)||!Array.isArray(value.projects)||value.nextCursor!==null&&!decimal(value.nextCursor))throw invalid();
    return {projects:value.projects.map(readCloudProject),nextCursor:value.nextCursor,storage:storage(value.storage)};
  }
  async describe(actor:CloudActor,id:string):Promise<CloudProjectRead> {
    if(!uuid(id))throw invalid();const value=await this.request(actor,`/v1/projects/${id}`);
    if(!object(value))throw invalid();const project=readCloudProject(value.project),data=manifest(value.manifest,this.env.maxArtifactBytes);
    if(project.id!==id||project.deletedAt!==null||project.bytes!==data.bytes)throw invalid();return {project,manifest:data};
  }
  async download(actor:CloudActor,id:string,progress:(done:number,total:number)=>void=()=>{}):Promise<{project:CloudProject;bytes:Uint8Array}> {
    const read=await this.describe(actor,id),bytes=new Uint8Array(read.manifest.bytes);let offset=0;
    for(const [index,chunk] of read.manifest.chunks.entries()){
      const value=await this.request(actor,`/v1/projects/${id}/chunks/${index}?revision=${read.project.revision}`,{},chunk.bytes);
      if(!(value instanceof Uint8Array)||value.length!==chunk.bytes||await this.env.sha256(value)!==chunk.sha256)throw new CloudProjectError(502,'project.corrupt','Downloaded project bytes did not match their manifest. Your browser copy is unchanged.');
      this.assert(actor);bytes.set(value,offset);offset+=value.length;progress(offset,bytes.length);
    }
    this.assert(actor);return {project:read.project,bytes};
  }
  async upload(actor:CloudActor,input:{id?:string;name:string;baseRevision:string|null;key:string;bytes:Uint8Array},progress:(done:number,total:number)=>void=()=>{}):Promise<CloudProject> {
    this.assert(actor);if(!input.bytes.length||input.bytes.length>this.env.maxArtifactBytes||!input.key||input.id!==undefined&&!uuid(input.id)||input.baseRevision!==null&&!decimal(input.baseRevision)||Boolean(input.id)!==(input.baseRevision!==null))throw new CloudProjectError(413,'project.limit','The project cannot fit the supported cloud artifact limit. Export a local backup.');
    // The queue passes one immutable durable snapshot and the same key/body on retry.
    const bytes=input.bytes.slice(),chunks:CloudProjectManifest['chunks']=[];
    for(let offset=0;offset<bytes.length;offset+=PROJECT_CHUNK_BYTES){const part=bytes.subarray(offset,offset+PROJECT_CHUNK_BYTES);chunks.push({bytes:part.length,sha256:await this.env.sha256(part)});this.assert(actor);}
    const body:CloudProjectUploadRequest={...(input.id===undefined?{}:{projectId:input.id}),name:input.name,baseRevision:input.baseRevision,manifest:{format:'femlab-project/1',bytes:bytes.length,chunks}};
    const headers={'Content-Type':'application/json','Idempotency-Key':input.key};
    const value=await this.request(actor,'/v1/projects/uploads',{method:'POST',headers,body:JSON.stringify(body)});
    if(!object(value)||!uuid(value.uploadId)||!uuid(value.projectId)||!timestamp(value.expiresAt)||!Array.isArray(value.missingChunks)||value.missingChunks.some((index:unknown)=>!count(index)||index>=chunks.length)||new Set(value.missingChunks).size!==value.missingChunks.length||input.id!==undefined&&input.id!==value.projectId)throw invalid();
    const upload=value as unknown as CloudProjectUpload;let done=bytes.length-upload.missingChunks.reduce((sum,index)=>sum+chunks[index]!.bytes,0);progress(done,bytes.length);
    for(const index of upload.missingChunks){const offset=index*PROJECT_CHUNK_BYTES;await this.request(actor,`/v1/projects/uploads/${upload.uploadId}/chunks/${index}`,{method:'PUT',headers:{'Content-Type':'application/octet-stream'},body:bytes.slice(offset,offset+chunks[index]!.bytes) as RequestInit['body']});done+=chunks[index]!.bytes;progress(done,bytes.length);}
    const committed=readCloudProject(await this.request(actor,`/v1/projects/uploads/${upload.uploadId}/commit`,{method:'POST',headers,body:'{}'}));
    if(committed.id!==upload.projectId||committed.deletedAt!==null||committed.bytes!==bytes.length)throw invalid();return committed;
  }
  async delete(actor:CloudActor,id:string,baseRevision:string,key:string):Promise<CloudProject> {
    if(!uuid(id)||!decimal(baseRevision)||!key)throw invalid();const project=readCloudProject(await this.request(actor,`/v1/projects/${id}/delete`,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify({baseRevision})}));
    if(project.id!==id||project.deletedAt===null)throw invalid();return project;
  }
}
