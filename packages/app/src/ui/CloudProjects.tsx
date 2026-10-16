import type {UiState} from '../store';
import type {ProjectSyncStatus} from '../project-sync';
import {Cmd,type Dispatch} from './cmd';
import './cloud-projects.css';

type CloudProjectState=Pick<UiState,'account'|'ready'|'projects'>&Partial<Pick<UiState,'projectSync'|'anonymousProjects'|'projectArtifactError'|'projectFiles'>>;
const PHASE:Record<ProjectSyncStatus['phase'],string>={local:'In this browser',pending:'Waiting to sync',syncing:'Syncing',synced:'Synced',remote:'In the cloud',offline:'Saved offline',conflict:'Choose a version',quota:'Storage limit reached',error:'Sync needs attention'};
const ownsSync=(s:CloudProjectState)=>s.account.uid!==null&&s.projectSync?.uid===s.account.uid;
export function formatStorageBytes(bytes:number):string {
  if(!Number.isFinite(bytes)||bytes<0)return 'Unavailable';
  const units=['B','kB','MB','GB','TB'];let unit=0;
  while(bytes>=1000&&unit<units.length-1){bytes/=1000;unit++;}
  return `${new Intl.NumberFormat('en-US',{maximumFractionDigits:unit===0?0:1}).format(bytes)} ${units[unit]}`;
}
export function CloudStorage({s,dispatch}:{s:CloudProjectState;dispatch:Dispatch}) {
  if(!s.account.uid)return null;
  const sync=ownsSync(s)?s.projectSync:undefined,storage=sync?.storage;
  return <section class="cloud-storage" aria-label="Cloud project storage">
    <div class="cloud-section-heading"><div><span class="eyebrow">ACCOUNT STORAGE</span><h3>Cloud project backups</h3></div>
      <Cmd dispatch={dispatch} cmd="account.syncProjects" class="tbutton outline" disabled={s.account.status!=='active'||Boolean(sync?.refreshing)}>{sync?.refreshing?'Refreshing projects…':'Sync projects'}</Cmd></div>
    {storage?<>{s.account.status!=='active'?<p class="cloud-muted" role="status">Last known storage. Refresh your account to read current usage.</p>:null}<div class="cloud-storage-total"><strong>{formatStorageBytes(storage.usedBytes)}</strong><span>used of {formatStorageBytes(storage.limitBytes)}</span><span class="cloud-plan">{storage.plan}</span></div>
      <meter min={0} max={100} value={storage.limitBytes>0?Math.min(100,(storage.usedBytes+storage.reservedBytes)/storage.limitBytes*100):0} aria-label="Account project storage" aria-valuetext={`${formatStorageBytes(storage.usedBytes)} used; ${formatStorageBytes(storage.reservedBytes)} uploading; ${formatStorageBytes(storage.limitBytes)} included storage`}/>
      <dl class="cloud-storage-breakdown"><div><dt>Used</dt><dd>{formatStorageBytes(storage.usedBytes)}</dd></div><div><dt>Uploading</dt><dd>{formatStorageBytes(storage.reservedBytes)}</dd></div><div><dt>Included storage</dt><dd>{formatStorageBytes(storage.limitBytes)}</dd></div></dl>
      {storage.overQuota?<p class="cloud-warning" role="status">Your account is over its storage quota. Existing projects remain available. Download a backup, remove unneeded cloud projects or change your plan before uploading more.</p>:null}
      {!storage.available?<p class="cloud-warning" role="status">Cloud storage is unavailable. Your browser copies remain available; try syncing again later.</p>:null}
    </>:<p class="cloud-muted" role="status">{sync?.refreshing?'Loading your cloud project storage…':'Sync projects to read your current storage allowance.'}</p>}
    {sync?.error?<p class="cloud-warning" role="status">{sync.error}</p>:null}
    <p class="cloud-storage-note">Uploads in progress reserve storage. After replacing or deleting a project, space for new uploads may take time to become available.</p>
  </section>;
}
export function ProjectSyncDetails({s,id,dispatch}:{s:CloudProjectState;id:string;dispatch:Dispatch}) {
  const status=ownsSync(s)?s.projectSync?.projects[id]:undefined;
  const phase=status?.phase??'local',busy=phase==='syncing';
  const canSync=s.account.status==='active'&&s.account.uid!==null;
  const progress=typeof status?.done==='number'&&typeof status.total==='number'&&status.total>0?Math.min(100,Math.max(0,status.done/status.total*100)):null;
  return <div class="project-sync-details" data-sync-phase={phase}>
    <div class="project-sync-line"><span class={`project-sync-badge phase-${phase}`} role="status"><i aria-hidden="true"/>{PHASE[phase]}</span>{status?.deleted?<span class="project-sync-deleted">Deleted in this browser</span>:null}</div>
    {busy?<div class="project-sync-progress" role="progressbar" aria-label="Project upload progress" aria-valuemin={0} aria-valuemax={100} {...(progress===null?{}:{'aria-valuenow':Math.round(progress)})}><span style={{width:`${progress??25}%`}}/></div>:null}
    {status?.remoteDeleted?<p class="project-sync-message">The cloud version was deleted. Keep a browser copy before accepting deletion.</p>:status?.message?<p class="project-sync-message">{status.message}</p>:null}
    <div class="project-sync-actions">
      {!status?.deleted?<Cmd dispatch={dispatch} cmd="project.downloadBundle" args={{id}} class="tbutton" disabled={!s.ready}>Download project bundle</Cmd>:null}
      {phase==='conflict'||status?.deleted&&phase==='error'?<><Cmd dispatch={dispatch} cmd="account.restoreProject" args={{id}} class="tbutton outline" disabled={!canSync||busy}>{status?.remoteDeleted?'Accept cloud deletion':status?.deleted?'Restore cloud version':'Use cloud version'}</Cmd>
        {!status?.deleted&&phase==='conflict'?<Cmd dispatch={dispatch} cmd="account.keepProjectCopy" args={{id}} class="tbutton outline" disabled={!canSync||busy}>Keep both versions</Cmd>:null}</>:null}
      {phase==='error'&&!status?.deleted?<Cmd dispatch={dispatch} cmd="account.keepProjectCopy" args={{id}} class="tbutton outline" disabled={!canSync}>Keep browser copy</Cmd>:null}
      {['offline','pending','quota','error'].includes(phase)?<Cmd dispatch={dispatch} cmd="account.syncProjects" class="tbutton" disabled={!canSync}>Retry sync</Cmd>:null}
    </div>
  </div>;
}
export function CloudProjects({s,dispatch}:{s:CloudProjectState;dispatch:Dispatch}) {
  const signedIn=s.account.uid!==null,canSync=signedIn&&s.account.status==='active';
  const sync=ownsSync(s)?s.projectSync:undefined;
  const deleted=Object.entries(sync?.projects??{}).filter(([,status])=>status.deleted&&status.phase!=='synced');
  return <div class="cloud-projects">
    {signedIn?<CloudStorage s={s} dispatch={dispatch}/>:<section class="cloud-local-note"><h3>Keep your work with you</h3><p>Projects are saved in this browser. Sign in to sync account projects across devices. Existing browser projects stay separate until you choose to upload a copy.</p><Cmd dispatch={dispatch} cmd="account.open" class="tbutton outline" disabled={!s.ready||!s.account.configured}>Sign in</Cmd></section>}
    {s.projectArtifactError?<div class="cloud-warning" role="alert"><p>{s.projectArtifactError} Your browser Journal remains saved; cloud upload is paused. Export the current Model/Journal to keep a backup.</p><Cmd dispatch={dispatch} cmd="file.save" args={{to:'download'}} class="tbutton outline" disabled={!s.ready}>Export current Model/Journal</Cmd></div>:null}
    {deleted.length?<section class="cloud-deleted-projects" aria-label="Deleted projects needing a decision"><h3>Deleted projects need attention</h3><p>Resolve an unfinished cloud deletion or explicitly restore the latest cloud version.</p>{deleted.map(([id,status])=><article key={id} class="cloud-project-row"><h4>{status.name??'Deleted project'}</h4><ProjectSyncDetails s={s} id={id} dispatch={dispatch}/></article>)}</section>:null}
    {signedIn&&s.anonymousProjects?.length?<section class="cloud-anonymous-projects" aria-label="Projects from this browser"><h3>Projects from this browser</h3><p>These projects are separate from your account. Uploading creates an account copy and keeps the browser original.</p>{s.anonymousProjects.map(project=><article key={project.id} class="cloud-project-row"><div><h4>{project.name}</h4><span class="cloud-muted">Browser original · {project.commands} commands</span></div><Cmd dispatch={dispatch} cmd="account.uploadProject" args={{id:project.id}} class="tbutton outline" disabled={!canSync||Boolean(sync?.refreshing)}>Upload a copy</Cmd></article>)}</section>:null}
    {s.projectFiles?.length?<section class="project-original-files" aria-label="Original project files"><h3>Original project files</h3><p>Download the retained input or completed output exactly as it was stored.</p><ul>{s.projectFiles.map(file=><li key={file.id}><div><strong>{file.name}</strong><span>{file.role==='input'?'Input':'Completed output'} · {formatStorageBytes(file.bytes)} · {file.mime}</span></div><Cmd dispatch={dispatch} cmd="project.downloadAsset" args={{id:file.id}} label={`Download ${file.name}`} class="tbutton" disabled={!s.ready}>Download file</Cmd></li>)}</ul></section>:null}
    <section class="project-bundle-tools" aria-label="Portable project files"><div><h3>Portable project bundles</h3><p>Keep the model, retained results and original files together.</p><p class="cloud-muted">Limits: 128 MiB per bundle, 64 MiB for the engine archive, 32 MiB per file and 256 files.</p></div><Cmd dispatch={dispatch} cmd="project.importBundle" class="tbutton outline" disabled={!s.ready}>Open project bundle</Cmd></section>
  </div>;
}
