import { expect, test } from '@playwright/test';
test('@cpu optional Python notebook solves, transfers f64 numpy, plots and preserves source through a bundle', async ({ page }) => {
  test.setTimeout(240_000);
  const pythonRequests: string[] = [];
  page.on('request', request => { if (request.url().includes('pyodide')) pythonRequests.push(request.url()); });
  await page.addInitScript(() => localStorage.setItem('femlab.tour.dismissed','1'));
  await page.goto('./'); await page.waitForFunction(() => !!window.fem, undefined, {timeout:60000});
  await page.evaluate(async () => {
    await window.fem.registry.dispatch({cmd:'project.new',name:'Python notebook'});
    await window.fem.geometry.addBox({name:'bar',size:['1 m','100 mm','100 mm']});
  });
  expect(pythonRequests).toEqual([]);
  await page.locator('.tab',{hasText:'script'}).click();
  await page.getByRole('button',{name:'Python notebook',exact:true}).click();
  const code = `# %%
import numpy as np
import matplotlib.pyplot as plt
await fem.material_add(name='steel', E='210 GPa', nu=0.3, rho='7850 kg/m^3', k='45 W/(m K)', cp='460 J/(kg K)')
await fem.material_assign(material='steel', bodies=['bar'])
await fem.mesh_set(mesher={'kind':'lattice','size':'100 mm'})
await fem.constraint_temperature(name='cold', on='bar.xmin', value='0 degC')
await fem.constraint_temperature(name='hot', on='bar.xmax', value='100 degC')
await fem.step_add(name='conduct', procedure='heat-steady', constraints=['cold','hot'], loads=[])
await fem.solve_run(step='conduct')
# %%
field = await fem.query_field(field='temperature', step='conduct')
assert field['values'].dtype == np.float64
assert abs(np.min(field['values'])-273.15)<1e-8
assert abs(np.max(field['values'])-373.15)<1e-8
plt.plot(np.sort(field['values'])-273.15)
plt.ylabel('Temperature (degC)')
print('E1 Python exact-field checks passed')`;
  await page.evaluate(code => window.fem.registry.dispatch({cmd:'script.setSource',code}), code);
  await expect(page.getByLabel('Python cell 2')).toBeVisible();
  await page.getByRole('button',{name:'Run all cells'}).click();
  await expect(page.locator('.script-out')).toContainText('E1 Python exact-field checks passed',{timeout:180000});
  await expect(page.getByAltText('Python matplotlib output 1')).toBeVisible();
  const journal=await page.evaluate(()=>window.fem.registry.query({query:'query.journal'}));
  expect(JSON.stringify(journal)).toContain('solve.run');
  expect(JSON.stringify(journal)).not.toContain('import numpy');
  const saved=await page.evaluate(()=>window.fem.registry.dispatch({cmd:'project.save'})) as {id:string};
  await page.reload(); await page.waitForFunction(()=>!!window.fem,undefined,{timeout:60000});
  await page.evaluate(id=>window.fem.registry.dispatch({cmd:'project.open',id}),saved.id);
  await page.locator('.tab',{hasText:'script'}).click();
  await expect(page.getByLabel('Python cell 2')).toHaveValue(/np.float64/);
  await expect(page.getByAltText('Python matplotlib output 1')).toBeVisible();
});


test('@cpu Python documentation is discoverable independent HTML with the registered notebook API',async({page})=>{
  const requests:string[]=[];page.on('request',request=>requests.push(request.url()));
  await page.goto('docs/');
  await page.getByRole('link',{name:'Python and notebooks',exact:true}).first().click();
  await expect(page).toHaveURL(/\/docs\/python\/$/);
  await expect(page.locator('article h1')).toHaveText('Python and notebooks');
  await expect(page.locator('article')).toContainText('loopback');
  await expect(page.locator('article')).toContainText('Run all cells');
  expect(requests.filter(url=>/pyodide|wasm_bg|session\.worker/.test(url))).toEqual([]);
  await page.getByRole('link',{name:'API reference',exact:true}).first().click();
  await expect(page.locator('[data-api-entry="command:host:script.setLanguage"]')).toContainText('Select TypeScript or Python');
});
