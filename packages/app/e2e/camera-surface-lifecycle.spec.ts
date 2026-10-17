import type { AppSurface } from '../src/surface';
import type { Viewer } from '../src/viewer/viewer';
import { builtViewerModule, expect, test } from './fixtures';

test('@cpu a surface arriving after an explicit camera renders and picks at its real orthographic scale', async ({ page }, testInfo) => {
  await page.goto('./');
  const readings = await page.evaluate(async file => {
    const url = new URL(file, document.baseURI).href;
    const module = await import(url) as { Viewer: typeof Viewer };
    const canvas = document.createElement('canvas');
    // No ResizeObserver: the test orders camera/surface publication without incidental reflow.
    canvas.style.cssText = 'position:fixed;left:0;top:0;width:800px;height:600px;z-index:10000';
    document.body.append(canvas);
    const viewer = new module.Viewer(canvas);
    try {
      viewer.setProjection('orthographic');
      viewer.setCamera({ position: [6, 1, 20], target: [6, 1, 0], up: [0, 1, 0] });
      const camera = viewer.getCamera();
      viewer.setLayer('grid', false); viewer.setLayer('axes', false);
      const surface: AppSurface = {
        source: 'mesh', positions: Float32Array.from([0,0,0, 12,0,0, 0,2,0, 12,2,0]),
        indices: new Uint32Array(), triBody: new Uint32Array(), triFace: new Uint32Array(),
        edges: Uint32Array.from([0,1, 2,3]), edgeBody: Uint32Array.of(0,0),
        edgeFace: Uint32Array.of(0,1), edgeElement: Uint32Array.of(0,1),
        bodyNames: ['members'], faceNames: ['bottom', 'top'],
      };
      viewer.setSurface(surface);
      viewer.setMode('results'); viewer.setField(Float32Array.of(0,1), [0,1], 'element');
      const measure = (width: number, height: number) => {
        // Use the actual drawing buffer; screenshots would reframe the camera and mask the bug.
        const gl = canvas.getContext('webgl2')!;
        const pixels = new Uint8Array(canvas.width * canvas.height * 4);
        gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        const scale = canvas.height / (2 * Math.hypot(width, height) * 0.7);
        const rect = canvas.getBoundingClientRect();
        return [0, height].map(y => {
          const px = Math.round(canvas.width / 2 - scale);
          const py = Math.round(canvas.height / 2 + (y - 1) * scale);
          let coloured = 0;
          for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
            const i = ((py + dy) * canvas.width + px + dx) * 4;
            const channels = [pixels[i]!, pixels[i + 1]!, pixels[i + 2]!];
            if (Math.max(...channels) > 70 && Math.max(...channels) - Math.min(...channels) > 25) coloured++;
          }
          const cssScale = rect.height / (2 * Math.hypot(width, height) * 0.7);
          return { coloured, pick: viewer.pick(rect.left + rect.width / 2 - cssScale, rect.top + rect.height / 2 - (y - 1) * cssScale), pixel: [px, py] };
        });
      };
      const first = { camera: viewer.getCamera(), members: measure(12, 2), png: canvas.toDataURL() };
      viewer.setSurface({ ...surface, positions: Float32Array.from([0,0,0, 24,0,0, 0,4,0, 24,4,0]) });
      const replaced = { camera: viewer.getCamera(), members: measure(24, 4), png: canvas.toDataURL() };
      viewer.resize();
      const resized = { camera: viewer.getCamera(), members: measure(24, 4) };
      return { camera, first, replaced, resized, buffer: [canvas.width, canvas.height] };
    } finally { viewer.dispose(); canvas.remove(); }
  }, builtViewerModule());
  for (const [name, stage] of [['arriving', readings.first], ['replacement', readings.replaced]] as const)
    await testInfo.attach(`${name}-members`, { body: Buffer.from(stage.png.split(',')[1]!, 'base64'), contentType: 'image/png' });
  const first = { camera: readings.first.camera, members: readings.first.members };
  const replaced = { camera: readings.replaced.camera, members: readings.replaced.members };
  await testInfo.attach('orthographic-publication', { body: JSON.stringify({ ...readings, first, replaced }, null, 2), contentType: 'application/json' });
  for (const stage of [readings.first, readings.replaced, readings.resized]) {
    expect(stage.camera).toEqual(readings.camera);
    for (const [index, member] of stage.members.entries()) {
      expect(member.coloured).toBeGreaterThan(0);
      expect(member.pick?.body).toBe('members');
      expect(member.pick?.face).toBe(index === 0 ? 'bottom' : 'top');
      expect(member.pick?.value).toBe(index);
      expect(member.pick?.point[0]).toBeCloseTo(5, 10);
    }
  }
});
