import {expect,test} from './fixtures';
test.describe('@cpu @hosted optional accounts in the production build',()=>{
  test.skip(process.env['FEMLAB_AI_MODE']==='development','Supplier wire fixtures use the development host.');
  test('anonymous modeling works and hosted AI has no browser key control',async({page})=>{
    await page.addInitScript(()=>localStorage.setItem('femlab.tour.dismissed','1'));await page.goto('./');await page.waitForFunction(()=>Boolean(window.fem),undefined,{timeout:60000});
    await page.evaluate(()=>window.fem.model.new({name:'anonymous-model'}));
    await expect(page.locator('.shell')).toBeVisible();await page.getByRole('button',{name:'Sign in',exact:true}).click();
    await expect(page.getByRole('dialog',{name:'Sign in'})).toContainText('Model, mesh and solve without signing in');await page.getByRole('button',{name:'Close account'}).click();
    await page.evaluate(()=>window.fem.dispatch({cmd:'panel.toggle',panel:'assistant',open:true}));
    const drawer=page.locator('aside.assistant');await expect(drawer).toBeVisible();await expect(drawer.getByText('Sign in')).toBeVisible();await expect(drawer.locator('input[type=password]')).toHaveCount(0);
    await page.evaluate(()=>window.fem.dispatch({cmd:'chat.send',text:'Create a beam'}));await expect(drawer).toContainText('Sign in to use the Assistant.');
    const query=await page.evaluate(()=>window.fem.dispatch({cmd:'account.open'}));expect(query).toBeUndefined();
    const account=await page.evaluate(()=>window.fem.registry.query({query:'query.account'}));expect(account).toMatchObject({uid:null,profile:null});
  });
  test('account controls fit a narrow Chromium viewport',async({page})=>{
    await page.setViewportSize({width:390,height:844});await page.goto('./');await page.waitForFunction(()=>Boolean(window.fem),undefined,{timeout:60000});await page.evaluate(()=>window.fem.dispatch({cmd:'account.open'}));
    await expect(page.getByRole('dialog',{name:'Sign in'})).toBeVisible();const box=await page.getByRole('dialog',{name:'Sign in'}).boundingBox();expect(box!.width).toBeLessThanOrEqual(390);await expect(page.getByRole('button',{name:'Close account'})).toBeVisible();
  });
  test('@hosted explains the product before local and hosted actions and keeps anonymous AI drafts local',async({page})=>{
    const aiRequests:string[]=[];
    page.on('request',request=>{if(/\/(?:chat|v1\/ai)\/completions(?:[?#]|$)/.test(request.url()))aiRequests.push(request.url());});
    await page.setViewportSize({width:1440,height:1000});
    await page.goto('./');
    await expect(page.getByRole('heading',{level:1})).toContainText('your design behaves');
    await expect(page.locator('.landing-local')).toContainText('no account required');
    await expect(page.getByRole('navigation',{name:'Main navigation'}).getByRole('link',{name:'Documentation'})).toHaveAttribute('href',/\/docs\/$/);
    await page.waitForFunction(()=>Boolean(window.fem));
    await page.screenshot({path:'/tmp/femlab-768-landing-desktop.png',fullPage:true});
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({path:'/tmp/femlab-768-landing-mobile.png',fullPage:true});
    await page.getByLabel('describe the part').fill('Check a beam with a tip load');
    await page.getByRole('button',{name:'Sign in to continue',exact:true}).click();
    await expect(page.getByRole('dialog',{name:'Sign in'})).toBeVisible();
    await page.getByRole('button',{name:'Close account'}).click();
    await page.reload();await page.waitForFunction(()=>Boolean(window.fem));
    await expect(page.getByLabel('describe the part')).toHaveValue('Check a beam with a tip load');
    expect(aiRequests).toEqual([]);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.getByRole('button',{name:'Start modeling — free'}).click();
    await expect(page.locator('.shell')).toBeVisible();
    const before=await page.evaluate(()=>window.fem.query.model());
    const docsPage=page.waitForEvent('popup');await page.getByRole('link',{name:'Docs',exact:true}).click();
    const docs=await docsPage;await expect(docs.locator('h1')).toBeVisible();await docs.close();
    expect(await page.evaluate(()=>window.fem.query.model())).toEqual(before);
  });
  test('@hosted the hosted landing composer requires sign-in and preserves an unsent draft', async ({ page }) => {
    const completions: string[] = [];
    page.on('request',request=>{if(/\/(?:chat|v1\/ai)\/completions(?:[?#]|$)/.test(request.url()))completions.push(request.url());});
    await page.goto('./');
    await page.waitForFunction(()=>Boolean(window.fem));
    await page.getByLabel('describe the part').fill('a 1 m steel cantilever, 10 kN at the tip');
    await expect(page.locator('.ask-send')).toHaveText('Sign in to continue');
    await page.getByLabel('describe the part').press('Enter');
    const account=page.getByRole('dialog',{name:'Sign in'});
    await expect(account).toBeVisible();
    await expect(page.locator('aside.assistant')).not.toBeVisible();
    await page.getByRole('button',{name:'Close account'}).click();
    await expect(page.getByLabel('describe the part')).toHaveValue('a 1 m steel cantilever, 10 kN at the tip');
    await page.reload();await page.waitForFunction(()=>Boolean(window.fem));
    await expect(page.getByLabel('describe the part')).toHaveValue('a 1 m steel cantilever, 10 kN at the tip');
    expect(completions).toEqual([]);
    await page.getByRole('button',{name:'Start modeling — free'}).click();
    await expect(page.locator('.shell')).toBeVisible();
    await expect(page.getByRole('link',{name:'Docs',exact:true})).toHaveAttribute('href',/\/docs\/$/);
  });

});
