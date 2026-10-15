import {expect,test} from './fixtures';
test.describe('@cpu @hosted optional accounts in the production build',()=>{
  test.skip(process.env['FEMLAB_AI_MODE']==='development','Supplier wire fixtures use the development host.');
  test('anonymous modeling works and hosted AI has no browser key control',async({page})=>{
    await page.addInitScript(()=>localStorage.setItem('femlab.tour.dismissed','1'));await page.goto('./');await page.waitForFunction(()=>Boolean(window.fem),undefined,{timeout:60000});
    await page.evaluate(()=>window.fem.model.new({name:'anonymous-model'}));
    await expect(page.locator('.shell')).toBeVisible();await page.getByRole('button',{name:'Sign in',exact:true}).click();
    await expect(page.getByRole('dialog',{name:'Sign in for AI'})).toContainText('Model, mesh and solve without signing in');await page.getByRole('button',{name:'Close account'}).click();
    await page.evaluate(()=>window.fem.dispatch({cmd:'panel.toggle',panel:'assistant',open:true}));
    const drawer=page.locator('aside.assistant');await expect(drawer).toBeVisible();await expect(drawer.getByText('Sign in for AI')).toBeVisible();await expect(drawer.locator('input[type=password]')).toHaveCount(0);
    await page.evaluate(()=>window.fem.dispatch({cmd:'chat.send',text:'Create a beam'}));await expect(drawer).toContainText('Sign in to use the Assistant.');
    const query=await page.evaluate(()=>window.fem.dispatch({cmd:'account.open'}));expect(query).toBeUndefined();
    const account=await page.evaluate(()=>window.fem.registry.query({query:'query.account'}));expect(account).toMatchObject({uid:null,profile:null});
  });
  test('account controls fit a narrow Chromium viewport',async({page})=>{
    await page.setViewportSize({width:390,height:844});await page.goto('./');await page.waitForFunction(()=>Boolean(window.fem),undefined,{timeout:60000});await page.evaluate(()=>window.fem.dispatch({cmd:'account.open'}));
    await expect(page.getByRole('dialog',{name:'Sign in for AI'})).toBeVisible();const box=await page.getByRole('dialog',{name:'Sign in for AI'}).boundingBox();expect(box!.width).toBeLessThanOrEqual(390);await expect(page.getByRole('button',{name:'Close account'})).toBeVisible();
  });
});
