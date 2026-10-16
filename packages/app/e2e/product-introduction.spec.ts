import {readFileSync} from 'node:fs';
import {expect,test} from './fixtures';

test.describe('@cpu public introduction',()=>{
  test('@hosted explains the product before local and hosted actions and keeps anonymous AI drafts local',async({page})=>{
    test.skip(process.env['FEMLAB_AI_MODE']==='development','Hosted authentication is checked before the explicit BYOK build.');
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
    await expect(page.getByRole('dialog',{name:'Sign in for AI'})).toBeVisible();
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
  test('the documented first simulation runs through the real Script host and produces a result',async({page})=>{
    const markdown=readFileSync(new URL('../../../docs/guide/getting-started.md',import.meta.url),'utf8');
    const examples=[...markdown.matchAll(/```ts\n([\s\S]*?)```/g)];
    const code=examples.find(example=>example[1]!.includes("name: 'My cantilever'"))?.[1];
    expect(code).toBeTruthy();
    await page.goto('./');await page.waitForFunction(()=>Boolean(window.fem));
    const result=await page.evaluate(code=>window.fem.dispatch({cmd:'script.run',code}),code!);
    expect(result).not.toHaveProperty('error');
    const model=await page.evaluate(()=>window.fem.query.model());
    expect(model).toMatchObject({name:'My cantilever',steps:[{name:'static'}]});
    const solved=await page.evaluate(()=>window.fem.query.result({step:'static'}));
    expect(solved).toBeTruthy();
  });
});
