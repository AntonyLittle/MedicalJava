import type { Slice, Volume } from '../api/types';
import type { Coordinate } from '../utils/canvasMath';
import { add, scale, type Ray } from './camera';
import { clippedBox, rayInterval, type ClipBox, type CutPlane } from './clipping';
import { lutAlpha, type TransferLut } from './transferFunctions';
import type { RenderMode } from './VolumeRenderer';
import type { VolumeGrid } from './volumeGrid';

// Accumulated opacity at which DVR counts a ray as having hit something.
const DVR_HIT_OPACITY = 0.5;

interface SliceStack {
  slices: Slice[];
  depths: number[];
}

const stackCache = new WeakMap<Volume, SliceStack>();

function sliceStack(volume: Volume): SliceStack {
  let stack = stackCache.get(volume);
  if (!stack) {
    const slices = [...volume.slices].sort((a, b) => a.depthPositionMm - b.depthPositionMm);
    stack = { slices, depths: slices.map((s) => s.depthPositionMm) };
    stackCache.set(volume, stack);
  }
  return stack;
}

// Trilinear sample of the source slices at a patient-space point, clamped to the volume.
function sampleVolume(stack: SliceStack, p: Coordinate): number {
  const { slices, depths } = stack;
  const first = slices[0];
  const width = first.widthPixels;
  const fx = Math.min(width - 1, Math.max(0, (p.x - first.originXMm) / first.pixelSpacingXMm));
  const fy = Math.min(first.heightPixels - 1, Math.max(0, (p.y - first.originYMm) / first.pixelSpacingYMm));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(first.heightPixels - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;

  let lower = 0;
  let upper = depths.length - 1;
  if (p.z <= depths[0]) upper = 0;
  else if (p.z >= depths[upper]) lower = upper;
  else {
    while (upper - lower > 1) {
      const mid = (lower + upper) >> 1;
      if (depths[mid] <= p.z) lower = mid;
      else upper = mid;
    }
  }
  const span = depths[upper] - depths[lower];
  const tz = span > 0 ? (p.z - depths[lower]) / span : 0;

  const bilinear = (data: Int16Array) => {
    const top = data[y0 * width + x0] * (1 - tx) + data[y0 * width + x1] * tx;
    const bottom = data[y1 * width + x0] * (1 - tx) + data[y1 * width + x1] * tx;
    return top * (1 - ty) + bottom * ty;
  };
  const a = bilinear(slices[lower].radiodensities);
  return tz > 0 ? a + (bilinear(slices[upper].radiodensities) - a) * tz : a;
}

export interface PickParams {
  mode: RenderMode;
  lut: TransferLut;
  opacityScale: number;
  isoValue: number;
  clipBox: ClipBox;
  cutPlane: CutPlane | null;
  perspective: boolean;
}

// The point the user sees under the ray: the first opaque-enough sample (DVR), the surface (iso), the brightest or
// darkest sample (MIP/MinIP), or the middle of the visible segment (average). Null when the ray misses.
export function pickPoint(volume: Volume, grid: VolumeGrid, ray: Ray, params: PickParams): Coordinate | null {
  const interval = rayInterval(ray, clippedBox(grid.box, params.clipBox), params.cutPlane, params.perspective);
  if (!interval) return null;
  const [near, far] = interval;
  const pointAt = (t: number) => add(ray.origin, scale(ray.direction, t));
  if (params.mode === 'average') return pointAt((near + far) / 2);

  const stack = sliceStack(volume);
  const step = Math.min(grid.spacing.x, grid.spacing.y, grid.spacing.z);
  let transmittance = 1;
  let bestT = NaN;
  let bestValue = params.mode === 'minip' ? Infinity : -Infinity;
  for (let t = near; t <= far; t += step) {
    const value = sampleVolume(stack, pointAt(t));
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
