import {FemError,type CloudProject,type CloudStorageStatus,type ProjectMeta} from '@femlab/registry';
import {CloudProjectApi,CloudProjectError,type CloudActor} from './cloud-project-api';
import type {AtomicProjects,PendingProjectUpload,ProjectCloudRecord,ProjectRecord} from './project-repository';

export type ProjectSyncPhase='local'|'pending'|'syncing'|'synced'|'remote'|'offline'|'conflict'|'quota'|'error';
export interface ProjectSyncStatus {phase:ProjectSyncPhase;message:string|null;done?:number;total?:number;name?:string;deleted?:boolean;remoteDeleted?:boolean}
export interface ProjectSyncState {uid:string|null;projects:Record<string,ProjectSyncStatus>;storage:CloudStorageStatus|null;refreshing:boolean;error:string|null}
export const EMPTY_PROJECT_SYNC:ProjectSyncState={uid:null,projects:{},storage:null,refreshing:false,error:null};
export type CloudProjectTransport=Pick<CloudProjectApi,'assert'|'list'|'upload'|'download'|'delete'>;
type SyncOperation={kind:'upload'|'delete';key:string};
const matchesOperation=(row:ProjectRecord,operation:SyncOperation):boolean=>(operation.kind==='upload'?row.cloud?.upload?.key:row.cloud?.deleteKey)===operation.key;
export interface ProjectSyncEnvironment {
  api:CloudProjectTransport;
  storage(owner:string|null):AtomicProjects;
  nextId():string;
  /** A changed remote revision cannot quietly advance the base of an open engine document. */
  isOpen(owner:string,id:string):boolean;
  online():boolean;
}
const required=(row:ProjectRecord|null):ProjectRecord=>{if(!row)throw new FemError('not-found','the saved project is no longer available','project');return row;};
const cloud=(row:ProjectRecord):ProjectCloudRecord=>row.cloud??{remote:null,dirty:Boolean(row.artifact),deleted:row.meta===null};
const meta=(id:string,remote:CloudProject):ProjectMeta=>({id,name:remote.name,at:Date.parse(remote.updatedAt),createdAt:Date.parse(remote.updatedAt),commands:0,hash:null,thumbnail:null});

/** Durable upload snapshots and local account partitions outlive a network connection. */
export class ProjectSync {
  private actor:CloudActor|undefined;
  private lifetime:AbortController|undefined;
  private running:Promise<void>|undefined;
  private rerun=false;
  private state:ProjectSyncState={...EMPTY_PROJECT_SYNC};
  private listeners=new Set<(state:ProjectSyncState)=>void>();
  private publication=0;
  private errors=new Map<string,{status:ProjectSyncStatus;operation?:SyncOperation}>();
  constructor(private readonly env:ProjectSyncEnvironment){}
  get current():ProjectSyncState{return structuredClone(this.state);}
  subscribe(listener:(state:ProjectSyncState)=>void):()=>void{this.listeners.add(listener);listener(this.current);return()=>this.listeners.delete(listener);}
  private emit():void{const value=this.current;for(const listener of this.listeners)listener(value);}
  private owns(actor:CloudActor):boolean{return this.actor===actor&&!actor.signal?.aborted;}
  private assert(actor:CloudActor):void{if(!this.owns(actor))throw new CloudProjectError(409,'account.changed','Project sync belongs to a previous account.');this.env.api.assert(actor);}
  private async publish(actor:CloudActor):Promise<void>{
    const publication=++this.publication,rows=await this.env.storage(actor.uid).scan();if(!this.owns(actor)||publication!==this.publication)return;
    const projects:ProjectSyncState['projects']={};
    for(const row of rows){
      const value=cloud(row),entry=this.errors.get(row.id);
      const transient=entry&&(value.dirty||value.upload||value.deleteKey||value.conflict)&&(!entry.operation||matchesOperation(row,entry.operation))?entry.status:undefined;
      if(!row.meta&&!value.conflict&&!transient)continue;
      const status:ProjectSyncStatus=value.conflict
        ?{phase:'conflict',message:transient?.phase==='conflict'?transient.message:'The cloud project changed. Both versions are preserved.'}
        :transient??{phase:value.dirty||value.upload?'pending':value.remote?row.artifact?'synced':'remote':'local',message:null};
      projects[row.id]={...status,name:row.meta?.name??value.remote?.name??value.conflict?.name??'Deleted project',deleted:row.meta===null,...(value.conflict?.deletedAt?{remoteDeleted:true}:{})};
    }
    this.state={...this.state,projects};this.emit();
  }
  activate(value:CloudActor|null):void {
    if(value&&this.actor?.uid===value.uid&&this.actor.epoch===value.epoch)return;
    this.lifetime?.abort();this.lifetime=value?new AbortController():undefined;
    this.actor=value?{...value,signal:this.lifetime!.signal}:undefined;this.errors.clear();this.state={...EMPTY_PROJECT_SYNC,uid:value?.uid??null,projects:{}};this.emit();
    if(this.actor)void this.refresh().catch(()=>undefined);
  }
  /** Local save succeeded first. Network failures never turn it into a lost local save. */
  async changed(owner:string|null,id:string):Promise<void>{
    if(owner===null)return;const storage=this.env.storage(owner);
    await storage.update(id,previous=>{const row=required(previous);return {...row,cloud:{...cloud(row),dirty:true,deleted:row.meta===null}};});
    const actor=this.actor;if(!actor||actor.uid!==owner)return;this.errors.delete(id);await this.publish(actor);void this.flush().catch(()=>undefined);
  }
  async refresh():Promise<void>{
    const actor=this.actor;if(!actor)return;this.state={...this.state,refreshing:true,error:null};this.emit();
    try{
      if(!this.env.online())throw new CloudProjectError(0,'project.offline','Offline. Browser changes will sync when a connection returns.');
      let after:string|undefined;const seen=new Set<string>();
      do{const page=await this.env.api.list(actor,after);this.assert(actor);this.state={...this.state,storage:page.storage};
        for(const project of page.projects)await this.merge(actor,project);
        if(page.nextCursor!==null){if(seen.has(page.nextCursor))throw new CloudProjectError(502,'project.invalid-response','The project service repeated a page cursor.');seen.add(page.nextCursor);after=page.nextCursor;}else after=undefined;
      }while(after!==undefined);
      this.assert(actor);await this.publish(actor);await this.flush();
    }catch(error){if(this.owns(actor)){this.state={...this.state,error:error instanceof Error?error.message:'Cloud projects are unavailable.'};await this.publish(actor);}throw error;}
    finally{if(this.owns(actor)){this.state={...this.state,refreshing:false};this.emit();}}
  }
  private async merge(actor:CloudActor,remote:CloudProject):Promise<void>{
    this.assert(actor);const storage=this.env.storage(actor.uid),rows=await storage.scan();this.assert(actor);const existing=rows.find(row=>row.cloud?.remote?.id===remote.id||row.cloud?.upload?.projectId===remote.id),id=existing?.id??`cloud-${remote.id}`,generation=this.env.nextId();
    await storage.update(id,previous=>{
      this.assert(actor);
      if(!previous){return {id,generation:null,version:'0',meta:remote.deletedAt?null:meta(id,remote),cmds:[],cloud:{remote,dirty:false,deleted:remote.deletedAt!==null}};}
      const value=cloud(previous);if(value.remote&&BigInt(value.remote.revision)>=BigInt(remote.revision))return previous;
      // In-progress first uploads are reconciled only by replaying their exact saved request.
      if(value.upload&&!value.remote)return previous;
      if(value.dirty||value.upload||this.env.isOpen(actor.uid,id))return {...previous,cloud:{...value,conflict:remote}};
      return {...previous,generation,meta:remote.deletedAt?null:{...(previous.meta??meta(id,remote)),name:remote.name,at:Date.parse(remote.updatedAt)},artifact:undefined,artifactTag:undefined,cloud:{remote,dirty:false,deleted:remote.deletedAt!==null}};
    });
  }
  async flush():Promise<void>{
    if(this.running){this.rerun=true;return this.running;}const actor=this.actor;if(!actor)return;
    const operation=this.run(actor);this.running=operation;try{await operation;}finally{if(this.running===operation)this.running=undefined;if(this.rerun){this.rerun=false;if(this.actor)void this.flush().catch(()=>undefined);}}
  }
  private async run(actor:CloudActor):Promise<void>{
    const storage=this.env.storage(actor.uid);let synchronized=false;
    for(const row of await storage.scan()){
      this.assert(actor);const value=cloud(row);if(!row.cloud||value.upload?.blocked||value.conflict&&!value.upload||!value.dirty&&!value.upload)continue;
      if(!this.env.online()){this.errors.set(row.id,{status:{phase:'offline',message:'Saved in this browser. Cloud sync resumes when a connection returns.'}});await this.publish(actor);continue;}
      const attempt:{operation?:SyncOperation}={};
      try{await this.sync(actor,row.id,attempt);synchronized=true;this.errors.delete(row.id);}catch(error){
        if(!this.owns(actor))return;
        // An explicit local deletion may cancel a terminal, never-committed operation.
        // Never rotate its key or assume a dropped commit response means it did not commit.
        if(error instanceof CloudProjectError&&error.status===410&&error.code==='upload-expired'){
          const latest=await storage.read(row.id);
          if(latest?.meta===null&&latest.cloud?.upload){await storage.update(row.id,previous=>{this.assert(actor);const current=required(previous),value=cloud(current);if(attempt.operation&&!matchesOperation(current,attempt.operation))return current;return {...current,artifact:undefined,artifactTag:undefined,cloud:{...value,upload:undefined,dirty:Boolean(value.remote),deleted:true}};});this.errors.delete(row.id);if(latest.cloud.remote)this.rerun=true;await this.publish(actor);continue;}
        }
        const cause=error instanceof Error?error.message:'Cloud sync failed. Your browser copy is safe.';
        if(error instanceof CloudProjectError&&error.code==='account.changed')return;
        if(error instanceof CloudProjectError&&error.project){const remote=error.project;await storage.update(row.id,previous=>{this.assert(actor);const current=required(previous),fresh=cloud(current);if(attempt.operation&&!matchesOperation(current,attempt.operation))return current;const conflict=fresh.conflict?.id===remote.id&&BigInt(fresh.conflict.revision)>=BigInt(remote.revision)?fresh.conflict:remote;return {...current,cloud:{...fresh,conflict}};});}
        if(!this.owns(actor))return;
        const phase:ProjectSyncPhase=error instanceof CloudProjectError?(error.project?'conflict':error.status===0?'offline':error.status===413||error.status===507||/quota|storage-full/.test(error.code)?'quota':'error'):'error';
        this.errors.set(row.id,{status:{phase,message:cause},operation:attempt.operation});
      }
      if(this.owns(actor))await this.publish(actor);
    }
    if(synchronized&&this.owns(actor)){try{const latest=await this.env.api.list(actor);this.assert(actor);this.state={...this.state,storage:latest.storage};this.emit();}catch(error){if(this.owns(actor)){this.state={...this.state,error:'Projects saved; storage usage could not refresh. Retry sync to update it.'};this.emit();}}}
  }
  /** A lost first commit receipt can make list create an unbound remote placeholder.
   * Only the original operation receipt proves its association; never guess from filenames. */
  private async reconcileReceipt(actor:CloudActor,id:string,remote:CloudProject):Promise<void>{
    const storage=this.env.storage(actor.uid);let editedDuplicate=false,latestConflict:CloudProject|undefined;
    const pristine=(row:ProjectRecord)=>row.generation===null&&!row.artifact&&!row.journal&&!row.cmds.length&&!cloud(row).dirty&&!cloud(row).upload&&!cloud(row).conflict&&!this.env.isOpen(actor.uid,row.id);
    for(const row of await storage.scan()){
      this.assert(actor);if(row.id===id||row.cloud?.remote?.id!==remote.id)continue;
      const generation=this.env.nextId();
      await storage.update(row.id,current=>{
        this.assert(actor);if(!current||current.cloud?.remote?.id!==remote.id)return required(current);
        for(const candidate of [current.cloud.remote,current.cloud.conflict])if(candidate&&BigInt(candidate.revision)>BigInt(latestConflict?.revision??remote.revision))latestConflict=candidate;
        if(pristine(current))return {...current,generation,meta:null,cloud:undefined};
        editedDuplicate=true;return {...current,cloud:{...cloud(current),conflict:latestConflict??remote}};
      });
    }
    if(editedDuplicate||latestConflict)await storage.update(id,previous=>{const current=required(previous);return {...current,cloud:{...cloud(current),conflict:latestConflict??remote}};});
  }
  private async sync(actor:CloudActor,id:string,attempt:{operation?:SyncOperation}):Promise<void>{
    const storage=this.env.storage(actor.uid);let row=required(await storage.read(id));this.assert(actor);let value=cloud(row);
    // A listing may be our pending commit; only replay of its original key proves it.
    if(value.upload?.blocked||value.conflict&&!value.upload)return;
    if(!value.upload&&value.deleted&&!value.remote){await storage.update(id,previous=>{const current=required(previous);return {...current,artifact:undefined,artifactTag:undefined,cloud:{...cloud(current),dirty:false}};});return;}
    if(!value.upload&&!value.deleted){
      if(row.artifactError)throw new Error(row.artifactError+' Browser Journal saved; cloud upload is paused.');
      if(!row.meta||!row.artifact||!row.artifactTag)throw new Error('The complete project snapshot is not available yet. Save the project again; local Journal recovery remains available.');
      const pending:PendingProjectUpload={key:this.env.nextId(),tag:row.artifactTag,name:row.meta.name,baseRevision:value.remote?.revision??null,...(value.remote?{projectId:value.remote.id}:{}),bytes:row.artifact.slice()};
      row=await storage.update(id,previous=>{const current=required(previous),fresh=cloud(current);if(fresh.upload||fresh.conflict)return current;if(!current.meta||current.artifactTag!==pending.tag||current.meta.name!==pending.name)throw new FemError('session.conflict','a newer project save is waiting to sync','project');return {...current,cloud:{...cloud(current),upload:pending}};});value=cloud(row);
    }
    // Another controller can reserve an operation or observe a conflict during our read.
    if(value.upload?.blocked||value.conflict&&!value.upload)return;
    if(value.upload){const pending=value.upload,operation:SyncOperation={kind:'upload',key:pending.key};attempt.operation=operation;
      this.errors.set(id,{status:{phase:'syncing',message:'Uploading complete project…',done:0,total:pending.bytes.length},operation});await this.publish(actor);
      let remote:CloudProject;
      try{
      remote=await this.env.api.upload(actor,{id:pending.projectId,name:pending.name,baseRevision:pending.baseRevision,key:pending.key,bytes:pending.bytes},(done,total)=>{if(this.owns(actor)){this.errors.set(id,{status:{phase:'syncing',message:'Uploading complete project…',done,total},operation});void this.publish(actor);}});this.assert(actor);
      }catch(error){
        if(this.owns(actor)&&error instanceof CloudProjectError&&error.project){
          await storage.update(id,previous=>{this.assert(actor);const current=required(previous),fresh=cloud(current),operation=fresh.upload;if(!operation||operation.key!==pending.key)return current;return {...current,cloud:{...fresh,upload:{...operation,blocked:true}}};});
        }
        throw error;
      }
      row=await storage.update(id,previous=>{
        const current=required(previous),fresh=cloud(current);if(fresh.upload?.key!==pending.key)return current;
        // A reconnect listing may observe this commit before its receipt arrives.
        // Only that exact committed revision is ours; a later remote edit stays a conflict.
        const conflict=fresh.conflict?.id===remote.id&&fresh.conflict.revision===remote.revision?undefined:fresh.conflict;
        return {...current,cloud:{...fresh,remote,conflict,upload:undefined,dirty:fresh.deleted||Boolean(current.artifactError)||current.artifactTag!==pending.tag||current.meta?.name!==pending.name}};
      });value=cloud(row);
      await this.reconcileReceipt(actor,id,remote);
      row=required(await storage.read(id));this.assert(actor);value=cloud(row);if(value.conflict)return;
      // Durable newer bytes may have been saved by a previous account epoch.
      if(value.dirty)this.rerun=true;
    }
    if(value.deleted&&value.remote){
      const proposed=value.deleteKey??this.env.nextId();
      row=await storage.update(id,previous=>{this.assert(actor);const current=required(previous),fresh=cloud(current);if(!fresh.deleted||!fresh.remote||fresh.upload||fresh.conflict)return current;return {...current,cloud:{...fresh,deleteKey:fresh.deleteKey??proposed}};});
      value=cloud(row);if(!value.deleted||!value.remote||value.upload||value.conflict||!value.deleteKey)return;const key=value.deleteKey;
      attempt.operation={kind:'delete',key};
      const remote=await this.env.api.delete(actor,value.remote.id,value.remote.revision,key);this.assert(actor);
      await storage.update(id,previous=>{
        this.assert(actor);const current=required(previous),fresh=cloud(current);
        if(fresh.remote?.id!==remote.id||BigInt(fresh.remote.revision)>BigInt(remote.revision)||fresh.conflict?.id===remote.id&&BigInt(fresh.conflict.revision)>BigInt(remote.revision))return current;
        // A completed server deletion cannot erase an explicitly restored browser snapshot.
        if(!fresh.deleted||current.meta!==null)return {...current,cloud:{...fresh,conflict:remote}};
        return {...current,artifact:undefined,artifactTag:undefined,cloud:{remote,dirty:false,deleted:true}};
      });
    }
  }
  /** Returns bytes privately; engine validation/publication must succeed before cache replacement. */
  async prepareOpen(id:string,restore=false):Promise<{record:ProjectRecord;bytes:Uint8Array;remote:CloudProject|null}>{
    const actor=this.actor;if(!actor)throw new CloudProjectError(401,'account.required','Sign in to open this cloud project.');const row=required(await this.env.storage(actor.uid).read(id));this.assert(actor);const value=cloud(row);
    if(row.artifactError&&!restore)throw new Error(row.artifactError+' Recover the saved browser Journal or explicitly choose the cloud version.');
    if(row.artifact&&!restore)return {record:row,bytes:row.artifact.slice(),remote:value.remote};
    const remote=restore?value.conflict??value.remote:value.remote;if(!remote||remote.deletedAt)throw new Error('The cloud version is unavailable. Export or keep a separate browser copy.');
    const downloaded=await this.env.api.download(actor,remote.id);this.assert(actor);return {record:row,bytes:downloaded.bytes,remote:downloaded.project};
  }
  /** Explicitly duplicates owned work before resolving its original against the remote revision. */
  async keepCopy(id:string):Promise<ProjectRecord>{
    const actor=this.actor;if(!actor)throw new CloudProjectError(401,'account.required','Sign in to keep a cloud copy.');const storage=this.env.storage(actor.uid),original=required(await storage.read(id));this.assert(actor);
    if(original.artifactError)throw new Error(original.artifactError+' Export the current Model or Journal before making a separate project.');
    if(!original.meta||!original.artifact)throw new Error('Save the browser project before keeping a separate copy.');const copyId=this.env.nextId();
    const copy=await storage.update(copyId,previous=>{if(previous)throw new Error('The new project identifier already exists.');this.assert(actor);return {...original,id:copyId,generation:null,meta:{...original.meta!,id:copyId,name:original.meta!.name+' (copy)'},cloud:{remote:null,dirty:true,deleted:false}};});
    const generation=this.env.nextId();
    if(original.cloud?.conflict)await storage.update(id,previous=>{const current=required(previous);if(current.artifactTag!==original.artifactTag||current.generation!==original.generation)throw new FemError('session.conflict','the browser project changed while creating its copy','project');const remote=original.cloud!.conflict!;return {...current,generation,meta:remote.deletedAt?null:{...current.meta!,name:remote.name,at:Date.parse(remote.updatedAt)},artifact:undefined,artifactTag:undefined,cloud:{remote,dirty:false,deleted:remote.deletedAt!==null}};});
    await this.publish(actor);return copy;
  }
}
