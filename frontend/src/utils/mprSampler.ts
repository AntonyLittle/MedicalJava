import type { RadioDensities, Slice, Volume } from '../api/types';
import { moveViewablePlaneForward, type Coordinate, type ViewablePlane } from './canvasMath';

export type PlaneOrientation = 'axial' | 'coronal' | 'sagittal';

export const NORMAL_BY_ORIENTATION: Record<PlaneOrientation, Coordinate> = {
  axial: { x: 0, y: 0, z: 1 },
  coronal: { x: 0, y: 1, z: 0 },
  sagittal: { x: 1, y: 0, z: 0 },
};

export type ProjectionMode = 'average' | 'max' | 'min';

export interface SlabOptions {
  thicknessMm: number;
  mode: ProjectionMode;
  maxSamples?: number;
}

// Bounds the cost of a slab update: each sample is a full cross-section.
export const MAX_SLAB_SAMPLES = 64;

// Cheap sample count used while the user is still scrolling or dragging.
export const PREVIEW_SLAB_SAMPLES = 12;

// Matches the padding value of the sample DICOM data (air = -2000).
export const OUTSIDE_VOLUME_VALUE = -2000;

const EPSILON = 1e-6;

export function orientationFromNormal(normal: Coordinate): PlaneOrientation {
  const ax = Math.abs(normal.x);
  const ay = Math.abs(normal.y);
  const az = Math.abs(normal.z);
  if (az >= ax && az >= ay) return 'axial';
  if (ay >= ax) return 'coronal';
  return 'sagittal';
}

// Extent of the voxel centres in patient coordinates (mm); assumes slices are sorted by depth and share an x/y origin.
export function getVolumeBounds(volume: Volume): { min: Coordinate; max: Coordinate } {
  const first = volume.slices[0];
  const depths = volume.slices.map((s) => s.depthPositionMm);
  return {
    min: { x: first.originXMm, y: first.originYMm, z: Math.min(...depths) },
    max: {
      x: first.originXMm + (first.widthPixels - 1) * first.pixelSpacingXMm,
      y: first.originYMm + (first.heightPixels - 1) * first.pixelSpacingYMm,
      z: Math.max(...depths),
    },
  };
}

// Fractional slice index for a depth, or NaN when outside the volume.
function depthToSliceCoordinate(depths: number[], z: number): number {
  const last = depths.length - 1;
  if (z < depths[0] - EPSILON || z > depths[last] + EPSILON) return NaN;
  if (last === 0) return 0;

  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (depths[mid] <= z) lo = mid;
    else hi = mid;
  }
  const span = depths[hi] - depths[lo];
  const t = span > 0 ? (z - depths[lo]) / span : 0;
  return Math.min(last, Math.max(0, lo + t));
}

interface AxisWeights {
  i0: Int32Array;
  i1: Int32Array;
  t: Float64Array;
}

function createWeights(length: number): AxisWeights {
  return { i0: new Int32Array(length), i1: new Int32Array(length), t: new Float64Array(length) };
}

// Stores the two neighbouring voxel indices and blend factor; i0 = -1 marks a position outside the volume (or NaN).
function setWeight(weights: AxisWeights, k: number, fraction: number, count: number): void {
  if (!(fraction >= -EPSILON && fraction <= count - 1 + EPSILON)) {
    weights.i0[k] = -1;
    return;
  }
  const lo = Math.min(count - 1, Math.max(0, Math.floor(fraction)));
  weights.i0[k] = lo;
  weights.i1[k] = Math.min(count - 1, lo + 1);
  weights.t[k] = Math.min(1, Math.max(0, fraction - lo));
}

// Weights for output pixels laid out along one voxel axis, computed once per plane instead of per pixel.
function axisWeights(length: number, outSpacing: number, voxelSpacing: number, count: number): AxisWeights {
  const weights = createWeights(length);
  for (let k = 0; k < length; k++) setWeight(weights, k, (k * outSpacing) / voxelSpacing, count);
  return weights;
}

// b0/b1 are row offsets (y * width) into the slice data.
function bilinear(data: Int16Array, b0: number, b1: number, x0: number, x1: number, tx: number, ty: number): number {
  const top = data[b0 + x0] * (1 - tx) + data[b0 + x1] * tx;
  const bottom = data[b1 + x0] * (1 - tx) + data[b1 + x1] * tx;
  return top * (1 - ty) + bottom * ty;
}

// Sampling a slab finer than the voxel spacing along its normal only repeats interpolated values.
function spacingAlongNormal(volume: Volume, orientation: PlaneOrientation): number {
  const { pixelSpacingXMm, pixelSpacingYMm } = volume.slices[0];
  if (orientation === 'coronal') return pixelSpacingYMm;
  if (orientation === 'sagittal') return pixelSpacingXMm;

  const { min, max } = getVolumeBounds(volume);
  const gaps = volume.slices.length - 1;
  return gaps > 0 ? (max.z - min.z) / gaps : outputSpacing(volume);
}

export function slabSampleCount(
  volume: Volume,
  orientation: PlaneOrientation,
  thicknessMm: number,
  maxSamples = MAX_SLAB_SAMPLES
): number {
  return Math.min(maxSamples, Math.floor(thicknessMm / spacingAlongNormal(volume, orientation)) + 1);
}

// Only the position along the dominant normal axis changes the sampled image, so hooks key on these.
export function planeOrientationAndOffset(plane: ViewablePlane): { orientation: PlaneOrientation; offsetMm: number } {
  const orientation = orientationFromNormal(plane.normalXyz);
  const axis = orientation === 'axial' ? 'z' : orientation === 'coronal' ? 'y' : 'x';
  return { orientation, offsetMm: plane.positionXyz[axis] };
}

export function planeFromOrientation(orientation: PlaneOrientation, offsetMm: number): ViewablePlane {
  const positionXyz = { x: 0, y: 0, z: 0 };
  if (orientation === 'axial') positionXyz.z = offsetMm;
  else if (orientation === 'coronal') positionXyz.y = offsetMm;
  else positionXyz.x = offsetMm;
  return { positionXyz, normalXyz: NORMAL_BY_ORIENTATION[orientation] };
}

interface PlaneGrid {
  widthPixels: number;
  heightPixels: number;
}

// Square output pixels because CanvasRenderer scales both axes by the same factor.
function outputSpacing(volume: Volume): number {
  return Math.min(volume.slices[0].pixelSpacingXMm, volume.slices[0].pixelSpacingYMm);
}

function planeGrid(volume: Volume, orientation: PlaneOrientation): PlaneGrid {
  const bounds = getVolumeBounds(volume);
  const spacing = outputSpacing(volume);
  const cells = (min: number, max: number) => Math.floor((max - min) / spacing) + 1;

  if (orientation === 'axial') {
    return { widthPixels: cells(bounds.min.x, bounds.max.x), heightPixels: cells(bounds.min.y, bounds.max.y) };
  }
  const inPlane = orientation === 'coronal' ? cells(bounds.min.x, bounds.max.x) : cells(bounds.min.y, bounds.max.y);
  return { widthPixels: inPlane, heightPixels: cells(bounds.min.z, bounds.max.z) };
}

// Visits every pixel of the plane's grid with its interpolated value (NaN outside the volume).
// Only the plane position along its dominant normal axis is used; in-plane axes are fixed per orientation.
function samplePlane(
  volume: Volume,
  viewablePlane: ViewablePlane,
  grid: PlaneGrid,
  visit: (index: number, value: number) => void
): void {
  const slices = volume.slices;
  const { widthPixels: width, heightPixels: height, pixelSpacingXMm: sx, pixelSpacingYMm: sy } = slices[0];
  const bounds = getVolumeBounds(volume);
  const depths = slices.map((s) => s.depthPositionMm);
  const orientation = orientationFromNormal(viewablePlane.normalXyz);
  const position = viewablePlane.positionXyz;
  const outSpacing = outputSpacing(volume);
  const { widthPixels: outWidth, heightPixels: outHeight } = grid;

  if (orientation === 'axial') {
    const zw = createWeights(1);
    setWeight(zw, 0, depthToSliceCoordinate(depths, position.z), slices.length);
    if (zw.i0[0] < 0) {
      for (let i = 0; i < outWidth * outHeight; i++) visit(i, NaN);
      return;
    }

    const tz = zw.t[0];
    const dataA = slices[zw.i0[0]].radiodensities;
    const dataB = tz > 0 ? slices[zw.i1[0]].radiodensities : null;
    const xw = axisWeights(outWidth, outSpacing, sx, width);
    const yw = axisWeights(outHeight, outSpacing, sy, height);

    for (let row = 0; row < outHeight; row++) {
      const rowY0 = yw.i0[row];
      const b0 = rowY0 * width;
      const b1 = yw.i1[row] * width;
      const ty = yw.t[row];
      for (let col = 0; col < outWidth; col++) {
        const index = row * outWidth + col;
        const x0 = xw.i0[col];
        if (rowY0 < 0 || x0 < 0) {
          visit(index, NaN);
          continue;
        }
        let value = bilinear(dataA, b0, b1, x0, xw.i1[col], xw.t[col], ty);
        if (dataB) value = value * (1 - tz) + bilinear(dataB, b0, b1, x0, xw.i1[col], xw.t[col], ty) * tz;
        visit(index, value);
      }
    }
    return;
  }

  // Coronal columns run along x with y fixed; sagittal columns run along y with x fixed.
  const alongX = orientation === 'coronal';
  const inPlane = alongX
    ? axisWeights(outWidth, outSpacing, sx, width)
    : axisWeights(outWidth, outSpacing, sy, height);
  const fixed = createWeights(1);
  if (alongX) setWeight(fixed, 0, (position.y - bounds.min.y) / sy, height);
  else setWeight(fixed, 0, (position.x - bounds.min.x) / sx, width);

  const colX0 = new Int32Array(outWidth);
  const colX1 = new Int32Array(outWidth);
  const colTx = new Float64Array(outWidth);
  const colB0 = new Int32Array(outWidth);
  const colB1 = new Int32Array(outWidth);
  const colTy = new Float64Array(outWidth);
  for (let col = 0; col < outWidth; col++) {
    if (fixed.i0[0] < 0 || inPlane.i0[col] < 0) {
      colX0[col] = -1;
    } else if (alongX) {
      colX0[col] = inPlane.i0[col];
      colX1[col] = inPlane.i1[col];
      colTx[col] = inPlane.t[col];
      colB0[col] = fixed.i0[0] * width;
      colB1[col] = fixed.i1[0] * width;
      colTy[col] = fixed.t[0];
    } else {
      colX0[col] = fixed.i0[0];
      colX1[col] = fixed.i1[0];
      colTx[col] = fixed.t[0];
      colB0[col] = inPlane.i0[col] * width;
      colB1[col] = inPlane.i1[col] * width;
      colTy[col] = inPlane.t[col];
    }
  }

  const zw = createWeights(1);
  for (let row = 0; row < outHeight; row++) {
    // Superior (higher z) at the top of the image.
    setWeight(zw, 0, depthToSliceCoordinate(depths, bounds.max.z - row * outSpacing), slices.length);
    const rowValid = zw.i0[0] >= 0;
    const tz = zw.t[0];
    const dataA = rowValid ? slices[zw.i0[0]].radiodensities : null;
    const dataB = rowValid && tz > 0 ? slices[zw.i1[0]].radiodensities : null;

    for (let col = 0; col < outWidth; col++) {
      const index = row * outWidth + col;
      if (!dataA || colX0[col] < 0) {
        visit(index, NaN);
        continue;
      }
      let value = bilinear(dataA, colB0[col], colB1[col], colX0[col], colX1[col], colTx[col], colTy[col]);
      if (dataB) {
        value = value * (1 - tz) + bilinear(dataB, colB0[col], colB1[col], colX0[col], colX1[col], colTx[col], colTy[col]) * tz;
      }
      visit(index, value);
    }
  }
}

export function sampleCrossSection(volume: Volume, viewablePlane: ViewablePlane): RadioDensities | undefined {
  const slices = volume.slices;
  if (slices.length === 0) return undefined;

  const orientation = orientationFromNormal(viewablePlane.normalXyz);
  if (orientation === 'axial') {
    const fz = depthToSliceCoordinate(slices.map((s) => s.depthPositionMm), viewablePlane.positionXyz.z);
    if (Number.isNaN(fz)) return undefined;
    const { pixelSpacingXMm: sx, pixelSpacingYMm: sy } = slices[0];
    if (sx === sy && Math.abs(fz - Math.round(fz)) < EPSILON) return slices[Math.round(fz)];
  }

  const grid = planeGrid(volume, orientation);
  const out = new Float32Array(grid.widthPixels * grid.heightPixels);
  samplePlane(volume, viewablePlane, grid, (i, value) => {
    out[i] = Number.isNaN(value) ? OUTSIDE_VOLUME_VALUE : value;
  });
  return { ...grid, radiodensities: out };
}

// Axial slabs on square voxels need no interpolation: combine the stored slices inside the slab directly.
function sampleAxialSlabFromSlices(
  slices: Slice[],
  centreZ: number,
  slab: SlabOptions,
  maxSamples: number
): RadioDensities | undefined {
  const half = slab.thicknessMm / 2;
  const inside = slices.filter((s) => Math.abs(s.depthPositionMm - centreZ) <= half + EPSILON);
  if (inside.length === 0) return undefined;

  const { widthPixels, heightPixels } = slices[0];
  const stride = Math.max(1, Math.ceil(inside.length / maxSamples));
  const accumulated = Float32Array.from(inside[0].radiodensities);
  const size = accumulated.length;
  let used = 1;

  for (let j = stride; j < inside.length; j += stride) {
    const data = inside[j].radiodensities;
    used++;
    if (slab.mode === 'max') {
      for (let i = 0; i < size; i++) if (data[i] > accumulated[i]) accumulated[i] = data[i];
    } else if (slab.mode === 'min') {
      for (let i = 0; i < size; i++) if (data[i] < accumulated[i]) accumulated[i] = data[i];
    } else {
      for (let i = 0; i < size; i++) accumulated[i] += data[i];
    }
  }
  if (slab.mode === 'average') for (let i = 0; i < size; i++) accumulated[i] /= used;

  return { widthPixels, heightPixels, radiodensities: accumulated };
}

// Projects a slab centred on the plane; samples outside the volume are ignored.
export function sampleSlab(volume: Volume, viewablePlane: ViewablePlane, slab: SlabOptions): RadioDensities | undefined {
  if (volume.slices.length === 0) return undefined;

  const maxSamples = slab.maxSamples ?? MAX_SLAB_SAMPLES;
  const orientation = orientationFromNormal(viewablePlane.normalXyz);
  const sampleCount = slabSampleCount(volume, orientation, slab.thicknessMm, maxSamples);
  if (sampleCount <= 1) return sampleCrossSection(volume, viewablePlane);

  const { pixelSpacingXMm: sx, pixelSpacingYMm: sy } = volume.slices[0];
  if (orientation === 'axial' && sx === sy) {
    const direct = sampleAxialSlabFromSlices(volume.slices, viewablePlane.positionXyz.z, slab, maxSamples);
    if (direct) return direct;
  }

  const grid = planeGrid(volume, orientation);
  const size = grid.widthPixels * grid.heightPixels;
  const initial = slab.mode === 'max' ? -Infinity : slab.mode === 'min' ? Infinity : 0;
  const accumulated = new Float64Array(size).fill(initial);
  const counts = new Uint16Array(size);

  const visit =
    slab.mode === 'max'
      ? (i: number, value: number) => {
          if (Number.isNaN(value)) return;
          counts[i]++;
          if (value > accumulated[i]) accumulated[i] = value;
        }
      : slab.mode === 'min'
        ? (i: number, value: number) => {
            if (Number.isNaN(value)) return;
            counts[i]++;
            if (value < accumulated[i]) accumulated[i] = value;
          }
        : (i: number, value: number) => {
            if (Number.isNaN(value)) return;
            counts[i]++;
            accumulated[i] += value;
          };

  const step = slab.thicknessMm / (sampleCount - 1);
  for (let k = 0; k < sampleCount; k++) {
    const shifted = moveViewablePlaneForward(viewablePlane, -slab.thicknessMm / 2 + k * step);
    samplePlane(volume, shifted, grid, visit);
  }

  const out = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    if (counts[i] === 0) out[i] = OUTSIDE_VOLUME_VALUE;
    else out[i] = slab.mode === 'average' ? accumulated[i] / counts[i] : accumulated[i];
  }
  return { ...grid, radiodensities: out };
}
