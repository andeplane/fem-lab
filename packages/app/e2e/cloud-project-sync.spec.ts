import {test,expect,type Page} from './fixtures';
import {CloudFixtureServer} from './cloud-fixture/server';
import {readFile} from 'node:fs/promises';
async function ready(page:Page){await page.waitForFunction(()=>Boolean(window.fem),undefined,{timeout:60000});await page.waitForFunction(async()=>Boolean((await window.fem.registry.query({query:'query.workspaceStatus'}) as {ready:boolean}).ready));}
async function identify(page:Page,uid:string|null){await page.evaluate(uid=>window.cloudFixture.identify(uid),uid);await expect.poll(()=>page.evaluate(async()=>{const account=await window.fem.registry.query({query:'query.account'}) as {uid:string|null;status:string};return {uid:account.uid,status:account.status};}).catch(()=>null)).toEqual({uid,status:uid?'active':'anonymous'});await ready(page);}
async function projects(page:Page){return page.evaluate(async()=>(await window.fem.registry.query({query:'query.projects'}) as {projects:{id:string;name:string}[]}).projects);}
test('account cloud saves preserve full solved artifacts, exact files, offline edits and private browser partitions',async({page,browser})=>{
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
  await expect.poll(()=>server.modelName('fixture-A','cloud beam')).toBe('offline A edit');
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
