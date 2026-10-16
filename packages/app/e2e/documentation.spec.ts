import {readdirSync} from 'node:fs';
import {expect,test} from './fixtures';

test.describe('@cpu static documentation',()=>{
  test('every guide and complete API reference is emitted as independent HTML',async({page,request})=>{
    const requests:string[]=[];page.on('request',request=>requests.push(request.url()));
    await page.goto('docs/');
    await expect(page.locator('article h1')).toHaveText('FEM Lab documentation');
    await expect(page.locator('#docs-sidebar .docs-nav-group a')).toHaveCount(22);
    await page.screenshot({path:'/tmp/femlab-768-docs-desktop.png',fullPage:true});
    const guides=readdirSync(new URL('../../../docs/guide/',import.meta.url)).filter(name=>name.endsWith('.md')).map(name=>name.slice(0,-3));
    for(const slug of [...guides,'api-reference']){
      const response=await request.get(`docs/${slug==='index'?'':slug+'/'}`);
      expect(response.status(),slug).toBe(200);
      const html=await response.text();expect(html,slug).toContain('data-fem-docs="true"');
      expect(html,slug).toContain('<h1 id=');expect(html,slug).not.toMatch(/modulepreload|session\.worker|wasm_bg|firebase/);
    }
    await page.getByRole('link',{name:'API reference',exact:true}).first().click();
    await expect(page.locator('[data-api-entry]')).toHaveCount(181);
    expect(requests.filter(url=>/wasm|firebase|identitytoolkit|securetoken|\/v1\/|\/chat\/completions|session\.worker/.test(url))).toEqual([]);
  });
  test('mobile navigation and keyboard search navigate to real command anchors',async({page})=>{
    await page.setViewportSize({width:390,height:844});await page.goto('docs/');
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.screenshot({path:'/tmp/femlab-768-docs-mobile.png',fullPage:true});
    const menu=page.getByRole('button',{name:'Browse topics'});await menu.click();
    await expect(menu).toHaveAttribute('aria-expanded','true');
    await expect(page.locator('#docs-sidebar').getByRole('link',{name:'Open FEM Lab'})).toBeVisible();
    await expect(page.locator('#docs-sidebar').getByRole('link',{name:'Open FEM Lab'})).toHaveAttribute('href','/fem-lab/');
    await page.getByRole('navigation',{name:'Documentation',exact:true}).getByRole('link',{name:'Getting started',exact:true}).click();
    await expect(page.locator('article h1')).toBeVisible();
    await page.keyboard.press('Control+k');
    const input=page.getByRole('searchbox',{name:'Search topics or commands'});await input.fill('geometry.addBox');
    const result=page.locator('#docs-search-results a').first();await expect(result).toContainText('geometry.addBox');
    await input.press('ArrowDown');await expect(result).toBeFocused();await result.press('Enter');
    await expect(page).toHaveURL(/\/docs\/api-reference\/#command-engine-geometryaddbox$/);
    await expect(page.locator('#command-engine-geometryaddbox')).toBeVisible();
  });
  test('article and all topic links remain readable with JavaScript disabled',async({browser,baseURL})=>{
    const context=await browser.newContext({baseURL,javaScriptEnabled:false,viewport:{width:390,height:844}});
    try{
      const page=await context.newPage();await page.goto('docs/getting-started/');
      await expect(page.locator('article h1')).toBeVisible();
      await expect(page.getByRole('navigation',{name:'Documentation',exact:true})).toBeVisible();
      await expect(page.locator('article pre code')).not.toHaveCount(0);
      expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      await page.getByRole('navigation',{name:'Documentation',exact:true}).getByRole('link',{name:'API reference',exact:true}).click();
      await expect(page.locator('[data-api-entry]')).toHaveCount(181);
    }finally{await context.close();}
  });
});
