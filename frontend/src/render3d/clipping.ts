import type { Coordinate, ViewablePlane } from '../utils/canvasMath';
import { dot, type Ray } from './camera';
import type { Box } from '../utils/volumeGeometry';
import { applyAffine, applyLinear } from './affine';
import type { VolumeGrid } from './volumeGrid';

// Fractions (0–1) of the volume's patient-space bounding box along each patient axis.
export interface ClipBox {
  min: Coordinate;
  max: Coordinate;
}

export const FULL_CLIP_BOX: ClipBox = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } };

// Keeps the half-space dot(normal, p) <= offsetMm.
export interface CutPlane {
  normal: Coordinate;
  offsetMm: number;
}

export function clippedBox(box: Box, clip: ClipBox): Box {
  const lerp = (axis: keyof Coordinate, t: number) => box.min[axis] + (box.max[axis] - box.min[axis]) * t;
  return {
    min: { x: lerp('x', clip.min.x), y: lerp('y', clip.min.y), z: lerp('z', clip.min.z) },
    max: { x: lerp('x', clip.max.x), y: lerp('y', clip.max.y), z: lerp('z', clip.max.z) },
  };
}

// Keeps the side of the plane its normal points away from, or the other side when flipped.
export function cutPlaneFromViewablePlane(plane: ViewablePlane, flip: boolean): CutPlane {
  const sign = flip ? -1 : 1;
  const normal = { x: plane.normalXyz.x * sign, y: plane.normalXyz.y * sign, z: plane.normalXyz.z * sign };
  return { normal, offsetMm: dot(normal, plane.positionXyz) };
}

function intersectBox(origin: Coordinate, direction: Coordinate, box: Box): [number, number] {
  let near = -Infinity;
  let far = Infinity;
  for (const axis of ['x', 'y', 'z'] as const) {
    const d = direction[axis];
    const o = origin[axis];
    if (Math.abs(d) < 1e-9) {
      if (o < box.min[axis] || o > box.max[axis]) return [1, 0];
      continue;
    }
    const t0 = (box.min[axis] - o) / d;
    const t1 = (box.max[axis] - o) / d;
    near = Math.max(near, Math.min(t0, t1));
    far = Math.min(far, Math.max(t0, t1));
  }
  return [near, far];
}

// Range of the patient-space ray parameter inside the volume, the clip box and the cut plane's kept half-space;
// mirrors raycast.frag.
export function rayInterval(
  ray: Ray,
  grid: VolumeGrid,
  clip: ClipBox,
  cut: CutPlane | null,
  clampToOrigin: boolean
): [number, number] | null {
  const voxel = intersectBox(applyAffine(grid.patientToVoxel, ray.origin), applyLinear(grid.patientToVoxel, ray.direction), grid.voxelBox);
  const clipped = intersectBox(ray.origin, ray.direction, clippedBox(grid.bounds, clip));
  let near = Math.max(voxel[0], clipped[0], clampToOrigin ? 0 : -Infinity);
  let far = Math.min(voxel[1], clipped[1]);
  if (cut) {
    const denominator = dot(cut.normal, ray.direction);
    const distance = cut.offsetMm - dot(cut.normal, ray.origin);
    if (Math.abs(denominator) < 1e-9) {
      if (distance < 0) return null;
    } else if (denominator > 0) {
      far = Math.min(far, distance / denominator);
    } else {
      near = Math.max(near, distance / denominator);
    }
  }
  return near < far ? [near, far] : null;
}
