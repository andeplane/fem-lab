import { expect, test, type Page } from './fixtures';

async function boot(page: Page) {
  await page.setViewportSize({ width: 1700, height: 1100 });
  await page.addInitScript(() => { localStorage.setItem('femlab.tour.dismissed', '1'); localStorage.setItem('femlab.autosave', 'off'); });
  await page.goto('./'); await page.waitForFunction(() => Boolean(window.fem));
}
async function raster(page: Page, selector = '.viewer canvas') {
  return page.locator(selector).evaluate(element => {
    const canvas = element as HTMLCanvasElement, gl = canvas.getContext('webgl2')!;
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let count = 0, minX = canvas.width, maxX = -1, minY = canvas.height, maxY = -1;
    for (let i = 0; i < pixels.length; i += 4) {
      // Grid and axes are disabled. Count the actual body, not transport bounds or DOM copy.
      if (Math.max(pixels[i]!, pixels[i+1]!, pixels[i+2]!) <= 65) continue;
      const x = i / 4 % canvas.width, y = Math.floor(i / 4 / canvas.width);
      count++; minX = Math.min(minX,x); maxX = Math.max(maxX,x); minY = Math.min(minY,y); maxY = Math.max(maxY,y);
    }
    return { count, minX, maxX, minY, maxY, width: canvas.width, height: canvas.height };
  });
}
function framed(p: Awaited<ReturnType<typeof raster>>) {
  expect(p.count).toBeGreaterThan(1000);
  expect(p.maxX-p.minX).toBeGreaterThan(p.width*0.2); expect(p.maxY-p.minY).toBeGreaterThan(p.height*0.2);
  expect(p.minX).toBeGreaterThan(2); expect(p.maxX).toBeLessThan(p.width-2);
  expect(p.minY).toBeGreaterThan(2); expect(p.maxY).toBeLessThan(p.height-2);
}
for (const unit of ['mm', 'm']) test(`@cpu fitted 1×2×3 ${unit} geometry stays visible through projection and capture`, async ({ page }, info) => {
  await boot(page);
  await page.evaluate(async unit => {
    await window.fem.geometry.addBox({ name: 'box', size: [`1 ${unit}`, `2 ${unit}`, `3 ${unit}`] });
    for (const layer of ['grid', 'axes']) await window.fem.dispatch({ cmd: 'view.toggle', layer, on: false });
  }, unit);
  const measurements = [];
  for (const projection of ['perspective', 'orthographic']) {
    await page.evaluate(async projection => {
      await window.fem.dispatch({ cmd: 'view.setProjection', projection }); await window.fem.dispatch({ cmd: 'view.fit' });
    }, projection);
    const picture = await raster(page); framed(picture);
    await page.evaluate(async () => {
      const state = await window.fem.registry.query({ query: 'query.view' }) as { position: number[]; target: number[]; up: number[] };
      // An explicit wider view must stay explicit; clipping adaptation must never refit it.
      const position = state.position.map((value, i) => state.target[i]! + (value - state.target[i]!) * 1.2);
      await window.fem.dispatch({ cmd: 'view.setCamera', ...state, position, zoom: 0.9 });
    });
    framed(await raster(page));
    const captured = await page.evaluate(async () => {
      const before = await window.fem.registry.query({ query: 'query.view' });
      const { png } = await window.fem.registry.query({ query: 'query.screenshot', width: 640, height: 480, legend: false }) as { png: string };
      const image = new Image(); image.src = png; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d')!; context.drawImage(image,0,0);
      const pixels = context.getImageData(0,0,image.width,image.height).data;
      let count = 0; for (let i=0;i<pixels.length;i+=4) if (Math.max(pixels[i]!,pixels[i+1]!,pixels[i+2]!)>65) count++;
      return { before, after: await window.fem.registry.query({ query: 'query.view' }), png, width: image.width, height: image.height, count };
    });
    expect(captured.after).toEqual(captured.before); expect([captured.width,captured.height]).toEqual([640,480]); expect(captured.count).toBeGreaterThan(1000);
    measurements.push({ projection, picture, explicitCamera: captured.before, capture: { width: captured.width, height: captured.height, count: captured.count } });
    framed(await raster(page));
    await info.attach(`${unit}-${projection}-capture`, { body: Buffer.from(captured.png.split(',')[1]!, 'base64'), contentType: 'image/png' });
  }
  await info.attach('drawing-buffer-bounds', { body: JSON.stringify(measurements,null,2), contentType: 'application/json' });
});

test('@cpu fitted millimeter retained comparison panes share a visible camera and preserve it during capture', async ({ page }, info) => {
  await boot(page);
  const ids = await page.evaluate(async () => {
    await window.fem.geometry.addBox({ name: 'box', size: ['1 mm','2 mm','3 mm'] });
    await window.fem.material.add({ name:'solid', E:'1 GPa', nu:0 });
    await window.fem.material.assign({ material:'solid', bodies:['box'] });
    await window.fem.mesh.set({ mesher:{ kind:'lattice', size:{nx:1,ny:1,nz:1} }, order:1 });
    await window.fem.constraint.fix({ name:'root', on:'box.xmin' });
    await window.fem.load.traction({ name:'tip', on:'box.xmax', total:['1 N','0 N','0 N'] });
    await window.fem.step.add({ name:'axial', procedure:'static', constraints:['root'], loads:['tip'] });
    await window.fem.solve.run({ step:'axial', solver:'cpu-direct' });
    const left = (await window.fem.query.result()).resultId;
    await window.fem.material.add({ name:'solid', E:'2 GPa', nu:0 });
    await window.fem.solve.run({ step:'axial', solver:'cpu-direct' });
    const right = (await window.fem.query.result()).resultId;
    await window.fem.dispatch({ cmd:'view.compareResults', mode:'sideBySide', left:{resultId:left,field:'displacement',component:0}, right:{resultId:right,field:'displacement',component:0} });
    for (const layer of ['grid','axes']) await window.fem.dispatch({ cmd:'view.toggle',layer,on:false });
    await window.fem.dispatch({cmd:'view.setDeformScale',scale:0});
    return {left,right};
  });
  await expect(page.locator('[data-comparison-pane]')).toHaveCount(2);
  for (const projection of ['perspective','orthographic']) {
    await page.evaluate(async projection => { await window.fem.dispatch({cmd:'view.setProjection',projection}); await window.fem.dispatch({cmd:'view.fit'}); }, projection);
    for (const pane of ['left','right']) framed(await raster(page,`[data-comparison-pane="${pane}"] canvas`));
    const camera = await page.evaluate(() => window.fem.registry.query({query:'query.view'}));
    const {png} = await page.evaluate(() => window.fem.registry.query({query:'query.screenshot',width:1200,height:700,legend:false})) as {png:string};
    expect(await page.evaluate(() => window.fem.registry.query({query:'query.view'}))).toEqual(camera);
    await info.attach(`millimeter-comparison-${projection}`,{body:Buffer.from(png.split(',')[1]!,'base64'),contentType:'image/png'});
    for (const pane of ['left','right']) framed(await raster(page,`[data-comparison-pane="${pane}"] canvas`));
  }
  expect(ids.left).not.toBe(ids.right);
});
