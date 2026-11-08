import type { Volume } from '../api/types';
import type { Coordinate } from '../utils/canvasMath';
import { toLocalDirection, toLocalPoint } from '../utils/volumeGeometry';
import type { LabelEdit } from './labelmap';
import { voxelSpace } from './voxelSpace';

export interface BrushOptions {
  radiusMm: number;
  // A ball instead of a disc in the view plane, one voxel thick.
  sphere: boolean;
  // Patient-space unit normal of the view plane the disc lies in.
  planeNormal: Coordinate;
  // The segment painted (or erased).
  label: number;
  erase: boolean;
  // Painting replaces other segments' voxels too; otherwise only background is painted.
  overwrite: boolean;
  // Only voxels whose stored value lies in [low, high] are painted.
  range: [number, number] | null;
}

// Smallest brush, relative to the larger pixel spacing: big enough to always reach the nearest voxel's centre.
const MIN_RADIUS_PIXELS = 0.71;

function effectiveRadius(volume: Volume, radiusMm: number): number {
  const g = voxelSpace(volume).geometry;
  return Math.max(radiusMm, MIN_RADIUS_PIXELS * Math.max(g.spacingX, g.spacingY));
}

// Paints (or erases) the voxels whose centres lie inside the brush at `centre`. Returns how many changed.
export function stampBrush(volume: Volume, edit: LabelEdit, centre: Coordinate, options: BrushOptions): number {
  const space = voxelSpace(volume);
  const g = space.geometry;
  const { depths, width, height } = space;
  const map = edit.labelmap;
  const data = map.data;
  const slices = volume.slices;

  const radius = effectiveRadius(volume, options.radiusMm);
  const radiusSq = radius * radius;
  const c = toLocalPoint(g, centre);
  const n = toLocalDirection(g, options.planeNormal);
  // Half a voxel's extent along the plane normal, so the disc covers exactly one layer of voxels.
  const halfThickness =
    0.5 * (Math.abs(n.x) * g.spacingX + Math.abs(n.y) * g.spacingY + Math.abs(n.z) * space.sliceSpacing) + 1e-6;
  const reach = options.sphere ? radius : radius + halfThickness;

  const [low, high] = options.range ?? [-Infinity, Infinity];
  const { label, erase, overwrite } = options;
  let changed = 0;

  for (let k = 0; k < depths.length; k++) {
    const depth = depths[k];
    const dz = depth - c.z;
    if (Math.abs(dz) > reach) continue;
    const xShift = g.shear.x * depth;
    const yShift = g.shear.y * depth;
    const iMin = Math.max(0, Math.ceil((c.x - reach - xShift) / g.spacingX));
    const iMax = Math.min(width - 1, Math.floor((c.x + reach - xShift) / g.spacingX));
    const jMin = Math.max(0, Math.ceil((c.y - reach - yShift) / g.spacingY));
    const jMax = Math.min(height - 1, Math.floor((c.y + reach - yShift) / g.spacingY));
    const values = slices[k].radiodensities;
    const sliceBase = k * map.sliceSize;
    for (let j = jMin; j <= jMax; j++) {
      const dy = j * g.spacingY + yShift - c.y;
      for (let i = iMin; i <= iMax; i++) {
        const dx = i * g.spacingX + xShift - c.x;
        const distSq = dx * dx + dy * dy + dz * dz;
        if (options.sphere) {
          if (distSq > radiusSq) continue;
        } else {
          const along = dx * n.x + dy * n.y + dz * n.z;
          if (Math.abs(along) > halfThickness || distSq - along * along > radiusSq) continue;
        }
        const pixel = j * width + i;
        const index = sliceBase + pixel;
        const current = data[index];
        if (erase) {
          if (current === label && edit.set(index, 0)) changed++;
          continue;
        }
        if (current === label || (!overwrite && current !== 0)) continue;
        const value = values[pixel];
        if (value < low || value > high) continue;
        if (edit.set(index, label)) changed++;
      }
    }
  }
  return changed;
}

// Stamps along the segment from `from` to `to`, closely enough that consecutive stamps overlap.
export function strokeBrush(
  volume: Volume,
  edit: LabelEdit,
  from: Coordinate,
  to: Coordinate,
  options: BrushOptions
): number {
  const radius = effectiveRadius(volume, options.radiusMm);
  const length = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
  const steps = Math.max(1, Math.ceil(length / (radius / 2)));
  let changed = 0;
  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    changed += stampBrush(
      volume,
      edit,
      { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, z: from.z + (to.z - from.z) * t },
      options
    );
  }
  return changed;
}
