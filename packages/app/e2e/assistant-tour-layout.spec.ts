import {expect,test,type Page} from './fixtures';

async function surface(page:Page){
  const drawer=(await page.locator('.assistant').boundingBox())!,workspace=(await page.locator('.workspace').boundingBox())!,area=(await page.locator('.under-bar').boundingBox())!;
  return {drawer,workspace,area,top:workspace.y,bottom:workspace.y+workspace.height};
}
async function aligned(page:Page,width:number){
  await expect.poll(async()=>{
    const {drawer,top,bottom}=await surface(page);
    return {top:drawer.y-top,bottom:drawer.y+drawer.height-bottom};
  }).toEqual({top:0,bottom:0});
  const {drawer,area,top,bottom}=await surface(page);
  expect(drawer.height).toBeGreaterThan(250);
  expect(bottom).toBe(page.viewportSize()!.height);
  expect(bottom).toBe(area.y+area.height);
  if(width>=1024){
    const splitter=(await page.getByRole('separator',{name:'Resize assistant panel'}).boundingBox())!;
    expect(splitter.y).toBe(top);expect(splitter.height).toBe(drawer.height);
  }
  await page.locator('.assistant textarea').click({trial:true});
  const composer=(await page.locator('.assistant .composer').boundingBox())!;
  expect(composer.y).toBeGreaterThanOrEqual(drawer.y);
  expect(composer.y+composer.height).toBeLessThanOrEqual(bottom);
}

for(const width of [1600,1280,1100,390]){
 test(`@cpu Assistant follows the tour/workspace at ${width}px without losing its draft`,async({page})=>{
  await page.setViewportSize({width,height:900});
  const external:string[]=[];
  page.on('request',request=>{if(/identitytoolkit|\/chat\/completions|\/account(?:\/|$)|checkout\.stripe/.test(request.url()))external.push(request.url().split('?')[0]!);});
  await page.goto('./');await page.waitForFunction(()=>window.fem!==undefined,undefined,{timeout:60_000});
  await page.evaluate(()=>window.fem.dispatch({cmd:'chat.setDraft',text:'Keep my unsent draft'}));
  const drawer=page.locator('.assistant');await expect(drawer).toBeVisible();
  const start=(await drawer.boundingBox())!;expect(start.y).toBe(0);expect(start.height).toBe(900);
  await page.evaluate(()=>window.fem.dispatch({cmd:'project.new',name:'tour layout'}));
  await expect(page.locator('#modeling-tour-title')).toHaveText('Add geometry');
  const journal=await page.evaluate(()=>window.fem.query.journal());
  await aligned(page,width);
  await page.getByRole('button',{name:'Dismiss modeling tour'}).click({trial:true});
  await page.evaluate(()=>window.fem.dispatch({cmd:'tour.show',step:7}));
  await expect(page.locator('#modeling-tour-title')).toHaveText('Read and check Results');
  await aligned(page,width);
  if(width<1024){
    await page.locator('.workspace').evaluate(element=>{element.scrollTop=element.scrollHeight;});
    expect(await page.locator('.workspace').evaluate(element=>element.scrollTop)).toBeGreaterThan(0);
    await aligned(page,width);
  }
  expect(await page.evaluate(()=>window.scrollY)).toBe(0);
  const tour=(await page.locator('.tour-callout').boundingBox())!,shown=await surface(page);
  expect(shown.drawer.y).toBeGreaterThanOrEqual(tour.y+tour.height);
  await page.screenshot({path:`/tmp/femlab-792-tour-assistant-${width}.png`});
  await page.getByRole('button',{name:'Dismiss modeling tour'}).click();
  await expect(page.locator('.tour-callout')).toHaveCount(0);
  await aligned(page,width);
  expect(await page.evaluate(()=>localStorage.getItem('femlab.tour.dismissed'))).toBe('1');
  await page.evaluate(()=>window.fem.dispatch({cmd:'tour.show'}));
  await expect(page.locator('#modeling-tour-title')).toHaveText('Add geometry');
  await aligned(page,width);
  await page.getByRole('button',{name:'Dismiss modeling tour'}).click({trial:true});
  await expect(drawer.locator('textarea')).toHaveValue('Keep my unsent draft');
  expect((await page.evaluate(()=>window.fem.query.journal())).entries).toEqual(journal.entries);
  expect(external).toEqual([]);
 });
}
