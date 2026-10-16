import {readFileSync} from 'node:fs';
import {expect,test} from './fixtures';

test.describe('@cpu public introduction',()=>{
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
