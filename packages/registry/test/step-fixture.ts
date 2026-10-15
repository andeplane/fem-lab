import { STEP_CONVERTER_VERSION } from '../src/step-import';
/** Adapter fixture only. The real STEP box/cylinder supply independent geometry oracles. */
export function triangle() {
  return { success: true, femlab: { version: STEP_CONVERTER_VERSION, complete: true, roots: 1, transferredRoots: 1, sourceRoots: 1, faces: 1, meshes: 1, triangles: 1 }, root: { name: 'root', meshes: [0], children: [] as unknown[] },
    meshes: [{ attributes: { position: { array: [0, 0, 0, 1.0000000000000002, 0, 0, 0, 1, -0] } }, index: { array: [0, 1, 2] }, brep_faces: [{ first: 0, last: 0 }] }] };
}
