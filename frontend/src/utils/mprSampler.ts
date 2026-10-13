import type { ImageGeometry, RadioDensities, Slice, Volume } from '../api/types';
import { moveViewablePlaneForward, type Coordinate, type ViewablePlane } from './canvasMath';

export type PlaneOrientation = 'axial' | 'coronal' | 'sagittal';

// In-plane axes of the unrotated views; a plane matching these can use the faster separable sampling.
const CANONICAL_AXES: Record<PlaneOrientation, { right: Coordinate; down: Coordinate }> = {
  axial: { right: { x: 1, y: 0, z: 0 }, down: { x: 0, y: 1, z: 0 } },
  coronal: { right: { x: 1, y: 0, z: 0 }, down: { x: 0, y: 0, z: -1 } },
  sagittal: { right: { x: 0, y: 1, z: 0 }, down: { x: 0, y: 0, z: -1 } },
};

// Output pixel spacing multiplier for the cheap result shown while a plane is being rotated.
export const PREVIEW_SPACING_SCALE = 2;

export type ProjectionMode = 'average' | 'max' | 'min';

export interface SlabOptions {
  thicknessMm: number;
  mode: ProjectionMode;
  maxSamples?: number;
  spacingScale?: number;
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

function dot(a: Coordinate, b: Coordinate): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function volumeCentre(volume: Volume): Coordinate {
  if (volume.slices.length === 0) return { x: 0, y: 0, z: 0 };
  const { min, max } = getVolumeBounds(volume);
  return { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 };
}

type PlaneAxes = Pick<ViewablePlane, 'normalXyz' | 'rightXyz' | 'downXyz'>;

function closeTo(a: Coordinate, b: Coordinate): boolean {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z) < 1e-4;
}

export function isAxisAligned(plane: PlaneAxes): boolean {
  const axes = CANONICAL_AXES[orientationFromNormal(plane.normalXyz)];
  return closeTo(plane.rightXyz, axes.right) && closeTo(plane.downXyz, axes.down);
}

// The sampled image depends only on the plane's axes and its offset along the normal from the volume centre.
export interface PlaneParams extends PlaneAxes {
  offsetMm: number;
}

export function planeParams(volume: Volume, plane: ViewablePlane): PlaneParams {
  const centre = volumeCentre(volume);
  const p = plane.positionXyz;
  return {
    offsetMm: dot({ x: p.x - centre.x, y: p.y - centre.y, z: p.z - centre.z }, plane.normalXyz),
    normalXyz: plane.normalXyz,
    rightXyz: plane.rightXyz,
    downXyz: plane.downXyz,
  };
}

export function planeFromParams(volume: Volume, params: PlaneParams): ViewablePlane {
  const centre = volumeCentre(volume);
  const n = params.normalXyz;
  return {
    positionXyz: {
      x: centre.x + n.x * params.offsetMm,
      y: centre.y + n.y * params.offsetMm,
      z: centre.z + n.z * params.offsetMm,
    },
    normalXyz: n,
    rightXyz: params.rightXyz,
    downXyz: params.downXyz,
  };
}

interface PlaneGrid {
  widthPixels: number;
  heightPixels: number;
}

// Square output pixels because CanvasRenderer scales both axes by the same factor.
function outputSpacing(volume: Volume): number {
  return Math.min(volume.slices[0].pixelSpacingXMm, volume.slices[0].pixelSpacingYMm);
}

function planeGrid(volume: Volume, orientation: PlaneOrientation, spacing: number): PlaneGrid {
  const bounds = getVolumeBounds(volume);
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
  outSpacing: number,
  visit: (index: number, value: number) => void
): void {
  const slices = volume.slices;
  const { widthPixels: width, heightPixels: height, pixelSpacingXMm: sx, pixelSpacingYMm: sy } = slices[0];
  const bounds = getVolumeBounds(volume);
  const depths = slices.map((s) => s.depthPositionMm);
  const orientation = orientationFromNormal(viewablePlane.normalXyz);
  const position = viewablePlane.positionXyz;
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

interface ObliqueGrid extends PlaneGrid {
  uMin: number;
  vMin: number;
}

// Corner index bits: 1 = x, 2 = y, 4 = z (set bit means the max side).
export function volumeCorners(volume: Volume): Coordinate[] {
  const { min, max } = getVolumeBounds(volume);
  return Array.from({ length: 8 }, (_, i) => ({
    x: i & 1 ? max.x : min.x,
    y: i & 2 ? max.y : min.y,
    z: i & 4 ? max.z : min.z,
  }));
}

// Bounding rectangle of the volume's corners on the plane's axes, measured from the volume centre.
function projectedExtent(volume: Volume, plane: PlaneAxes): { uMin: number; uMax: number; vMin: number; vMax: number } {
  const centre = volumeCentre(volume);
  let uMin = Infinity;
  let uMax = -Infinity;
  let vMin = Infinity;
  let vMax = -Infinity;
  for (const corner of volumeCorners(volume)) {
    const relative = { x: corner.x - centre.x, y: corner.y - centre.y, z: corner.z - centre.z };
    const u = dot(relative, plane.rightXyz);
    const v = dot(relative, plane.downXyz);
    uMin = Math.min(uMin, u);
    uMax = Math.max(uMax, u);
    vMin = Math.min(vMin, v);
    vMax = Math.max(vMax, v);
  }
  return { uMin, uMax, vMin, vMax };
}

function obliqueGrid(volume: Volume, plane: PlaneAxes, spacing: number): ObliqueGrid {
  const { uMin, uMax, vMin, vMax } = projectedExtent(volume, plane);
  return {
    widthPixels: Math.floor((uMax - uMin) / spacing) + 1,
    heightPixels: Math.floor((vMax - vMin) / spacing) + 1,
    uMin,
    vMin,
  };
}

export function planeImageGeometry(volume: Volume, plane: PlaneAxes, spacingMm: number): ImageGeometry {
  const { uMin, vMin } = projectedExtent(volume, plane);
  return { uMinMm: uMin, vMinMm: vMin, spacingMm };
}

// Thickness of a slab centred on the volume that contains every voxel along the given normal.
export function fullVolumeThicknessMm(volume: Volume, normal: Coordinate): number {
  const centre = volumeCentre(volume);
  let halfExtent = 0;
  for (const corner of volumeCorners(volume)) {
    const relative = { x: corner.x - centre.x, y: corner.y - centre.y, z: corner.z - centre.z };
    halfExtent = Math.max(halfExtent, Math.abs(dot(relative, normal)));
  }
  return halfExtent * 2;
}

// Spacing multiplier that keeps the longest side of the plane's image under maxPixels.
export function fitSpacingScale(volume: Volume, plane: PlaneAxes, maxPixels: number): number {
  const { uMin, uMax, vMin, vMax } = projectedExtent(volume, plane);
  const extentMm = Math.max(uMax - uMin, vMax - vMin);
  return Math.max(1, extentMm / (maxPixels * outputSpacing(volume)));
}

// NaN outside the volume.
function sampleTrilinear(slices: Slice[], width: number, height: number, fx: number, fy: number, fz: number): number {
  const lastSlice = slices.length - 1;
  if (
    !(fx >= -EPSILON && fx <= width - 1 + EPSILON && fy >= -EPSILON && fy <= height - 1 + EPSILON) ||
    !(fz >= -EPSILON && fz <= lastSlice + EPSILON)
  ) {
    return NaN;
  }

  const x0 = Math.min(width - 1, Math.max(0, Math.floor(fx)));
  const y0 = Math.min(height - 1, Math.max(0, Math.floor(fy)));
  const z0 = Math.min(lastSlice, Math.max(0, Math.floor(fz)));
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const tx = Math.min(1, Math.max(0, fx - x0));
  const ty = Math.min(1, Math.max(0, fy - y0));
  const tz = Math.min(1, Math.max(0, fz - z0));
  const b0 = y0 * width;
  const b1 = y1 * width;

  const near = bilinear(slices[z0].radiodensities, b0, b1, x0, x1, tx, ty);
  if (tz === 0 || z0 === lastSlice) return near;
  return near * (1 - tz) + bilinear(slices[z0 + 1].radiodensities, b0, b1, x0, x1, tx, ty) * tz;
}

// General path for rotated planes: each pixel is mapped to a 3D point and interpolated.
function sampleObliquePlane(
  volume: Volume,
  plane: ViewablePlane,
  grid: ObliqueGrid,
  spacing: number,
  visit: (index: number, value: number) => void
): void {
  const slices = volume.slices;
  const { widthPixels: width, heightPixels: height, pixelSpacingXMm: sx, pixelSpacingYMm: sy } = slices[0];
  const originX = slices[0].originXMm;
  const originY = slices[0].originYMm;
  const depths = slices.map((s) => s.depthPositionMm);
  const lastSlice = depths.length - 1;
  const depthStep = lastSlice > 0 ? (depths[lastSlice] - depths[0]) / lastSlice : 0;
  const uniformDepths =
    depthStep > 0 && depths.every((depth, i) => Math.abs(depth - (depths[0] + i * depthStep)) <= 1e-3 * depthStep);

  const centre = volumeCentre(volume);
  const n = plane.normalXyz;
  const r = plane.rightXyz;
  const d = plane.downXyz;
  const p = plane.positionXyz;
  const offset = dot({ x: p.x - centre.x, y: p.y - centre.y, z: p.z - centre.z }, n);

  // Patient-space point of output pixel (0, 0).
  const startX = centre.x + n.x * offset + r.x * grid.uMin + d.x * grid.vMin;
  const startY = centre.y + n.y * offset + r.y * grid.uMin + d.y * grid.vMin;
  const startZ = centre.z + n.z * offset + r.z * grid.uMin + d.z * grid.vMin;

  for (let row = 0; row < grid.heightPixels; row++) {
    let px = startX + d.x * spacing * row;
    let py = startY + d.y * spacing * row;
    let pz = startZ + d.z * spacing * row;
    for (let col = 0; col < grid.widthPixels; col++) {
      const fz = uniformDepths ? (pz - depths[0]) / depthStep : depthToSliceCoordinate(depths, pz);
      visit(row * grid.widthPixels + col, sampleTrilinear(slices, width, height, (px - originX) / sx, (py - originY) / sy, fz));
      px += r.x * spacing;
      py += r.y * spacing;
      pz += r.z * spacing;
    }
  }
}

interface PlaneSampling {
  grid: PlaneGrid;
  spacing: number;
  run: (plane: ViewablePlane, visit: (index: number, value: number) => void) => void;
}

// The grid is fixed for a given rotation, so slab sub-planes (shifted along the normal) reuse it.
function createPlaneSampling(volume: Volume, plane: ViewablePlane, spacingScale: number): PlaneSampling {
  const spacing = outputSpacing(volume) * spacingScale;
  if (isAxisAligned(plane)) {
    const grid = planeGrid(volume, orientationFromNormal(plane.normalXyz), spacing);
    return { grid, spacing, run: (p, visit) => samplePlane(volume, p, grid, spacing, visit) };
  }
  const grid = obliqueGrid(volume, plane, spacing);
  return {
    grid: { widthPixels: grid.widthPixels, heightPixels: grid.heightPixels },
    spacing,
    run: (p, visit) => sampleObliquePlane(volume, p, grid, spacing, visit),
  };
}

export function sampleCrossSection(volume: Volume, viewablePlane: ViewablePlane, spacingScale = 1): RadioDensities | undefined {
  const slices = volume.slices;
  if (slices.length === 0) return undefined;

  if (isAxisAligned(viewablePlane) && orientationFromNormal(viewablePlane.normalXyz) === 'axial') {
    const fz = depthToSliceCoordinate(slices.map((s) => s.depthPositionMm), viewablePlane.positionXyz.z);
    if (Number.isNaN(fz)) return undefined;
    const { pixelSpacingXMm: sx, pixelSpacingYMm: sy } = slices[0];
    if (spacingScale === 1 && sx === sy && Math.abs(fz - Math.round(fz)) < EPSILON) {
      const slice = slices[Math.round(fz)];
      return {
        widthPixels: slice.widthPixels,
        heightPixels: slice.heightPixels,
        radiodensities: slice.radiodensities,
        geometry: planeImageGeometry(volume, viewablePlane, sx),
      };
    }
  }

  const { grid, spacing, run } = createPlaneSampling(volume, viewablePlane, spacingScale);
  const out = new Float32Array(grid.widthPixels * grid.heightPixels);
  run(viewablePlane, (i, value) => {
    out[i] = Number.isNaN(value) ? OUTSIDE_VOLUME_VALUE : value;
  });
  return { ...grid, radiodensities: out, geometry: planeImageGeometry(volume, viewablePlane, spacing) };
}

// Axial slabs on square voxels need no interpolation: combine the stored slices directly.
// Each slice counts by how much of its depth interval lies inside the slab, so the image changes continuously
// as the slab slides instead of jumping when a slice enters or leaves. step > 1 decimates pixels for cheap previews.
function sampleAxialSlabFromSlices(
  slices: Slice[],
  centreZ: number,
  slab: SlabOptions,
  step: number,
  geometry: ImageGeometry
): RadioDensities | undefined {
  const slabMin = centreZ - slab.thicknessMm / 2;
  const slabMax = centreZ + slab.thicknessMm / 2;
  const depths = slices.map((s) => s.depthPositionMm);
  const last = depths.length - 1;

  const weights = depths.map((depth, i) => {
    const below = i > 0 ? (depth - depths[i - 1]) / 2 : last > 0 ? (depths[1] - depth) / 2 : 0.5;
    const above = i < last ? (depths[i + 1] - depth) / 2 : last > 0 ? (depth - depths[i - 1]) / 2 : 0.5;
    const overlap = Math.min(depth + above, slabMax) - Math.max(depth - below, slabMin);
    const weight = Math.min(1, Math.max(0, overlap / (below + above)));
    return weight < 1e-3 ? 0 : weight > 1 - 1e-3 ? 1 : weight;
  });
  if (weights.every((w) => w === 0)) return undefined;

  const { widthPixels, heightPixels } = slices[0];
  const outWidth = Math.ceil(widthPixels / step);
  const outHeight = Math.ceil(heightPixels / step);
  const accumulated = new Float32Array(outWidth * outHeight);

  // Max/min start from a fully covered slice (or the best covered one) so a partly covered edge slice
  // can only pull the result part of the way towards its own value.
  const baseIndex = weights.includes(1) ? weights.indexOf(1) : weights.indexOf(Math.max(...weights));
  const fold = (data: Int16Array, weight: number, mode: ProjectionMode) => {
    for (let y = 0, o = 0; y < outHeight; y++) {
      const rowStart = y * step * widthPixels;
      for (let x = 0; x < outWidth; x++, o++) {
        const value = data[rowStart + x * step];
        const current = accumulated[o];
        if (mode === 'average') accumulated[o] = current + value * weight;
        else if (mode === 'max' ? value > current : value < current) accumulated[o] = current + weight * (value - current);
      }
    }
  };

  if (slab.mode !== 'average') {
    for (let y = 0, o = 0; y < outHeight; y++) {
      for (let x = 0; x < outWidth; x++, o++) accumulated[o] = slices[baseIndex].radiodensities[y * step * widthPixels + x * step];
    }
  }
  let totalWeight = 0;
  for (let i = 0; i < slices.length; i++) {
    if (weights[i] === 0 || (slab.mode !== 'average' && i === baseIndex)) continue;
    fold(slices[i].radiodensities, weights[i], slab.mode);
    totalWeight += weights[i];
  }
  if (slab.mode === 'average') {
    for (let o = 0; o < accumulated.length; o++) accumulated[o] /= totalWeight;
  }

  return { widthPixels: outWidth, heightPixels: outHeight, radiodensities: accumulated, geometry };
}

// Projects a slab centred on the plane; samples outside the volume are ignored.
export function sampleSlab(volume: Volume, viewablePlane: ViewablePlane, slab: SlabOptions): RadioDensities | undefined {
  if (volume.slices.length === 0) return undefined;

  const maxSamples = slab.maxSamples ?? MAX_SLAB_SAMPLES;
  const spacingScale = slab.spacingScale ?? 1;
  const orientation = orientationFromNormal(viewablePlane.normalXyz);
  const aligned = isAxisAligned(viewablePlane);
  const sampleCount = slabSampleCount(volume, orientation, slab.thicknessMm, maxSamples);
  if (sampleCount <= 1) return sampleCrossSection(volume, viewablePlane, spacingScale);

  const { pixelSpacingXMm: sx, pixelSpacingYMm: sy } = volume.slices[0];
  if (aligned && orientation === 'axial' && sx === sy && Number.isInteger(spacingScale)) {
    const direct = sampleAxialSlabFromSlices(
      volume.slices,
      viewablePlane.positionXyz.z,
      slab,
      spacingScale,
      planeImageGeometry(volume, viewablePlane, sx * spacingScale)
    );
    if (direct) return direct;
  }

  const { grid, spacing, run } = createPlaneSampling(volume, viewablePlane, spacingScale);
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
    run(shifted, visit);
  }

  const out = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    if (counts[i] === 0) out[i] = OUTSIDE_VOLUME_VALUE;
    else out[i] = slab.mode === 'average' ? accumulated[i] / counts[i] : accumulated[i];
  }
  return { ...grid, radiodensities: out, geometry: planeImageGeometry(volume, viewablePlane, spacing) };
}
