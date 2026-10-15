import { Box3, OrthographicCamera, PerspectiveCamera, Vector3 } from 'three';
import type { CameraState } from './viewer';

/** Canvas pixels left unobscured by the host's visible controls. */
export interface FitViewport {
  width: number; height: number;
  left: number; right: number; top: number; bottom: number;
}

/** Fit all box corners inside the usable rectangle using an ordinary, serializable pose. */
export function fitCamera(box: Box3, direction: Vector3, camera: PerspectiveCamera | OrthographicCamera, viewport: FitViewport): CameraState {
  const centre = box.getCenter(new Vector3());
  const back = direction.clone().normalize();
  const viewUp = camera.up.clone().normalize();
  // A legal previous pose can put up along the new iso eye. Choose a stable z-up basis and
  // serialize it too, so Three's lookAt and a later setCamera use the same fitted projection.
  if (viewUp.lengthSq() === 0 || Math.abs(viewUp.dot(back)) > 1 - 1e-8) viewUp.set(0, 0, 1);
  const right = viewUp.clone().cross(back).normalize();
  const up = back.clone().cross(right);
  const left = 2 * viewport.left / viewport.width - 1;
  const rightEdge = 2 * viewport.right / viewport.width - 1;
  const bottom = 1 - 2 * viewport.bottom / viewport.height;
  const top = 1 - 2 * viewport.top / viewport.height;
  const cx = (left + rightEdge) / 2, cy = (bottom + top) / 2;
  const halfWidth = (rightEdge - left) / 2, halfHeight = (top - bottom) / 2;
  let distance = Math.max(box.getSize(new Vector3()).length() * 1.6, 1e-6);
  let extentX = 0, extentY = 0;
  const tan = camera instanceof PerspectiveCamera ? Math.tan(camera.fov * Math.PI / 360) : 0;
  const aspect = viewport.width / viewport.height;
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
    const corner = new Vector3(x, y, z).sub(centre);
    const px = corner.dot(right), py = corner.dot(up), depth = corner.dot(back);
    extentX = Math.max(extentX, Math.abs(px)); extentY = Math.max(extentY, Math.abs(py));
    if (camera instanceof PerspectiveCamera) {
      // Each inequality is the real perspective projection of a corner onto one safe edge.
      distance = Math.max(distance,
        (px / (tan * aspect) + rightEdge * depth) / halfWidth,
        (-px / (tan * aspect) - left * depth) / halfWidth,
        (py / tan + top * depth) / halfHeight,
        (-py / tan - bottom * depth) / halfHeight);
    }
  }
  let zoom = 1, spanX: number, spanY: number;
  if (camera instanceof OrthographicCamera) {
    zoom = Math.min(1, halfWidth * camera.right / Math.max(extentX, 1e-12), halfHeight * camera.top / Math.max(extentY, 1e-12));
    spanX = camera.right / zoom; spanY = camera.top / zoom;
  } else {
    spanY = distance * tan; spanX = spanY * aspect;
  }
  const target = centre.clone().addScaledVector(right, -cx * spanX).addScaledVector(up, -cy * spanY);
  const eye = target.clone().addScaledVector(back, distance);
  return { position: eye.toArray(), target: target.toArray(), up: viewUp.toArray(), zoom };
}
