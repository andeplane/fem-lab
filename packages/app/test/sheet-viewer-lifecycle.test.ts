import { afterEach, expect, it, vi } from 'vitest';
import type { LineSegments, Mesh, WebGLRenderer } from 'three';
import type { AppSurface } from '../src/worker-transport';
import { Viewer } from '../src/viewer/viewer';

vi.unmock('../src/viewer/viewer');

// Exercise real three.js geometry, bounds, materials and controls; only the GPU boundary is fake.
vi.mock('three', async importOriginal => {
  const actual = await importOriginal<typeof import('three')>();
  class RendererStub implements Pick<WebGLRenderer, 'localClippingEnabled' | 'setPixelRatio' | 'setSize' | 'render' | 'dispose'> {
    localClippingEnabled = false;
    setPixelRatio(): void {}
    setSize(): void {}
    render(): void {}
    dispose(): void {}
  }
  return { ...actual, WebGLRenderer: RendererStub };
});

const surface: AppSurface = {
  source: 'mesh', positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  indices: Uint32Array.from([0, 1, 2]), triBody: Uint32Array.of(0), triFace: Uint32Array.of(0),
  edges: Uint32Array.from([0, 1, 1, 2, 2, 0]), edgeFace: Uint32Array.from([0, 1, 2]),
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
