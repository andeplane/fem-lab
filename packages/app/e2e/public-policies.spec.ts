import {expect,test} from './fixtures';

test.describe('@cpu public policies',()=>{
  test('subscription terms and privacy are readable without loading the app or signing in',async({page})=>{
    const terms=await page.goto('terms.html');
    expect(terms?.status()).toBe(200);
    await expect(page.getByRole('heading',{name:'Terms of service',exact:true})).toBeVisible();
    await expect(page.getByRole('table')).toContainText('Plus');
    await expect(page.getByRole('table')).toContainText('$49 USD / month');
    await expect(page.getByRole('table')).toContainText('50,000,000');
    await expect(page.locator('main')).toContainText('Hafreager kode & koblinger');
    await expect(page.locator('address')).toContainText('FEM Lab operator');
    await expect(page.locator('main')).toContainText('For a direct purchase, Hafreager kode & koblinger is the seller');
    await expect(page.locator('main')).toContainText('If your purchase uses Stripe Managed Payments');
    await expect(page.locator('main')).toContainText('does not change the seller of an earlier direct purchase');
    await expect(page.locator('main')).toContainText('do not renew automatically');
    await expect(page.locator('main')).toContainText('There are no automatic overage charges');
    await expect(page.locator('main')).toContainText('14 days');
    await page.getByRole('navigation',{name:'Policies'}).getByRole('link',{name:'Privacy',exact:true}).click();
    await expect(page.getByRole('heading',{name:'Privacy notice',exact:true})).toBeVisible();
    await expect(page.locator('main')).toContainText('processed by FEM Lab and OpenAI');
    await expect(page.locator('main')).toContainText('Your FEM Lab account and any account used to manage a Managed Payments order are separate');
    await expect(page.locator('main')).toContainText('no automatic expiry');
    await expect(page.locator('main')).toContainText('24 hours');
    await expect(page.locator('script')).toHaveCount(0);
    await page.setViewportSize({width:390,height:844});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.getByRole('navigation',{name:'Policies'}).getByRole('link',{name:'Terms',exact:true}).click();
    await expect(page.getByRole('heading',{name:'Terms of service',exact:true})).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });

  test('landing offers optional account access and public policy links',async({page})=>{
    await page.addInitScript(()=>localStorage.setItem('femlab.tour.dismissed','1'));
    await page.goto('./');
    await expect(page.locator('.start .pitch')).toContainText('Optional hosted AI');
    const policies=page.getByRole('navigation',{name:'FEM Lab policies'});
    await expect(policies.getByRole('link',{name:'Terms of service'})).toHaveAttribute('href',/\/terms\.html$/);
    const popup=page.waitForEvent('popup');
    await policies.getByRole('link',{name:'Privacy notice'}).click();
    const privacy=await popup;
    await expect(privacy.getByRole('heading',{name:'Privacy notice',exact:true})).toBeVisible();
    await privacy.close();
    await page.getByRole('button',{name:'Sign in for AI',exact:true}).click();
    const account=page.getByRole('dialog',{name:'Sign in for AI'});
    await expect(account).toBeVisible();
    await expect(account.getByRole('navigation',{name:'Account policies'}).getByRole('link',{name:'Terms of service'})).toHaveAttribute('href',/\/terms\.html$/);
  });
});
