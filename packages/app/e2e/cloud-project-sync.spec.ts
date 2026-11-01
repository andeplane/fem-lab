import {test,expect,type Page} from './fixtures';
import {CloudFixtureServer} from './cloud-fixture/server';
import {decodeProjectArtifact} from '../src/project-artifact';
import {readFile} from 'node:fs/promises';
async function ready(page:Page){await page.waitForFunction(()=>Boolean(window.fem),undefined,{timeout:60000});await page.waitForFunction(async()=>Boolean((await window.fem.registry.query({query:'query.workspaceStatus'}) as {ready:boolean}).ready));}
async function identify(page:Page,uid:string|null){await page.evaluate(uid=>window.cloudFixture.identify(uid),uid);await expect.poll(()=>page.evaluate(async()=>{const account=await window.fem.registry.query({query:'query.account'}) as {uid:string|null;status:string};return {uid:account.uid,status:account.status};}).catch(()=>null)).toEqual({uid,status:uid?'active':'anonymous'});await ready(page);}
async function projects(page:Page){return page.evaluate(async()=>(await window.fem.registry.query({query:'query.projects'}) as {projects:{id:string;name:string}[]}).projects);}
test('private project routes wait for account readiness and reject another owner in a fresh browser',async({page,browser})=>{
  const server=new CloudFixtureServer();await server.install(page.context());
  await page.addInitScript(()=>localStorage.setItem('femlab.tour.dismissed','1'));await page.goto('./');await ready(page);await identify(page,'fixture-A');
  await page.evaluate(()=>window.fem.dispatch({cmd:'file.openExample',name:'cantilever'}));await page.evaluate(()=>window.fem.dispatch({cmd:'project.save'}));
  await expect.poll(()=>server.owners.get('fixture-A')?.size??0).toBe(1);
  const saved=[...server.owners.get('fixture-A')!.values()][0]!;
  const expected=await page.evaluate(async()=>({model:await window.fem.query.model(),results:await window.fem.query.results()}));
  const url=new URL(page.url());url.hash='#/projects/cloud-'+saved.project.id;
  const fresh=await browser.newContext();const wrong=await browser.newContext();
  let releaseProfile!:()=>void;const profileGate=new Promise<void>(resolve=>{releaseProfile=resolve;});
  let sawProfile!:()=>void;const profileRequested=new Promise<void>(resolve=>{sawProfile=resolve;});
  try{
    await server.install(fresh);await fresh.addInitScript(()=>{window.cloudFixtureInitialUid='fixture-A';localStorage.setItem('femlab.tour.dismissed','1');});
    await fresh.route('**/__cloud_fixture/v1/account',async route=>{sawProfile();await profileGate;await server.route(route);});
    const restored=await fresh.newPage();await restored.goto(url.href);await profileRequested;
    expect(restored.url()).toBe(url.href); // Do not discard the requested route while the profile loads.
    releaseProfile();
    await expect(restored.locator('.workspace')).toBeVisible();
    await expect.poll(()=>restored.evaluate(()=>window.fem.query.model())).toEqual(expected.model);
    expect(await restored.evaluate(()=>window.fem.query.results())).toEqual(expected.results);
    await expect(restored).toHaveURL(url.href);
    const download=restored.waitForEvent('download');await restored.evaluate(()=>window.fem.dispatch({cmd:'project.downloadBundle'}));
    const bundle=decodeProjectArtifact(new Uint8Array(await readFile((await (await download).path())!)));
    expect((bundle.engine as {file:{model:unknown}}).file.model).toEqual((decodeProjectArtifact(Uint8Array.from(Buffer.concat(saved.chunks))).engine as {file:{model:unknown}}).file.model);
    await identify(restored,null);await expect(restored).toHaveURL(/#\/$/);expect((await restored.evaluate(()=>window.fem.query.model())).bodies).toEqual([]);
    await server.install(wrong);await wrong.addInitScript(()=>{window.cloudFixtureInitialUid='fixture-B';localStorage.setItem('femlab.tour.dismissed','1');});
    const denied=await wrong.newPage();await denied.goto(url.href);await expect(denied).toHaveURL(/#\/$/);
    expect((await denied.evaluate(()=>window.fem.query.model())).bodies).toEqual([]);
    expect(await denied.evaluate(()=>window.fem.query.results())).toMatchObject({records:[]});
  }finally{releaseProfile();await fresh.close();await wrong.close();}
});
test('account cloud saves preserve full solved artifacts, exact files, offline edits and private browser partitions',async({page,browser},testInfo)=>{
  test.setTimeout(240000);const server=new CloudFixtureServer();await server.install(page.context());await page.addInitScript(()=>localStorage.setItem('femlab.tour.dismissed','1'));await page.goto('./');await ready(page);
  const anonymous=await page.evaluate(()=>window.fem.dispatch({cmd:'project.new',name:'browser original'})) as {id:string};await page.evaluate(()=>window.fem.dispatch({cmd:'geometry.addBox',name:'guest-only',size:['1 m','1 m','1 m']}));await page.evaluate(()=>window.fem.dispatch({cmd:'project.save'}));
  await identify(page,'fixture-A');expect(await projects(page)).toEqual([]);expect(server.owners.get('fixture-A')?.size??0).toBe(0);
  await page.getByRole('button',{name:'Upload a copy',exact:true}).click();await expect.poll(()=>server.owners.get('fixture-A')?.size??0).toBe(1);expect((await projects(page)).some(row=>row.id===anonymous.id)).toBe(false);
  await page.evaluate(()=>window.fem.dispatch({cmd:'file.openExample',name:'cantilever'}));
  const original=await page.evaluate(async()=>{const document=await window.fem.registry.query({query:'query.document'}) as {file:unknown};return JSON.stringify(document.file)+'\r\n';});
  const chooser=page.waitForEvent('filechooser');const importOp=page.evaluate(()=>window.fem.dispatch({cmd:'file.open',picker:true}));await (await chooser).setFiles({name:'original-beam.json',mimeType:'application/json',buffer:Buffer.from(original)});await importOp;
  await page.evaluate(()=>window.fem.dispatch({cmd:'solve.run',step:'static',solver:'cpu-direct'}));
  await page.evaluate(()=>window.fem.dispatch({cmd:'project.rename',name:'cloud beam'}));
  const outputEvent=page.waitForEvent('download');await page.evaluate(()=>window.fem.dispatch({cmd:'file.save',to:'download'}));const output=await outputEvent;const outputBytes=await readFile((await output.path())!);
  await page.evaluate(()=>window.fem.dispatch({cmd:'project.save'}));
  const beam=(await projects(page)).find(row=>row.name==='cloud beam')!;
  await expect.poll(()=>[...server.owners.get('fixture-A')?.values()??[]].find(row=>row.project.name==='cloud beam')?.project.bytes??0).toBeGreaterThan(0);
  const records=await page.evaluate(()=>window.fem.registry.query({query:'query.results'}));expect(records).toMatchObject({records:expect.arrayContaining([expect.objectContaining({step:expect.any(String)})])});
  const ownedHandle=await page.evaluateHandle(()=>window.fem);
  await identify(page,'fixture-B');expect(await projects(page)).toEqual([]);await expect.poll(()=>page.evaluate(()=>window.fem.query.model())).toMatchObject({bodies:[]});
  expect(await ownedHandle.evaluate(async fem=>{try{await fem.query.model();return 'leaked';}catch(error){return (error as {code:string}).code;}})).toBe('session.expired');
  await identify(page,'fixture-A');await page.evaluate(id=>window.fem.dispatch({cmd:'project.open',id}),beam.id);expect(await page.evaluate(()=>window.fem.registry.query({query:'query.results'}))).toEqual(records);
  await page.context().setOffline(true);await page.evaluate(()=>window.fem.dispatch({cmd:'model.setName',name:'offline A edit'}));await page.evaluate(()=>window.fem.dispatch({cmd:'project.save'}));
  await page.context().setOffline(false);await page.evaluate(()=>window.fem.dispatch({cmd:'account.syncProjects'}));
  try{await expect.poll(()=>server.modelName('fixture-A','cloud beam')).toBe('offline A edit');}
  catch(error){
    try{
      const local=await page.evaluate(async()=>{
        const {indexedDbAtomicProjects}=await import(/* @vite-ignore */new URL('src/project-repository.ts',document.baseURI).href);
        const {partitionedAtomicProjects}=await import(/* @vite-ignore */new URL('src/project-partitions.ts',document.baseURI).href);
        const {decodeProjectArtifact}=await import(/* @vite-ignore */new URL('src/project-artifact.ts',document.baseURI).href);
        const rows:import('../src/project-repository').ProjectRecord[]=await partitionedAtomicProjects(indexedDbAtomicProjects(indexedDB),'fixture-A').scan();
        const names=(bytes:Uint8Array|undefined)=>{if(!bytes)return null;try{const artifact=decodeProjectArtifact(bytes);return (artifact.engine as import('@femlab/registry').PortableProject).file.journal.entries.flatMap(entry=>{const cmd=entry.cmd as {cmd:string;name?:unknown};return cmd.cmd==='model.setName'||cmd.cmd==='model.new'?[cmd.name]:[];});}catch(cause){return {decodeError:String(cause)};}};
        return {modelName:(await window.fem.query.model()).name,online:navigator.onLine,rows:rows.map(row=>({id:row.id,generation:row.generation,version:row.version,name:row.meta?.name,artifactTag:row.artifactTag,artifactError:row.artifactError,saveSequence:row.saveSequence,modelNames:names(row.artifact),cloud:row.cloud?{remote:row.cloud.remote,dirty:row.cloud.dirty,deleted:row.cloud.deleted,conflict:row.cloud.conflict,upload:row.cloud.upload?{key:row.cloud.upload.key,tag:row.cloud.upload.tag,name:row.cloud.upload.name,projectId:row.cloud.upload.projectId,baseRevision:row.cloud.upload.baseRevision,bytes:row.cloud.upload.bytes.length,modelNames:names(row.cloud.upload.bytes)}:null}:null}))};
      });
      await testInfo.attach('offline-sync-state',{contentType:'application/json',body:JSON.stringify({local,remote:[...server.owners.get('fixture-A')?.values()??[]].map(row=>row.project),remoteModelName:server.modelName('fixture-A','cloud beam'),writes:server.writes,operationKeys:[...server.operations.keys()]},null,2)});
    }catch(diagnosticError){await testInfo.attach('offline-sync-diagnostic-error',{contentType:'text/plain',body:String(diagnosticError)});}
    throw error;
  }
  const afterOfflineRecords=await page.evaluate(()=>window.fem.registry.query({query:'query.results'}));
  const second=await browser.newContext({viewport:{width:390,height:844}});await server.install(second);const other=await second.newPage();await other.addInitScript(()=>localStorage.setItem('femlab.tour.dismissed','1'));await other.goto('http://localhost:'+new URL(page.url()).port+'/fem-lab/');await ready(other);await identify(other,'fixture-A');
  await expect.poll(async()=>(await projects(other)).some(row=>row.name==='cloud beam')).toBe(true);const remote=(await projects(other)).find(row=>row.name==='cloud beam')!;
  await other.evaluate(id=>window.fem.dispatch({cmd:'project.open',id}),remote.id);expect((await other.evaluate(()=>window.fem.query.model())).name).toBe('offline A edit');expect(await other.evaluate(()=>window.fem.registry.query({query:'query.results'}))).toEqual(afterOfflineRecords);
  await other.evaluate(()=>window.fem.dispatch({cmd:'panel.toggle',panel:'projects',open:true}));
  const inputDownload=other.waitForEvent('download');await other.getByRole('button',{name:'Download original-beam.json',exact:true}).click();expect(await readFile((await (await inputDownload).path())!)).toEqual(Buffer.from(original));
  const outputDownload=other.waitForEvent('download');await other.getByRole('button',{name:new RegExp('^Download .*\\.json$')}).filter({hasText:'Download file'}).last().click();expect(await readFile((await (await outputDownload).path())!)).toEqual(outputBytes);
  await other.screenshot({path:'/tmp/femlab-775-cloud-mobile.png',fullPage:true});expect(await other.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  // Two browsers diverge: preserve both snapshots instead of overwriting either revision.
  await page.context().setOffline(true);await page.evaluate(()=>window.fem.dispatch({cmd:'model.setName',name:'browser conflict copy'}));await page.evaluate(()=>window.fem.dispatch({cmd:'project.save'}));
  const previousRemote=[...server.owners.get('fixture-A')!.values()].find(row=>row.project.name==='cloud beam')!.project.revision;
  await other.evaluate(()=>window.fem.dispatch({cmd:'model.setName',name:'newer remote edit'}));await other.evaluate(()=>window.fem.dispatch({cmd:'project.save'}));
  await expect.poll(()=>[...server.owners.get('fixture-A')!.values()].find(row=>row.project.name==='cloud beam')!.project.revision).not.toBe(previousRemote);
  await page.context().setOffline(false);await page.evaluate(()=>window.fem.dispatch({cmd:'account.syncProjects'}));await page.evaluate(()=>window.fem.dispatch({cmd:'panel.toggle',panel:'projects',open:true}));
  const conflicted=page.locator('.recent').filter({hasText:'cloud beam'}).first();await expect(conflicted).toContainText('Choose a version');await conflicted.getByRole('button',{name:'Keep both versions',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>window.fem.query.model())).toMatchObject({name:'browser conflict copy'});
  await expect.poll(()=>[...server.owners.get('fixture-A')!.values()].some(row=>row.project.name==='cloud beam (copy)')).toBe(true);
  expect([...server.owners.get('fixture-A')!.values()].find(row=>row.project.name==='cloud beam')!.project.revision).not.toBe(previousRemote);
  server.quotaExceeded=true;await page.evaluate(()=>window.fem.dispatch({cmd:'model.setName',name:'quota queued work'}));await page.evaluate(()=>window.fem.dispatch({cmd:'project.save'}));await page.evaluate(()=>window.fem.dispatch({cmd:'panel.toggle',panel:'projects',open:true}));
  const queued=page.locator('.recent').filter({hasText:'cloud beam (copy)'}).first();await expect(queued).toContainText('Storage limit reached');expect((await page.evaluate(()=>window.fem.query.model())).name).toBe('quota queued work');
  const localBackup=page.waitForEvent('download');await queued.getByRole('button',{name:'Download project bundle',exact:true}).click();expect((await localBackup).suggestedFilename()).toMatch(/\.femlab$/);
  server.quotaExceeded=false;await queued.getByRole('button',{name:'Retry sync',exact:true}).click();await expect.poll(()=>server.modelName('fixture-A','cloud beam (copy)')).toBe('quota queued work');await expect(queued).toContainText('Synced');
  await second.close();
  await identify(page,null);await expect.poll(async()=>(await projects(page)).some(row=>row.id===anonymous.id)).toBe(true);expect((await projects(page)).some(row=>row.id===beam.id)).toBe(false);
  await page.evaluate(id=>window.fem.dispatch({cmd:'project.open',id}),anonymous.id);expect((await page.evaluate(()=>window.fem.query.model())).bodies).toHaveLength(1);
  await ownedHandle.dispose();
});

test('a reload after a lost first commit receipt resumes one immutable operation without duplicating the browser project',async({page})=>{
  const server=new CloudFixtureServer();await server.install(page.context());await page.addInitScript(()=>localStorage.setItem('femlab.tour.dismissed','1'));await page.goto('./');await ready(page);await identify(page,'fixture-A');server.dropCommitReply=true;
  await page.evaluate(()=>window.fem.dispatch({cmd:'project.new',name:'lost receipt project'}));await page.evaluate(()=>window.fem.dispatch({cmd:'geometry.addBox',name:'retained-body',size:['1 m','1 m','1 m']}));await page.evaluate(()=>window.fem.dispatch({cmd:'project.save'}));
  await expect.poll(()=>server.writes).toBe(1);await page.evaluate(()=>window.fem.dispatch({cmd:'panel.toggle',panel:'projects',open:true}));await expect(page.locator('.recent').filter({hasText:'lost receipt project'})).toContainText('Saved offline');
  await page.reload();await ready(page);await identify(page,'fixture-A');await expect.poll(async()=>(await projects(page)).length).toBe(1);await expect.poll(()=>server.writes).toBe(1);
  const rows=await projects(page);await page.evaluate(id=>window.fem.dispatch({cmd:'project.open',id}),rows[0]!.id);expect((await page.evaluate(()=>window.fem.query.model())).bodies).toHaveLength(1);
  expect(server.owners.get('fixture-A')?.size).toBe(1);expect(server.operations.size).toBe(1);
});


test('complete bundle import, local reopen and download preserve signed-zero retained fields',async({page})=>{
  const server=new CloudFixtureServer();await server.install(page.context());await page.addInitScript(()=>localStorage.setItem('femlab.tour.dismissed','1'));await page.goto('./');await ready(page);
  await page.evaluate(()=>window.fem.dispatch({cmd:'file.openExample',name:'cantilever'}));
  await page.evaluate(()=>window.fem.dispatch({cmd:'solve.run',step:'static',solver:'cpu-direct'}));
  const fixture=await page.evaluate(async()=>{
    const {encodeProjectArtifact}=await import(/* @vite-ignore */new URL('src/project-artifact.ts',document.baseURI).href);
    const project=await window.fem.query.portableProject();
    const field=project.results[0]!.result.fields.displacement!;
    const index=field.data.findIndex(value=>value===0);if(index<0)throw new Error('fixture requires a zero displacement');field.data[index]=-0;
    const bytes=encodeProjectArtifact({name:'signed-zero complete bundle',createdAt:1,engine:project,files:[{id:'exact-input',role:'input',name:'source.bin',mime:'application/octet-stream',data:new Uint8Array([0,255,13,10,128])}]});
    return {bytes:Array.from(bytes as Uint8Array),index,ids:project.results.map(result=>result.id),journal:project.file.journal};
  });
  await page.evaluate(()=>window.fem.dispatch({cmd:'panel.toggle',panel:'projects',open:true}));
  const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Open project bundle',exact:true}).click();await (await chooser).setFiles({name:'signed-zero.femlab',mimeType:'application/octet-stream',buffer:Buffer.from(fixture.bytes)});
  async function verify(){return page.evaluate(async index=>{const project=await window.fem.query.portableProject();return {negative:Object.is(project.results[0]!.result.fields.displacement!.data[index],-0),ids:project.results.map(result=>result.id),journal:project.file.journal};},fixture.index);}
  await expect.poll(()=>verify().catch(()=>null)).toEqual({negative:true,ids:fixture.ids,journal:fixture.journal});
  await page.evaluate(()=>window.fem.dispatch({cmd:'project.save'}));const saved=(await projects(page)).find(row=>row.name==='signed-zero complete bundle')!;
  await page.evaluate(()=>window.fem.dispatch({cmd:'project.new',name:'temporary workspace'}));await page.evaluate(id=>window.fem.dispatch({cmd:'project.open',id}),saved.id);
  await expect.poll(()=>verify().catch(()=>null)).toEqual({negative:true,ids:fixture.ids,journal:fixture.journal});
  const download=page.waitForEvent('download');await page.evaluate(()=>window.fem.dispatch({cmd:'project.downloadBundle'}));const bytes=await readFile((await (await download).path())!);
  expect(await page.evaluate(async({bytes,index})=>{const {decodeProjectArtifact}=await import(/* @vite-ignore */new URL('src/project-artifact.ts',document.baseURI).href);const artifact=decodeProjectArtifact(new Uint8Array(bytes));const project=artifact.engine as import('@femlab/registry').PortableProject;return {negative:Object.is(project.results[0]!.result.fields.displacement!.data[index],-0),files:artifact.files.map((file: {name:string;data:Uint8Array})=>({name:file.name,data:Array.from(file.data)}))};},{bytes:Array.from(bytes),index:fixture.index})).toEqual({negative:true,files:[{name:'source.bin',data:[0,255,13,10,128]}]});
  expect(server.writes).toBe(0);expect(server.operations.size).toBe(0);
});

test('cancellation keeps one owned cloud project and restores its recovered revision in another browser',async({page,browser})=>{
  const server=new CloudFixtureServer();await server.install(page.context());await page.addInitScript(()=>localStorage.setItem('femlab.tour.dismissed','1'));await page.goto('./');await ready(page);await identify(page,'fixture-A');
  const local=await page.evaluate(()=>window.fem.dispatch({cmd:'project.new',name:'cloud cancellation'})) as {id:string};
  await page.evaluate(()=>window.fem.dispatch({cmd:'project.save'}));
  await expect.poll(()=>server.owners.get('fixture-A')?.size??0).toBe(1);
  const remote=[...server.owners.get('fixture-A')!.values()][0]!.project.id;
  await page.evaluate(()=>window.fem.dispatch({cmd:'model.setName',name:'acknowledged cloud recovery'}));
  await page.evaluate(()=>window.fem.dispatch({cmd:'geometry.addBox',name:'recovered-box',size:['1 m','1 m','1 m']}));
  await page.evaluate(()=>window.fem.dispatch({cmd:'journal.undo',steps:1}));
  await page.evaluate(()=>window.fem.dispatch({cmd:'solve.cancel'}));
  expect(await page.evaluate(()=>window.fem.registry.query({query:'query.project'}))).toMatchObject({id:local.id});
  await page.evaluate(()=>window.fem.dispatch({cmd:'journal.redo',steps:1}));
  await page.evaluate(()=>window.fem.dispatch({cmd:'project.save'}));await page.evaluate(()=>window.fem.dispatch({cmd:'account.syncProjects'}));
  await expect.poll(()=>server.modelName('fixture-A','cloud cancellation')).toBe('acknowledged cloud recovery');
  expect(server.owners.get('fixture-A')!.size).toBe(1);expect([...server.owners.get('fixture-A')!.values()][0]!.project.id).toBe(remote);
  const second=await browser.newContext();await server.install(second);const other=await second.newPage();await other.addInitScript(()=>localStorage.setItem('femlab.tour.dismissed','1'));await other.goto('http://localhost:'+new URL(page.url()).port+'/fem-lab/');await ready(other);await identify(other,'fixture-A');
  await expect.poll(async()=>(await projects(other)).some(row=>row.name==='cloud cancellation')).toBe(true);
  const recovered=(await projects(other)).find(row=>row.name==='cloud cancellation')!;await other.evaluate(id=>window.fem.dispatch({cmd:'project.open',id}),recovered.id);
  expect(await other.evaluate(()=>window.fem.query.model())).toMatchObject({name:'acknowledged cloud recovery',bodies:[expect.objectContaining({name:'recovered-box'})]});await second.close();
});

test('a late upload rejection cannot reopen an explicitly restored cloud version',async({page,browser})=>{
  const server=new CloudFixtureServer();await server.install(page.context());await page.addInitScript(()=>localStorage.setItem('femlab.tour.dismissed','1'));await page.goto('./');await ready(page);await identify(page,'fixture-A');
  await page.evaluate(()=>window.fem.dispatch({cmd:'project.new',name:'late response project'}));
  await page.evaluate(()=>window.fem.dispatch({cmd:'model.setName',name:'initial cloud model'}));
  await page.evaluate(()=>window.fem.dispatch({cmd:'project.save'}));await page.evaluate(()=>window.fem.dispatch({cmd:'account.syncProjects'}));
  await expect.poll(()=>server.modelName('fixture-A','late response project')).toBe('initial cloud model');
  const second=await browser.newContext();await server.install(second);const other=await second.newPage();await other.addInitScript(()=>localStorage.setItem('femlab.tour.dismissed','1'));await other.goto(page.url());await ready(other);await identify(other,'fixture-A');
  const remote=(await projects(other)).find(row=>row.name==='late response project')!;await other.evaluate(id=>window.fem.dispatch({cmd:'project.open',id}),remote.id);
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let held=false;
  await page.route('**/__cloud_fixture/v1/projects/uploads/*/commit',async route=>{if(!held){held=true;await gate;}await server.route(route);});
  try{
    await page.evaluate(()=>window.fem.dispatch({cmd:'model.setName',name:'superseded browser model'}));await page.evaluate(()=>window.fem.dispatch({cmd:'project.save'}));await expect.poll(()=>held).toBe(true);
    await other.evaluate(()=>window.fem.dispatch({cmd:'model.setName',name:'explicitly chosen cloud model'}));await other.evaluate(()=>window.fem.dispatch({cmd:'project.save'}));await other.evaluate(()=>window.fem.dispatch({cmd:'account.syncProjects'}));
    await expect.poll(()=>server.modelName('fixture-A','late response project')).toBe('explicitly chosen cloud model');
    const selected=[...server.owners.get('fixture-A')!.values()][0]!;const cloudId=selected.project.id;
    const chosen=decodeProjectArtifact(Uint8Array.from(Buffer.concat(selected.chunks)));
    const refreshing=page.evaluate(async()=>{try{await window.fem.dispatch({cmd:'account.syncProjects'});return null;}catch(error){return (error as {code?:string}).code??String(error);}});
    await page.evaluate(()=>window.fem.dispatch({cmd:'panel.toggle',panel:'projects',open:true}));const row=page.locator('.recent').filter({hasText:'late response project'}).first();
    await expect(row).toContainText('Choose a version');await row.getByRole('button',{name:'Use cloud version',exact:true}).click();
    await expect.poll(()=>page.evaluate(()=>window.fem.query.model())).toMatchObject({name:'explicitly chosen cloud model'});
    await page.evaluate(()=>window.fem.dispatch({cmd:'panel.toggle',panel:'projects',open:true}));
    // Queue an unchanged save before the older request returns, including on fast hosts.
    await page.evaluate(()=>window.fem.dispatch({cmd:'project.save'}));
    const rejected=page.waitForResponse(response=>/\/uploads\/[^/]+\/commit$/.test(response.url())&&response.status()===409);release();await rejected;expect(await refreshing).toBe('session.expired');
    await expect(row).toContainText('Synced');await expect(row).not.toContainText('Choose a version');
    expect((await page.evaluate(()=>window.fem.query.model())).name).toBe('explicitly chosen cloud model');
    const saved=[...server.owners.get('fixture-A')!.values()][0]!;const savedArtifact=decodeProjectArtifact(Uint8Array.from(Buffer.concat(saved.chunks)));
    expect(saved.project.id).toBe(cloudId);expect(savedArtifact.name).toBe(chosen.name);
    expect(savedArtifact.engine).toEqual(chosen.engine);expect(savedArtifact.files).toEqual(chosen.files);
    await page.evaluate(()=>window.fem.dispatch({cmd:'model.setName',name:'edit after cloud choice'}));await page.evaluate(()=>window.fem.dispatch({cmd:'project.save'}));await page.evaluate(()=>window.fem.dispatch({cmd:'account.syncProjects'}));
    await expect.poll(()=>server.modelName('fixture-A','late response project')).toBe('edit after cloud choice');await expect(row).toContainText('Synced');expect(server.owners.get('fixture-A')!.size).toBe(1);
  }finally{release();await second.close();}
});

for(const renamed of [false,true])test(`opening a newer uncached cloud artifact uses its downloaded revision for the next save${renamed?' after a project rename':''}`,async({page,browser})=>{
  const server=new CloudFixtureServer();await server.install(page.context());await page.addInitScript(()=>localStorage.setItem('femlab.tour.dismissed','1'));await page.goto('./');await ready(page);await identify(page,'fixture-A');
  await page.evaluate(()=>window.fem.dispatch({cmd:'project.new',name:'fresh download base'}));await page.evaluate(()=>window.fem.dispatch({cmd:'model.setName',name:'listed cloud model'}));await page.evaluate(()=>window.fem.dispatch({cmd:'project.save'}));await page.evaluate(()=>window.fem.dispatch({cmd:'account.syncProjects'}));
  await expect.poll(()=>server.modelName('fixture-A','fresh download base')).toBe('listed cloud model');
  const second=await browser.newContext();await server.install(second);const other=await second.newPage();await other.addInitScript(()=>localStorage.setItem('femlab.tour.dismissed','1'));await other.goto(page.url());await ready(other);await identify(other,'fixture-A');
  try{
    const listed=(await projects(other)).find(row=>row.name==='fresh download base')!;const title=renamed?'renamed cloud project':'fresh download base';
    if(renamed)await page.evaluate(name=>window.fem.dispatch({cmd:'project.rename',name}),title);
    await page.evaluate(()=>window.fem.dispatch({cmd:'model.setName',name:'newer cloud model'}));await page.evaluate(()=>window.fem.dispatch({cmd:'project.save'}));await page.evaluate(()=>window.fem.dispatch({cmd:'account.syncProjects'}));
    await expect.poll(()=>server.modelName('fixture-A',title)).toBe('newer cloud model');
    const revision=[...server.owners.get('fixture-A')!.values()][0]!.project.revision;
    await other.evaluate(id=>window.fem.dispatch({cmd:'project.open',id}),listed.id);expect((await other.evaluate(()=>window.fem.query.model())).name).toBe('newer cloud model');
    expect((await projects(other)).find(row=>row.id===listed.id)?.name).toBe(title);
    await other.evaluate(()=>window.fem.dispatch({cmd:'model.setName',name:'edit of downloaded model'}));await other.evaluate(()=>window.fem.dispatch({cmd:'project.save'}));await other.evaluate(()=>window.fem.dispatch({cmd:'account.syncProjects'}));
    await expect.poll(()=>server.modelName('fixture-A',title)).toBe('edit of downloaded model');
    const next=[...server.owners.get('fixture-A')!.values()][0]!.project;expect(BigInt(next.revision)).toBeGreaterThan(BigInt(revision));
    await other.evaluate(()=>window.fem.dispatch({cmd:'panel.toggle',panel:'projects',open:true}));await expect(other.locator('.recent').filter({hasText:title})).toContainText('Synced');expect(server.owners.get('fixture-A')!.size).toBe(1);
  }finally{await second.close();}
});
