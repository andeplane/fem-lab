import {decodeProjectArtifact} from '../../src/project-artifact';
import {randomUUID,createHash} from 'node:crypto';
import type {CloudProject,CloudProjectUploadRequest,CloudStorageStatus,AccountInfo} from '@femlab/registry';
import type {BrowserContext,Route} from '@playwright/test';
interface Saved {project:CloudProject;manifest:CloudProjectUploadRequest['manifest'];chunks:Buffer[]}
interface Upload {uid:string;id:string;projectId:string;body:CloudProjectUploadRequest;chunks:Map<number,Buffer>;receipt?:CloudProject}
/** In-memory HTTP fixture with real binary chunks, ownership, conditional revisions and exact operation keys. */
export class CloudFixtureServer {
  readonly owners=new Map<string,Map<string,Saved>>();
  readonly uploads=new Map<string,Upload>();
  readonly operations=new Map<string,string>();
  modelName(uid:string,name:string):string|undefined{const row=[...this.rows(uid).values()].find(row=>row.project.name===name);if(!row)return;const artifact=decodeProjectArtifact(Uint8Array.from(Buffer.concat(row.chunks)));return (artifact.engine as {file:{model:{name:string}}}).file.model.name;}
  writes=0;
  failUploads=false;
  quotaExceeded=false;
  dropCommitReply=false;
  private clock=0;
  private rows(uid:string):Map<string,Saved>{let rows=this.owners.get(uid);if(!rows){rows=new Map();this.owners.set(uid,rows);}return rows;}
  private storage(uid:string):CloudStorageStatus{return {available:true,plan:'free',limitBytes:100000000,usedBytes:[...this.rows(uid).values()].reduce((sum,row)=>sum+(row.project.deletedAt?0:row.project.bytes),0),reservedBytes:0,pendingBytes:0,overQuota:false,maxChunkBytes:8000000};}
  private json(body:unknown,status=200):Response{return Response.json(body,{status});}
  private conflict(project:CloudProject):Response{return this.json({code:'project-conflict',cause:'The cloud project changed.',details:{project}},409);}
  async route(route:Route):Promise<void>{const request=route.request(),uid=(await request.allHeaders())['authorization']?.replace(/^Bearer /,'');if(!uid){await route.fulfill({status:401,json:{cause:'Sign in required'}});return;}const response=await this.respond(uid,request.method(),new URL(request.url()).pathname.replace('/__cloud_fixture',''),new URL(request.url()).searchParams,request.postDataBuffer(),(await request.allHeaders())['idempotency-key']);if(this.dropCommitReply&&request.method()==='POST'&&/\/commit$/.test(new URL(request.url()).pathname)&&response.ok){this.dropCommitReply=false;await route.abort('failed');return;}await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer())});}
  async install(context:BrowserContext):Promise<void>{await context.route('**/__cloud_fixture/**',route=>this.route(route));}
  private async respond(uid:string,method:string,path:string,query:URLSearchParams,data:Buffer|null,key?:string):Promise<Response>{
    if(path==='/v1/account'){const profile:AccountInfo={id:uid,email:uid+'@example.invalid',createdAt:new Date(0).toISOString(),status:'active',creditUnit:'usd-milli-v1'};return this.json(profile);}
    const rows=this.rows(uid);
    if(path==='/v1/projects')return this.json({projects:[...rows.values()].map(row=>row.project),nextCursor:null,storage:this.storage(uid)});
    if(method==='POST'&&path==='/v1/projects/uploads'){
      if(this.quotaExceeded)return this.json({code:'storage-quota-exceeded',cause:'The account storage quota is full.'},413);
      if(this.failUploads)return this.json({code:'fixture-offline',cause:'Fixture upload temporarily unavailable'},503);
      const body=JSON.parse(data!.toString()) as CloudProjectUploadRequest;const op=uid+':'+key,previous=this.operations.get(op);if(previous){const upload=this.uploads.get(previous)!;if(JSON.stringify(body)!==JSON.stringify(upload.body))return this.json({cause:'Operation body changed'},409);return this.json({uploadId:upload.id,projectId:upload.projectId,expiresAt:'2099-01-01T00:00:00.000Z',missingChunks:upload.body.manifest.chunks.flatMap((_,i)=>upload.chunks.has(i)?[]:[i])});}
      if(body.projectId){const previous=rows.get(body.projectId);if(!previous)return this.json({cause:'Not found'},404);if(previous.project.revision!==body.baseRevision)return this.conflict(previous.project);}
      const id=randomUUID(),upload:Upload={uid,id,projectId:body.projectId??randomUUID(),body,chunks:new Map()};this.uploads.set(id,upload);this.operations.set(op,id);return this.json({uploadId:id,projectId:upload.projectId,expiresAt:'2099-01-01T00:00:00.000Z',missingChunks:body.manifest.chunks.map((_,i)=>i)});
    }
    const up=path.match(/^\/v1\/projects\/uploads\/([^/]+)\/(?:chunks\/(\d+)|(commit))$/);
    if(up){const upload=this.uploads.get(up[1]!);if(!upload||upload.uid!==uid)return this.json({cause:'Not found'},404);
      if(up[2]!==undefined){const index=Number(up[2]),expected=upload.body.manifest.chunks[index];if(!data||!expected||data.length!==expected.bytes||createHash('sha256').update(data).digest('hex')!==expected.sha256)return this.json({cause:'Invalid chunk'},422);upload.chunks.set(index,Buffer.from(data));return new Response(null,{status:204});}
      if(upload.receipt)return this.json(upload.receipt);const old=rows.get(upload.projectId);if(old&&old.project.revision!==upload.body.baseRevision)return this.conflict(old.project);const chunks=upload.body.manifest.chunks.map((_,i)=>upload.chunks.get(i)!);if(chunks.some(x=>!x))return this.json({cause:'Missing chunks'},409);const project:CloudProject={id:upload.projectId,name:upload.body.name,revision:String(Number(old?.project.revision??0)+1),changeVersion:String(++this.clock),bytes:upload.body.manifest.bytes,updatedAt:new Date().toISOString(),deletedAt:null};rows.set(project.id,{project,manifest:upload.body.manifest,chunks});upload.receipt=project;this.writes++;return this.json(project);
    }
    const resource=path.match(/^\/v1\/projects\/([^/]+)(?:\/(?:chunks\/(\d+)|(delete)))?$/);
    if(resource){const row=rows.get(resource[1]!);if(!row)return this.json({cause:'Not found'},404);if(resource[3]){const body=JSON.parse(data!.toString()) as {baseRevision:string};if(body.baseRevision!==row.project.revision)return this.conflict(row.project);row.project={...row.project,revision:String(Number(row.project.revision)+1),changeVersion:String(++this.clock),deletedAt:new Date().toISOString()};return this.json(row.project);}if(row.project.deletedAt)return this.json({cause:'Deleted'},404);if(resource[2]!==undefined){if(query.get('revision')!==row.project.revision)return this.conflict(row.project);return new Response(Uint8Array.from(row.chunks[Number(resource[2])]!));}return this.json({project:row.project,manifest:row.manifest});}
    return this.json({cause:'Unexpected fixture request '+path},404);
  }
}
