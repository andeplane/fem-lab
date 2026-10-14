import { afterEach, expect, it, vi } from 'vitest';
import type { Camera, LineSegments, Mesh, Object3D, WebGLRenderer } from 'three';
import type { AppSurface } from '../src/surface';
import { Viewer } from '../src/viewer/viewer';

vi.unmock('../src/viewer/viewer');

// Exercise real three.js geometry, bounds, materials and controls; only the GPU boundary is fake.
vi.mock('three', async importOriginal => {
  const actual = await importOriginal<typeof import('three')>();
  class RendererStub implements Pick<WebGLRenderer, 'localClippingEnabled' | 'setPixelRatio' | 'setSize' | 'render' | 'dispose'> {
    localClippingEnabled = false;
    setPixelRatio(): void {}
    setSize(): void {}
    render(scene: Object3D, camera: Camera): void {
      scene.updateMatrixWorld();
      camera.updateMatrixWorld();
    }
    dispose(): void {}
  }
  return { ...actual, WebGLRenderer: RendererStub };
});

const surface: AppSurface = {
  source: 'mesh', positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  indices: Uint32Array.from([0, 1, 2]), triBody: Uint32Array.of(0), triFace: Uint32Array.of(0),
  edges: Uint32Array.from([0, 1, 1, 2, 2, 0]), edgeFace: Uint32Array.from([0, 1, 2]),
  edgeElementNode: Uint32Array.from([0, 1, 1, 2, 2, 0]), edgeElement: Uint32Array.of(0, 0, 0),
  edgeBody: Uint32Array.from([0, 0, 0]), bodyNames: ['sheet'], faceNames: ['bottom', 'diagonal', 'left'],
};
const lineSurface: AppSurface = {
  source: 'mesh', positions: Float32Array.from([0, 0, 0, 1, 0, 0, 2, 1, 0]),
  indices: new Uint32Array(), triBody: new Uint32Array(), triFace: new Uint32Array(),
  edges: Uint32Array.from([0, 1, 1, 2]), edgeFace: Uint32Array.from([0xffffffff, 0xffffffff]),
  edgeBody: Uint32Array.from([0, 0]), bodyNames: ['truss'], faceNames: [],
};
const viewers: Viewer[] = [];
afterEach(() => { for (const viewer of viewers.splice(0)) viewer.dispose(); document.body.replaceChildren(); });
function setup() {
  const canvas = document.createElement('canvas'); document.body.append(canvas);
  const viewer = new Viewer(canvas); viewers.push(viewer); viewer.setSurface(surface);
  const objects = viewer as unknown as { mesh: Mesh; edges: LineSegments; outlines: LineSegments };
  return { viewer, objects };
}

it('retains hidden Sheet edges across surface and mode rebuilds and disposes each owned geometry once', () => {
  const { viewer, objects } = setup();
  const oldMesh = objects.mesh.geometry, oldEdges = objects.edges.geometry, oldOutline = objects.outlines.geometry;
  const edgeMaterial = vi.fn(), outlineMaterial = vi.fn();
  const meshDisposed = vi.fn(), edgesDisposed = vi.fn(), outlineDisposed = vi.fn();
  oldMesh.addEventListener('dispose', meshDisposed); oldEdges.addEventListener('dispose', edgesDisposed);
  oldOutline.addEventListener('dispose', outlineDisposed);
  const ownedEdgeMaterial = Array.isArray(objects.edges.material) ? objects.edges.material[0]! : objects.edges.material;
  const sharedOutlineMaterial = Array.isArray(objects.outlines.material) ? objects.outlines.material[0]! : objects.outlines.material;
  ownedEdgeMaterial.addEventListener('dispose', edgeMaterial); sharedOutlineMaterial.addEventListener('dispose', outlineMaterial);
  expect(viewer.setLayer('edges', false)).toBe(false);
  viewer.setSurface(surface); viewer.setMode('mesh');
  expect(objects.edges.visible).toBe(false); expect(objects.outlines.visible).toBe(false);
  expect(meshDisposed).toHaveBeenCalledTimes(1); expect(edgesDisposed).toHaveBeenCalledTimes(1);
  expect(outlineDisposed).toHaveBeenCalledTimes(1); expect(edgeMaterial).toHaveBeenCalledTimes(1);
  expect(outlineMaterial).not.toHaveBeenCalled();
  expect(viewer.setLayer('edges')).toBe(true); expect(objects.outlines.visible).toBe(true);
  const finalOutlineDisposed = vi.fn(); objects.outlines.geometry.addEventListener('dispose', finalOutlineDisposed);
  viewer.dispose(); viewer.dispose();
  expect(finalOutlineDisposed).toHaveBeenCalledTimes(1); expect(outlineMaterial).toHaveBeenCalledTimes(1);
});

it('keeps triangle and Sheet boundary bounds on the same once-deformed positions after a rebuild', () => {
  const { viewer, objects } = setup();
  viewer.setDeformed(Float32Array.from([10, 0, 0, 10, 0, 0, 10, 0, 0]), 2);
  viewer.setSurface(surface);
  for (const geometry of [objects.mesh.geometry, objects.outlines.geometry]) {
    expect(geometry.boundingBox?.min.x).toBe(20); expect(geometry.boundingBox?.max.x).toBe(21);
    expect(geometry.boundingSphere?.center.x).toBe(20.5);
  }
});

it('colours line members from endpoint results and keeps body emphasis on outlines', () => {
  const { viewer, objects } = setup();
  viewer.setSurface(lineSurface);
  viewer.setMode('results');
  viewer.setField(Float32Array.from([0, 1, 0.5]), [0, 1]);
  const colours = () => Array.from((objects.outlines.geometry.getAttribute('color') as import('three').BufferAttribute).array);
  const resultColours = colours();
  expect(resultColours[0]).not.toBe(resultColours[3]);
  viewer.setSelection({ bodies: ['truss'], faces: [], sets: [] });
  expect(colours()[0]).not.toBe(resultColours[0]);
  viewer.setHighlight({ bodies: ['truss'] });
  viewer.setDim(true);
  expect(colours()[0]).toBeLessThan(resultColours[0]!);
});

it('previews face/Set and body targets while retaining selection and independent Journal emphasis', () => {
  const { viewer, objects } = setup();
  const colours = () => Array.from(objects.mesh.geometry.getAttribute('color').array);
  viewer.setSurface({ ...surface, setNames: ['named-face'], triSetOffsets: Uint32Array.of(0, 1), triSets: Uint32Array.of(0) });
  viewer.setSelection({ bodies: [], faces: ['bottom'], sets: [] });
  const selected = colours();
  viewer.setHover({ bodies: [], faces: [], sets: ['named-face'] });
  expect(colours()).not.toEqual(selected);
  viewer.setHover({ bodies: [], faces: [], sets: [] });
  expect(colours()).toEqual(selected);
  viewer.setHighlight({ bodies: ['sheet'] });
  const journal = colours();
  viewer.setHover({ bodies: ['sheet'], faces: [], sets: [] });
  expect(colours()).not.toEqual(journal);
  viewer.setHover({ bodies: [], faces: [], sets: [] });
  expect(colours()).toEqual(journal);
  viewer.setHighlight({});
  expect(colours()).toEqual(selected);
  viewer.setSurface(lineSurface);
  const outline = () => Array.from(objects.outlines.geometry.getAttribute('color').array);
  const normal = outline();
  viewer.setHover({ bodies: ['truss'], faces: [], sets: [] });
  expect(outline()).not.toEqual(normal);
  viewer.setHover({ bodies: [], faces: [], sets: [] });
  expect(outline()).toEqual(normal);
});

it('keeps line element-node colours distinct at shared joints through hiding and deformation', () => {
  const { viewer, objects } = setup();
  const retained: AppSurface = { ...lineSurface,
    triElementNode: new Uint32Array(),
    // Reversed field identities deliberately differ from the drawn segment and mesh node ids.
    edgeElement: Uint32Array.of(1, 0), edgeElementNode: Uint32Array.of(3, 2, 1, 0),
    edgeBody: Uint32Array.of(0, 1), bodyNames: ['first', 'second'],
  };
  viewer.setSurface(retained);
  viewer.setMode('results');
  viewer.setField(Float32Array.of(0, 0, 1, 1), [0, 1], 'elementNode');
  const colours = () => objects.outlines.geometry.getAttribute('color');
  const colour = (i: number) => [colours().getX(i), colours().getY(i), colours().getZ(i)];
  const first = colour(0), second = colour(2);
  expect(colour(1)).toEqual(first);
  expect(colour(3)).toEqual(second);
  expect(first).not.toEqual(second); // endpoints 1 and 2 are the same mesh joint
  const canvas = document.querySelector('canvas')!;
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, left: 0, top: 0, right: 640, bottom: 480, width: 640, height: 480, toJSON: () => ({}),
  });
  viewer.setProjection('orthographic');
  viewer.setCamera({ position: [1, 0.5, 8], target: [1, 0.5, 0], up: [0, 1, 0] });
  const halfHeight = Math.hypot(2, 1) * 0.7;
  const pick = (x: number, y: number) => viewer.pick(320 + (x - 1) * 240 / halfHeight, 240 - (y - 0.5) * 240 / halfHeight);
  expect(pick(0.5, 0)?.value).toBe(1);
  expect(pick(1.5, 0.5)?.value).toBe(0);
  viewer.setDeformed(Float32Array.from([0, 1, 0, 0, 2, 0, 0, 3, 0]), 2);
  expect(colour(1)).toEqual(first);
  expect(colour(2)).toEqual(second);
  viewer.setVisible(['first'], false);
  expect(colour(0)).toEqual(second);
  expect(colour(1)).toEqual(second);
  viewer.setVisible(['first'], true);
  viewer.setField(Float32Array.of(0, 1), [0, 1], 'element');
  expect(colour(0)).toEqual(first);
  expect(colour(2)).toEqual(second);
  viewer.setField(Float32Array.of(0, 0.5, 1), [0, 1]);
  expect(colour(1)).toEqual(colour(2)); // nodal fields still share the joint value
  viewer.setField(null, [0, 1]);
  viewer.setSurface({ ...lineSurface, triElementNode: new Uint32Array() });
  expect(() => viewer.setField(Float32Array.of(1, 2, 3, 4), [0, 4], 'elementNode')).toThrow('no edge element-node field mapping');
  expect(() => viewer.setField(Float32Array.of(1, 2), [0, 2], 'element')).toThrow('no edge element field mapping');
});

it('keeps separate element-node colours at a shared mesh node', () => {
  const { viewer, objects } = setup();
  viewer.setSurface({ ...surface,
    indices: Uint32Array.from([0, 1, 2, 0, 2, 1]),
    triElementNode: Uint32Array.from([0, 1, 2, 4, 6, 5]),
    bodyNames: ['first', 'second'], triBody: Uint32Array.from([0, 1]), triFace: Uint32Array.from([0, 0]),
  });
  viewer.setMode('results');
  viewer.setField(Float32Array.from([0, 0, 0, 0, 1, 1, 1, 1]), [0, 1], 'elementNode');
  const colour = objects.mesh.geometry.getAttribute('color');
  expect([colour.getX(0), colour.getY(0), colour.getZ(0)])
    .not.toEqual([colour.getX(3), colour.getY(3), colour.getZ(3)]);
  viewer.setField(Float32Array.from([0, 0, 0]), [0, 1]);
  expect([colour.getX(0), colour.getY(0), colour.getZ(0)])
    .toEqual([colour.getX(3), colour.getY(3), colour.getZ(3)]);
  viewer.setField(Float32Array.from([0, 0, 0, 0, 1, 1, 1, 1]), [0, 1], 'elementNode');
  const second = [colour.getX(3), colour.getY(3), colour.getZ(3)];
  viewer.setVisible(['first'], false);
  const visible = objects.mesh.geometry.getAttribute('color');
  expect([visible.getX(0), visible.getY(0), visible.getZ(0)]).toEqual(second);
  expect(() => viewer.setField(Float32Array.of(1), [0, 1], 'elementGaussPoint')).toThrow('cannot contour');
  viewer.setField(null, [0, 1]);
  viewer.setSurface(surface);
  expect(() => viewer.setField(Float32Array.of(1), [0, 1], 'elementNode')).toThrow('no element-node field mapping');
});

it('colours each triangle by its element id and restores nodal colouring afterwards', () => {
  const { viewer, objects } = setup();
  viewer.setSurface({ ...surface,
    positions: Float32Array.from([0,0,0, 1,0,0, 1,1,0, 0,1,0]),
    indices: Uint32Array.from([0,1,2, 0,2,3]),
    triBody: Uint32Array.of(0,0), triFace: Uint32Array.of(0,0),
    // Reversed deliberately: triangle number and node number are not element id.
    triElement: Uint32Array.of(1,0),
  });
  viewer.setMode('results');
  viewer.setField(Float32Array.of(0.1,0.9), [0,1], 'element');
  const attribute = objects.mesh.geometry.getAttribute('color');
  const colour = (i: number) => [attribute.getX(i), attribute.getY(i), attribute.getZ(i)];
  expect(colour(0)).toEqual(colour(1));
  expect(colour(1)).toEqual(colour(2));
  expect(colour(3)).toEqual(colour(4));
  expect(colour(4)).toEqual(colour(5));
  expect(colour(0)).not.toEqual(colour(3));
  const first = colour(0), second = colour(3);
  viewer.setField(Float32Array.of(0.9,0.1), [0,1], 'element');
  expect(colour(0)).toEqual(second);
  expect(colour(3)).toEqual(first);
  viewer.setField(Float32Array.of(0,1,0.5,0.2), [0,1]);
  expect(colour(0)).not.toEqual(colour(1));
  expect(colour(0)).toEqual(colour(3)); // shared node, not shared element
});

it.each(['lines', 'triangles'] as const)('uses arriving %s bounds for orthographic picks without moving an explicit camera', kind => {
  const canvas = document.createElement('canvas'); document.body.append(canvas);
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, left: 0, top: 0, right: 640, bottom: 480, width: 640, height: 480, toJSON: () => ({}),
  });
  const viewer = new Viewer(canvas); viewers.push(viewer);
  // Camera Commands can precede the first asynchronous surface publication.
  viewer.setProjection('orthographic');
  viewer.setCamera({ position: [6, 1, 20], target: [6, 1, 0], up: [0, 1, 0] });
  const camera = viewer.getCamera();
  const arriving: AppSurface = {
    ...lineSurface, positions: Float32Array.from([0,0,0, 12,0,0, 0,2,0, 12,2,0]),
    edges: Uint32Array.from([0,1, 2,3]), edgeBody: Uint32Array.of(0,0),
    edgeFace: Uint32Array.of(0,1), faceNames: ['bottom', 'top', 'sheet'],
    ...(kind === 'triangles' ? { indices: Uint32Array.from([0,1,2, 1,3,2]), triBody: Uint32Array.of(0,0), triFace: Uint32Array.of(2,2) } : {}),
  };
  const point = kind === 'lines' ? [5, 0] : [5, 0.5];
  const check = (width: number, height: number) => {
    expect(viewer.getCamera()).toEqual(camera);
    const scale = 480 / (2 * Math.hypot(width, height) * 0.7);
    const hit = viewer.pick(320 + (point[0]! - 6) * scale, 240 - (point[1]! - 1) * scale);
    expect(hit?.body).toBe('truss');
    expect(hit?.point[0]).toBeCloseTo(point[0]!, 10);
    expect(hit?.point[1]).toBeCloseTo(point[1]!, 10);
  };
  viewer.setSurface(arriving);
  check(12, 2);
  // Model replacement changes its extent without a window resize or another camera Command.
  viewer.setSurface({ ...arriving, positions: Float32Array.from([0,0,0, 24,0,0, 0,4,0, 24,4,0]) });
  check(24, 4);
  viewer.resize();
  check(24, 4);
});
