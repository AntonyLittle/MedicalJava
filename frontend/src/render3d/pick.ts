import type { Volume } from '../api/types';
import type { Labelmap } from '../segmentation/labelmap';
import { voxelAt, voxelSpace } from '../segmentation/voxelSpace';
import type { Coordinate } from '../utils/canvasMath';
import { sampleVolumeAt } from '../utils/volumeGeometry';
import { add, scale, type Ray } from './camera';
import { rayInterval, type ClipBox, type CutPlane } from './clipping';
import { lutAlpha, type TransferLut } from './transferFunctions';
import type { RenderMode } from './VolumeRenderer';
import type { VolumeGrid } from './volumeGrid';

// Accumulated opacity at which DVR counts a ray as having hit something.
const DVR_HIT_OPACITY = 0.5;

// Values are stored values, as in RenderParams.
export interface PickParams {
  mode: RenderMode;
  lut: TransferLut;
  opacityScale: number;
  isoValue: number;
  clipBox: ClipBox;
  cutPlane: CutPlane | null;
  perspective: boolean;
  // For 'labels' mode: the labels and their RGBA colours (alpha 0 = hidden).
  labels?: { labelmap: Labelmap; colors: Uint8Array } | null;
}

// The point the user sees under the ray: the first opaque-enough sample (DVR), the surface (iso), the brightest or
// darkest sample (MIP/MinIP), the first visible segment (labels), or the middle of the visible part of the ray
// (average). Null when the ray misses.
export function pickPoint(volume: Volume, grid: VolumeGrid, ray: Ray, params: PickParams): Coordinate | null {
  const interval = rayInterval(ray, grid, params.clipBox, params.cutPlane, params.perspective);
  if (!interval) return null;
  const [near, far] = interval;
  const pointAt = (t: number) => add(ray.origin, scale(ray.direction, t));
  if (params.mode === 'average') return pointAt((near + far) / 2);

  const step = Math.min(grid.spacing.x, grid.spacing.y, grid.spacing.z);
  if (params.mode === 'labels') {
    if (!params.labels) return null;
    const { labelmap, colors } = params.labels;
    const space = voxelSpace(volume);
    for (let t = near; t <= far; t += step / 2) {
      const point = pointAt(t);
      const voxel = voxelAt(space, point);
      if (!voxel) continue;
      const label = labelmap.data[labelmap.index(voxel.i, voxel.j, voxel.k)];
      if (label !== 0 && colors[label * 4 + 3] > 0) return point;
    }
    return null;
  }
  let transmittance = 1;
  let bestT = NaN;
  let bestValue = params.mode === 'minip' ? Infinity : -Infinity;
  for (let t = near; t <= far; t += step) {
    const value = sampleVolumeAt(volume, pointAt(t));
    if (Number.isNaN(value)) continue;
    switch (params.mode) {
      case 'iso':
        if (value >= params.isoValue) return pointAt(t);
        break;
      case 'dvr': {
        const alphaPerMm = Math.min(0.999, lutAlpha(params.lut, value) * params.opacityScale);
        transmittance *= Math.pow(1 - alphaPerMm, step);
        if (1 - transmittance >= DVR_HIT_OPACITY) return pointAt(t);
        break;
      }
      case 'mip':
        if (value > bestValue) [bestValue, bestT] = [value, t];
        break;
      case 'minip':
        if (value < bestValue) [bestValue, bestT] = [value, t];
        break;
    }
  }
  return Number.isNaN(bestT) ? null : pointAt(bestT);
}
