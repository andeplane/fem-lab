import { expect, it } from 'vitest';
import { Box3, OrthographicCamera, PerspectiveCamera, Vector3 } from 'three';
import { fitCamera, type FitViewport } from '../src/viewer/framing';

const viewports: FitViewport[] = [
  { width: 600, height: 590, left: 12, right: 410, top: 94, bottom: 500 },
  { width: 1018, height: 632, left: 12, right: 828, top: 52, bottom: 574 },
  { width: 640, height: 480, left: 12, right: 628, top: 12, bottom: 468 },
];

for (const projection of ['perspective', 'orthographic']) for (const scale of [0.001, 1, 1e6]) {
  it(`fits ${scale}m corners into the actual unobscured ${projection} rectangle with a restorable pose`, () => {
    for (const viewport of viewports) {
      const aspect = viewport.width / viewport.height;
      const camera = projection === 'perspective' ? new PerspectiveCamera(38, aspect, 1e-10, 1e12)
        : new OrthographicCamera(-scale * aspect, scale * aspect, scale, -scale, -1e12, 1e12);
      camera.up.set(0, 0, 1); camera.zoom = 4;
      const box = new Box3(new Vector3(2 * scale, -3 * scale, 4 * scale), new Vector3(3 * scale, -2.9 * scale, 4.1 * scale));
      const pose = JSON.parse(JSON.stringify(fitCamera(box, new Vector3(1, -1.35, 0.9), camera, viewport)));
      camera.position.set(...pose.position as [number, number, number]);
      camera.up.set(...pose.up as [number, number, number]);
      camera.zoom = pose.zoom; camera.updateProjectionMatrix();
      camera.lookAt(new Vector3(...pose.target)); camera.updateMatrixWorld();
      for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
        // Independent oracle: three.js projects each physical corner through the real camera.
        const projected = new Vector3(x, y, z).project(camera);
        const px = (projected.x + 1) * viewport.width / 2, py = (1 - projected.y) * viewport.height / 2;
        expect(px).toBeGreaterThanOrEqual(viewport.left - 1e-6); expect(px).toBeLessThanOrEqual(viewport.right + 1e-6);
        expect(py).toBeGreaterThanOrEqual(viewport.top - 1e-6); expect(py).toBeLessThanOrEqual(viewport.bottom + 1e-6);
      }
      const centre = box.getCenter(new Vector3()).project(camera);
      expect((centre.x + 1) * viewport.width / 2).toBeCloseTo((viewport.left + viewport.right) / 2, 6);
      expect((1 - centre.y) * viewport.height / 2).toBeCloseTo((viewport.top + viewport.bottom) / 2, 6);
    }
  });
}

it.each(['perspective', 'orthographic'])('serializes a stable %s basis when previous up is zero, parallel or nearly parallel to iso', projection => {
  const viewport = viewports[0]!;
  const aspect = viewport.width / viewport.height;
  for (const previousUp of [[0, 0, 0], [1, -1.35, 0.9], [1 + 1e-10, -1.35, 0.9]]) {
    const camera = projection === 'perspective' ? new PerspectiveCamera(38, aspect, 0.001, 100)
      : new OrthographicCamera(-aspect, aspect, 1, -1, -100, 100);
    camera.up.set(...previousUp as [number, number, number]);
    const box = new Box3(new Vector3(0, 0, 0), new Vector3(1, 0.1, 0.1));
    const pose = JSON.parse(JSON.stringify(fitCamera(box, new Vector3(1, -1.35, 0.9), camera, viewport)));
    expect(pose.up).toEqual([0, 0, 1]);
    camera.up.set(...pose.up as [number, number, number]);
    camera.position.set(...pose.position as [number, number, number]);
    camera.zoom = pose.zoom; camera.updateProjectionMatrix();
    camera.lookAt(new Vector3(...pose.target)); camera.updateMatrixWorld();
    for (const x of [0, 1]) for (const y of [0, 0.1]) for (const z of [0, 0.1]) {
      const point = new Vector3(x, y, z).project(camera);
      const px = (point.x + 1) * viewport.width / 2, py = (1 - point.y) * viewport.height / 2;
      expect(px).toBeGreaterThanOrEqual(viewport.left - 1e-6); expect(px).toBeLessThanOrEqual(viewport.right + 1e-6);
      expect(py).toBeGreaterThanOrEqual(viewport.top - 1e-6); expect(py).toBeLessThanOrEqual(viewport.bottom + 1e-6);
    }
  }
});
