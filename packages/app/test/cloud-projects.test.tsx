import {render} from 'preact';
import {act} from 'preact/test-utils';
import {afterEach,expect,it,vi} from 'vitest';
import {initialState,type UiState} from '../src/store';
import {CloudProjects,CloudStorage,ProjectSyncDetails,formatStorageBytes} from '../src/ui/CloudProjects';
import {AccountPanel} from '../src/ui/Account';
import {Start} from '../src/ui/Overlays';
const state=():UiState=>({...structuredClone(initialState),ready:true,account:{...initialState.account,configured:true,uid:'owner',email:'owner@example.com',status:'active'},projectSync:{uid:'owner',projects:{},refreshing:false,error:null,storage:{available:true,plan:'free',limitBytes:100_000_000,usedBytes:20_000_000,reservedBytes:5_000_000,pendingBytes:8_000_000,overQuota:false,maxChunkBytes:8_000_000}}});
const project={id:'saved',name:'Bridge study',at:1,createdAt:1,commands:5,hash:null,thumbnail:null};
function mount(s=state()){const dispatch=vi.fn(async(_command:Record<string,unknown>)=>{});act(()=>render(<CloudProjects s={s} dispatch={dispatch}/>,document.body));return dispatch;}
const button=(command:string)=>document.querySelector<HTMLButtonElement>(`[data-cmd="${command}"]`)!;
afterEach(()=>act(()=>render(null,document.body)));
it('shows used, uploading and included storage while keeping internal pending bytes private',()=>{
 const s=state(),dispatch=mount(s);for(const text of ['20 MB','5 MB','100 MB'])expect(document.body.textContent).toContain(text);expect(document.body.textContent).not.toContain('8 MB');expect(document.querySelector('.cloud-storage-breakdown')?.textContent).toBe('Used20 MBUploading5 MBIncluded storage100 MB');expect(document.querySelector('.cloud-storage-note')?.textContent).toBe('Uploads in progress reserve storage. After replacing or deleting a project, space for new uploads may take time to become available.');
 expect(document.querySelector('meter')!.getAttribute('value')).toBe('25');act(()=>button('account.syncProjects').click());expect(dispatch).toHaveBeenCalledWith({cmd:'account.syncProjects'});
 s.projectSync.storage!.overQuota=true;s.projectSync.storage!.available=false;s.projectSync.error='Network is offline';act(()=>render(<CloudProjects s={s} dispatch={dispatch}/>,document.body));
 for(const text of ['over its storage quota','Cloud storage is unavailable','Network is offline'])expect(document.body.textContent).toContain(text);
});
it('never displays a prior account storage, deleted projects or errors',()=>{
 const s=state();s.projectSync.uid='other-owner';s.projectSync.error='Private error';s.projectSync.projects={private:{phase:'conflict',message:'Private content',name:'Secret archive',deleted:true}};mount(s);
 expect(document.querySelector('meter')).toBeNull();for(const text of ['Secret archive','Private','20 MB'])expect(document.body.textContent).not.toContain(text);
});
it('handles loading and signed-out storage without suggesting a zero quota',()=>{
 const s=state();s.projectSync.storage=null;s.projectSync.refreshing=true;const dispatch=mount(s);expect(document.body.textContent).toContain('Loading your cloud project storage');expect(button('account.syncProjects').disabled).toBe(true);
 s.projectSync.refreshing=false;s.account.status='loading';act(()=>render(<CloudProjects s={s} dispatch={dispatch}/>,document.body));expect(button('account.syncProjects').disabled).toBe(true);
 s.account.uid=null;act(()=>render(<CloudProjects s={s} dispatch={dispatch}/>,document.body));expect(document.querySelector('.cloud-storage')).toBeNull();act(()=>button('account.open').click());expect(dispatch).toHaveBeenCalledWith({cmd:'account.open'});
 act(()=>render(<CloudStorage s={s} dispatch={dispatch}/>,document.body));expect(document.body.textContent).toBe('');
});
it('uses decimal storage units truthfully',()=>{
 expect(formatStorageBytes(999)).toBe('999 B');expect(formatStorageBytes(1000)).toBe('1 kB');expect(formatStorageBytes(2_000_000_000)).toBe('2 GB');expect(formatStorageBytes(1_500_000_000_000)).toBe('1.5 TB');expect(formatStorageBytes(-1)).toBe('Unavailable');expect(formatStorageBytes(Infinity)).toBe('Unavailable');
});
it.each(['local','pending','syncing','synced','remote','offline','conflict','quota','error'] as const)('presents %s per row with Command-driven actions',phase=>{
 const s=state();s.projectSync.projects.saved={phase,message:'Useful state',done:4,total:8};const dispatch=vi.fn(async(_command:Record<string,unknown>)=>{});act(()=>render(<ProjectSyncDetails s={s} id="saved" dispatch={dispatch}/>,document.body));
 expect(document.querySelector('[data-sync-phase]')?.getAttribute('data-sync-phase')).toBe(phase);expect(document.body.textContent).toContain('Useful state');act(()=>button('project.downloadBundle').click());expect(dispatch).toHaveBeenCalledWith({cmd:'project.downloadBundle',id:'saved'});
 if(phase==='syncing')expect(document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('50');
 if(phase==='conflict'){act(()=>button('account.restoreProject').click());act(()=>button('account.keepProjectCopy').click());expect(dispatch).toHaveBeenCalledWith({cmd:'account.restoreProject',id:'saved'});expect(dispatch).toHaveBeenCalledWith({cmd:'account.keepProjectCopy',id:'saved'});}
 if(['pending','offline','quota','error'].includes(phase)){act(()=>button('account.syncProjects').click());expect(dispatch).toHaveBeenCalledWith({cmd:'account.syncProjects'});}
 for(const element of document.querySelectorAll('button'))expect(element.hasAttribute('data-cmd')).toBe(true);
});
it('keeps a deleted conflict named with an explicit restore and no keep-both or download',()=>{
 const s=state();s.projectSync.projects.deleted={phase:'conflict',message:'The cloud version changed.',name:'Recovered beam',deleted:true};const dispatch=mount(s);expect(document.body.textContent).toContain('Recovered beam');expect(button('account.restoreProject').textContent).toBe('Restore cloud version');
 expect(document.querySelector('[data-cmd="account.keepProjectCopy"]')).toBeNull();expect(document.querySelector('[data-cmd="project.downloadBundle"]')).toBeNull();act(()=>button('account.restoreProject').click());expect(dispatch).toHaveBeenCalledWith({cmd:'account.restoreProject',id:'deleted'});
});
it('announces indeterminate progress and disables mutations while the account is loading',()=>{
 const s=state();s.projectSync.projects.saved={phase:'syncing',message:null};const dispatch=vi.fn(async(_command:Record<string,unknown>)=>{});act(()=>render(<ProjectSyncDetails s={s} id="saved" dispatch={dispatch}/>,document.body));expect(document.querySelector('[role="progressbar"]')?.hasAttribute('aria-valuenow')).toBe(false);
 s.projectSync.projects.saved={phase:'syncing',message:null,done:30,total:10};act(()=>render(<ProjectSyncDetails s={s} id="saved" dispatch={dispatch}/>,document.body));expect(document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('100');
 s.projectSync.projects.saved.phase='conflict';s.account.status='loading';s.ready=false;act(()=>render(<ProjectSyncDetails s={s} id="saved" dispatch={dispatch}/>,document.body));for(const element of document.querySelectorAll<HTMLButtonElement>('button'))expect(element.disabled).toBe(true);
});
it('uploads a selected browser original only after the explicit upload-copy Command',()=>{
 const s=state();s.anonymousProjects=[project];const dispatch=mount(s);expect(dispatch).not.toHaveBeenCalled();expect(document.body.textContent).toContain('keeps the browser original');act(()=>button('account.uploadProject').click());expect(dispatch).toHaveBeenCalledWith({cmd:'account.uploadProject',id:'saved'});expect(s.anonymousProjects).toEqual([project]);
 s.account.status='loading';act(()=>render(<CloudProjects s={s} dispatch={dispatch}/>,document.body));expect(button('account.uploadProject').disabled).toBe(true);s.account.uid=null;act(()=>render(<CloudProjects s={s} dispatch={dispatch}/>,document.body));expect(document.querySelector('[data-cmd="account.uploadProject"]')).toBeNull();
});
it('shows original input/output metadata, retention errors and exact asset/bundle Commands',()=>{
 const s=state();s.projectArtifactError='One source exceeded its retention budget.';s.projectFiles=[{id:'input',role:'input',name:'parts/source.step',mime:'model/step',bytes:1000},{id:'output',role:'output',name:'report.csv',mime:'text/csv',bytes:0}];const dispatch=mount(s);
 expect(document.querySelector('[role="alert"]')?.textContent).toContain('retention budget');expect(document.body.textContent).toContain('Completed output · 0 B');const downloads=[...document.querySelectorAll<HTMLButtonElement>('[data-cmd="project.downloadAsset"]')];expect(downloads[0]!.getAttribute('aria-label')).toBe('Download parts/source.step');act(()=>downloads[0]!.click());act(()=>downloads[1]!.click());expect(dispatch).toHaveBeenCalledWith({cmd:'project.downloadAsset',id:'input'});expect(dispatch).toHaveBeenCalledWith({cmd:'project.downloadAsset',id:'output'});
 act(()=>button('project.importBundle').click());expect(dispatch).toHaveBeenCalledWith({cmd:'project.importBundle'});s.ready=false;act(()=>render(<CloudProjects s={s} dispatch={dispatch}/>,document.body));expect(button('project.importBundle').disabled).toBe(true);expect(button('project.downloadAsset').disabled).toBe(true);
});
it('integrates row status into Start and account storage into the account panel',()=>{
 const s=state();s.projects=[project];s.projectSync.projects.saved={phase:'synced',message:null};const dispatch=vi.fn(async(_command:Record<string,unknown>)=>{});act(()=>render(<Start s={s} dispatch={dispatch}/>,document.body));expect(document.querySelector('.recent [data-sync-phase="synced"]')).not.toBeNull();expect(document.querySelector('.cloud-storage')).not.toBeNull();
 s.panels.account=true;act(()=>render(<AccountPanel s={s} dispatch={dispatch}/>,document.body));expect(document.querySelector('.profile-panel .cloud-storage')).not.toBeNull();
});
it('offers an explicit fresh browser copy after a terminal upload error',()=>{
 const s=state();s.projectSync.projects.saved={phase:'error',message:'The prior upload expired. Keep a new browser copy.'};const dispatch=vi.fn(async(_command:Record<string,unknown>)=>{});act(()=>render(<ProjectSyncDetails s={s} id="saved" dispatch={dispatch}/>,document.body));
 expect(button('account.keepProjectCopy').textContent).toBe('Keep browser copy');act(()=>button('account.keepProjectCopy').click());expect(dispatch).toHaveBeenCalledWith({cmd:'account.keepProjectCopy',id:'saved'});
});
it('keeps failed or offline deleted rows visible and offers explicit cloud restore after a terminal deletion error',()=>{
 const s=state();s.projectSync.projects={failed:{phase:'error',message:'Deletion request expired.',name:'Deleted local frame',deleted:true},offline:{phase:'offline',message:'Waiting for connection.',name:'Offline deletion',deleted:true}};const dispatch=mount(s);
 expect(document.body.textContent).toContain('Deleted local frame');expect(document.body.textContent).toContain('Offline deletion');expect(button('account.restoreProject').textContent).toBe('Restore cloud version');expect(document.querySelector('[data-cmd="account.keepProjectCopy"]')).toBeNull();act(()=>button('account.restoreProject').click());expect(dispatch).toHaveBeenCalledWith({cmd:'account.restoreProject',id:'failed'});
});
it('explains incomplete retention honestly and exports the current Model/Journal rather than promising a complete bundle',()=>{
 const s=state();s.projectArtifactError='Original source could not be retained.';const dispatch=mount(s);expect(document.querySelector('[role="alert"]')?.textContent).toContain('cloud upload is paused');expect(document.querySelector('[role="alert"]')?.textContent).not.toContain('Download a project bundle');act(()=>button('file.save').click());expect(dispatch).toHaveBeenCalledWith({cmd:'file.save',to:'download'});
});

it.each([false,true])('requires ready startup and configured accounts for cloud sign-in (configured: %s)',configured=>{
 const s=state();s.account.uid=null;s.account.configured=configured;s.ready=false;const dispatch=mount(s);expect(button('account.open').disabled).toBe(true);act(()=>button('account.open').click());expect(dispatch).not.toHaveBeenCalled();
 s.ready=true;act(()=>render(<CloudProjects s={s} dispatch={dispatch}/>,document.body));expect(button('account.open').disabled).toBe(!configured);
});
it.each(['loading','error'] as const)('marks cached storage as last known while account is %s',status=>{
 const s=state();s.account.status=status;const dispatch=mount(s);expect(document.body.textContent).toContain('Last known storage');expect(document.body.textContent).toContain('20 MB');expect(button('account.syncProjects').disabled).toBe(true);act(()=>button('account.syncProjects').click());expect(dispatch).not.toHaveBeenCalled();
 s.account.status='active';act(()=>render(<CloudProjects s={s} dispatch={dispatch}/>,document.body));expect(document.body.textContent).not.toContain('Last known storage');expect(button('account.syncProjects').disabled).toBe(false);
});

it('labels accepting a remote tombstone explicitly while preserving the live browser copy option',()=>{
 const s=state();s.projectSync.projects.saved={phase:'conflict',message:'Old conflict message',remoteDeleted:true};const dispatch=vi.fn(async(_command:Record<string,unknown>)=>{});act(()=>render(<ProjectSyncDetails s={s} id="saved" dispatch={dispatch}/>,document.body));
 expect(button('account.restoreProject').textContent).toBe('Accept cloud deletion');expect(document.body.textContent).toContain('The cloud version was deleted. Keep a browser copy before accepting deletion.');expect(button('account.keepProjectCopy').textContent).toBe('Keep both versions');
 act(()=>button('account.restoreProject').click());expect(dispatch).toHaveBeenCalledWith({cmd:'account.restoreProject',id:'saved'});
});

it('shows the practical portable bundle, engine archive and file limits',()=>{
 mount();expect(document.querySelector('.project-bundle-tools .cloud-muted')?.textContent).toBe('Limits: 128 MiB per bundle, 64 MiB for the engine archive, 32 MiB per file and 256 files.');
});
