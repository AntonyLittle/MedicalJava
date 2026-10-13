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

interface VolumeInfo {
  depths: number[];
  data: Int16Array[];
  // 0 when the slices are not evenly spaced.
  depthStep: number;
  bounds: { min: Coordinate; max: Coordinate };
}

// Volumes are immutable once loaded, and these values are needed for every sample of every frame.
const volumeInfoCache = new WeakMap<Volume, VolumeInfo>();

function volumeInfo(volume: Volume): VolumeInfo {
  let info = volumeInfoCache.get(volume);
  if (!info) {
    const first = volume.slices[0];
    const depths = volume.slices.map((s) => s.depthPositionMm);
    const last = depths.length - 1;
    const step = last > 0 ? (depths[last] - depths[0]) / last : 0;
    const uniform = step > 0 && depths.every((depth, i) => Math.abs(depth - (depths[0] + i * step)) <= 1e-3 * step);
    info = {
      depths,
      data: volume.slices.map((s) => s.radiodensities),
      depthStep: uniform ? step : 0,
      bounds: {
        min: { x: first.originXMm, y: first.originYMm, z: Math.min(...depths) },
        max: {
          x: first.originXMm + (first.widthPixels - 1) * first.pixelSpacingXMm,
          y: first.originYMm + (first.heightPixels - 1) * first.pixelSpacingYMm,
          z: Math.max(...depths),
        },
      },
    };
    volumeInfoCache.set(volume, info);
  }
  return info;
}

// Extent of the voxel centres in patient coordinates (mm); assumes slices are sorted by depth and share an x/y origin.
export function getVolumeBounds(volume: Volume): { min: Coordinate; max: Coordinate } {
  return volumeInfo(volume).bounds;
}

// Receives the values for columns colStart..colEnd of one output row; other columns are outside the volume.
type RowSink = (row: number, colStart: number, colEnd: number, values: Float32Array) => void;

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

// Calls onRow for every row of the plane's grid with interpolated values (NaN outside the volume).
// Only the plane position along its dominant normal axis is used; in-plane axes are fixed per orientation.
function samplePlane(
  volume: Volume,
  viewablePlane: ViewablePlane,
  grid: PlaneGrid,
  outSpacing: number,
  rowBuf: Float32Array,
  onRow: RowSink
): void {
  const slices = volume.slices;
  const { widthPixels: width, heightPixels: height, pixelSpacingXMm: sx, pixelSpacingYMm: sy } = slices[0];
  const { depths, bounds } = volumeInfo(volume);
  const orientation = orientationFromNormal(viewablePlane.normalXyz);
  const position = viewablePlane.positionXyz;
  const { widthPixels: outWidth, heightPixels: outHeight } = grid;

  if (orientation === 'axial') {
    const zw = createWeights(1);
    setWeight(zw, 0, depthToSliceCoordinate(depths, position.z), slices.length);
    if (zw.i0[0] < 0) {
      rowBuf.fill(NaN, 0, outWidth);
      for (let row = 0; row < outHeight; row++) onRow(row, 0, outWidth - 1, rowBuf);
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
        const x0 = xw.i0[col];
        if (rowY0 < 0 || x0 < 0) {
          rowBuf[col] = NaN;
          continue;
        }
        let value = bilinear(dataA, b0, b1, x0, xw.i1[col], xw.t[col], ty);
        if (dataB) value = value * (1 - tz) + bilinear(dataB, b0, b1, x0, xw.i1[col], xw.t[col], ty) * tz;
        rowBuf[col] = value;
      }
      onRow(row, 0, outWidth - 1, rowBuf);
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
      if (!dataA || colX0[col] < 0) {
        rowBuf[col] = NaN;
        continue;
      }
      let value = bilinear(dataA, colB0[col], colB1[col], colX0[col], colX1[col], colTx[col], colTy[col]);
      if (dataB) {
        value = value * (1 - tz) + bilinear(dataB, colB0[col], colB1[col], colX0[col], colX1[col], colTx[col], colTy[col]) * tz;
      }
      rowBuf[col] = value;
    }
    onRow(row, 0, outWidth - 1, rowBuf);
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

// The caller guarantees the coordinates lie inside the volume (within EPSILON), so there is no bounds checking.
function trilinearInside(
  data: Int16Array[],
  width: number,
  lastX: number,
  lastY: number,
  lastSlice: number,
  fx: number,
  fy: number,
  fz: number
): number {
  const x0 = fx | 0;
  const y0 = fy | 0;
  const z0 = fz | 0;
  const x1 = x0 < lastX ? x0 + 1 : x0;
  const b0 = y0 * width;
  const b1 = (y0 < lastY ? y0 + 1 : y0) * width;
  const tx = fx - x0;
  const ty = fy - y0;

  const near = data[z0];
  const nearTop = near[b0 + x0] + (near[b0 + x1] - near[b0 + x0]) * tx;
  const nearBottom = near[b1 + x0] + (near[b1 + x1] - near[b1 + x0]) * tx;
  const lower = nearTop + (nearBottom - nearTop) * ty;
  if (z0 >= lastSlice) return lower;

  const far = data[z0 + 1];
  const farTop = far[b0 + x0] + (far[b0 + x1] - far[b0 + x0]) * tx;
  const farBottom = far[b1 + x0] + (far[b1 + x1] - far[b1 + x0]) * tx;
  const upper = farTop + (farBottom - farTop) * ty;
  return lower + (upper - lower) * (fz - z0);
}

// Narrows the column interval in which f0 + col * df stays inside [0, maxF] (empty when range.hi < 0).
function clipColumns(range: { lo: number; hi: number }, f0: number, df: number, maxF: number): void {
  if (Math.abs(df) < 1e-12) {
    if (f0 < -EPSILON || f0 > maxF + EPSILON) range.hi = -1;
    return;
  }
  const a = (-EPSILON - f0) / df;
  const b = (maxF + EPSILON - f0) / df;
  range.lo = Math.max(range.lo, Math.min(a, b));
  range.hi = Math.min(range.hi, Math.max(a, b));
}

// General path for rotated planes: each pixel is mapped to a 3D point and interpolated.
// Rows are clipped to the part inside the volume, so the empty corners of the grid cost nothing.
function sampleObliquePlane(
  volume: Volume,
  plane: ViewablePlane,
  grid: ObliqueGrid,
  spacing: number,
  rowBuf: Float32Array,
  onRow: RowSink
): void {
  const slices = volume.slices;
  const { widthPixels: width, heightPixels: height, pixelSpacingXMm: sx, pixelSpacingYMm: sy } = slices[0];
  const originX = slices[0].originXMm;
  const originY = slices[0].originYMm;
  const { depths, depthStep, data } = volumeInfo(volume);
  const lastSlice = depths.length - 1;
  const lastX = width - 1;
  const lastY = height - 1;

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

  // Change in voxel coordinates per output column.
  const dfx = (r.x * spacing) / sx;
  const dfy = (r.y * spacing) / sy;
  const dfz = depthStep > 0 ? (r.z * spacing) / depthStep : 0;
  const range = { lo: 0, hi: 0 };

  for (let row = 0; row < grid.heightPixels; row++) {
    const px = startX + d.x * spacing * row;
    const py = startY + d.y * spacing * row;
    const pz = startZ + d.z * spacing * row;
    const fx0 = (px - originX) / sx;
    const fy0 = (py - originY) / sy;
    const fz0 = depthStep > 0 ? (pz - depths[0]) / depthStep : 0;

    range.lo = 0;
    range.hi = grid.widthPixels - 1;
    clipColumns(range, fx0, dfx, width - 1);
    clipColumns(range, fy0, dfy, height - 1);
    if (depthStep > 0) clipColumns(range, fz0, dfz, lastSlice);
    const colStart = Math.max(0, Math.ceil(range.lo));
    const colEnd = Math.min(grid.widthPixels - 1, Math.floor(range.hi));
    if (colStart > colEnd) continue;

    if (depthStep > 0) {
      for (let col = colStart; col <= colEnd; col++) {
        rowBuf[col] = trilinearInside(data, width, lastX, lastY, lastSlice, fx0 + col * dfx, fy0 + col * dfy, fz0 + col * dfz);
      }
    } else {
      for (let col = colStart; col <= colEnd; col++) {
        const fz = depthToSliceCoordinate(depths, pz + col * r.z * spacing);
        rowBuf[col] = Number.isNaN(fz)
          ? NaN
          : trilinearInside(data, width, lastX, lastY, lastSlice, fx0 + col * dfx, fy0 + col * dfy, fz);
      }
    }
    onRow(row, colStart, colEnd, rowBuf);
  }
}

interface PlaneSampling {
  grid: PlaneGrid;
  spacing: number;
  run: (plane: ViewablePlane, onRow: RowSink) => void;
}

// The grid is fixed for a given rotation, so slab sub-planes (shifted along the normal) reuse it.
function createPlaneSampling(volume: Volume, plane: ViewablePlane, spacingScale: number): PlaneSampling {
  const spacing = outputSpacing(volume) * spacingScale;
  if (isAxisAligned(plane)) {
    const grid = planeGrid(volume, orientationFromNormal(plane.normalXyz), spacing);
    const rowBuf = new Float32Array(grid.widthPixels);
    return { grid, spacing, run: (p, onRow) => samplePlane(volume, p, grid, spacing, rowBuf, onRow) };
  }
  const grid = obliqueGrid(volume, plane, spacing);
  const rowBuf = new Float32Array(grid.widthPixels);
  return {
    grid: { widthPixels: grid.widthPixels, heightPixels: grid.heightPixels },
    spacing,
    run: (p, onRow) => sampleObliquePlane(volume, p, grid, spacing, rowBuf, onRow),
  };
}

export function sampleCrossSection(volume: Volume, viewablePlane: ViewablePlane, spacingScale = 1): RadioDensities | undefined {
  const slices = volume.slices;
  if (slices.length === 0) return undefined;

  if (isAxisAligned(viewablePlane) && orientationFromNormal(viewablePlane.normalXyz) === 'axial') {
    const fz = depthToSliceCoordinate(volumeInfo(volume).depths, viewablePlane.positionXyz.z);
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
  const out = new Float32Array(grid.widthPixels * grid.heightPixels).fill(OUTSIDE_VOLUME_VALUE);
  run(viewablePlane, (row, colStart, colEnd, values) => {
    const base = row * grid.widthPixels;
    for (let col = colStart; col <= colEnd; col++) {
      const value = values[col];
      if (!Number.isNaN(value)) out[base + col] = value;
    }
  });
  return { ...grid, radiodensities: out, geometry: planeImageGeometry(volume, viewablePlane, spacing) };
}

// A slab computation that yields between units of work so callers can spread it over several frames.
export type SlabJob = Generator<void, RadioDensities | undefined, void>;

// Fraction (0..1) of each sample's interval, centred on its position, that lies inside [slabMin, slabMax].
function coverageWeights(positions: ArrayLike<number>, slabMin: number, slabMax: number): number[] {
  const last = positions.length - 1;
  const weights: number[] = [];
  for (let i = 0; i <= last; i++) {
    const position = positions[i];
    const below = i > 0 ? (position - positions[i - 1]) / 2 : last > 0 ? (positions[1] - position) / 2 : 0.5;
    const above = i < last ? (positions[i + 1] - position) / 2 : last > 0 ? (position - positions[i - 1]) / 2 : 0.5;
    const overlap = Math.min(position + above, slabMax) - Math.max(position - below, slabMin);
    const weight = Math.min(1, Math.max(0, overlap / (below + above)));
    weights.push(weight < 1e-3 ? 0 : weight > 1 - 1e-3 ? 1 : weight);
  }
  return weights;
}

// Max/min move the result only part of the way towards a partly covered sample, so it can't jump as the slab slides.
function foldInto(accumulated: Float32Array, values: ArrayLike<number>, weight: number, mode: ProjectionMode): void {
  const size = accumulated.length;
  if (mode === 'average') {
    for (let o = 0; o < size; o++) accumulated[o] += values[o] * weight;
  } else if (mode === 'max') {
    for (let o = 0; o < size; o++) {
      const value = values[o];
      const current = accumulated[o];
      if (value > current) accumulated[o] = current + weight * (value - current);
    }
  } else {
    for (let o = 0; o < size; o++) {
      const value = values[o];
      const current = accumulated[o];
      if (value < current) accumulated[o] = current + weight * (value - current);
    }
  }
}

// Value at flat index a + offset (blended with b + offset by t), then blended between two slices by tz.
function readVoxel(
  dataA: Int16Array,
  dataB: Int16Array | null,
  tz: number,
  a: number,
  b: number,
  t: number,
  offset: number
): number {
  let value = dataA[a + offset];
  if (t > 0) value += (dataA[b + offset] - value) * t;
  if (dataB) {
    let other = dataB[a + offset];
    if (t > 0) other += (dataB[b + offset] - other) * t;
    value += (other - value) * tz;
  }
  return value;
}

// Axial slabs on square voxels need no interpolation: combine the stored slices directly.
// Each slice counts by how much of its depth interval lies inside the slab, so the image changes continuously
// as the slab slides instead of jumping when a slice enters or leaves. step > 1 decimates pixels for cheap previews.
function* sampleAxialSlabFromSlices(
  slices: Slice[],
  centreZ: number,
  slab: SlabOptions,
  step: number,
  geometry: ImageGeometry
): SlabJob {
  const weights = coverageWeights(
    slices.map((s) => s.depthPositionMm),
    centreZ - slab.thicknessMm / 2,
    centreZ + slab.thicknessMm / 2
  );
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
    yield;
  }
  if (slab.mode === 'average') {
    for (let o = 0; o < accumulated.length; o++) accumulated[o] /= totalWeight;
  }

  return { widthPixels: outWidth, heightPixels: outHeight, radiodensities: accumulated, geometry };
}

// Coronal/sagittal slabs on the voxel grid: each voxel plane inside the slab is read directly and weighted by how
// much of it the slab covers. Interpolation weights along the plane are computed once for the whole slab.
function* sampleSideSlabFromVoxelPlanes(
  volume: Volume,
  plane: ViewablePlane,
  slab: SlabOptions,
  spacingScale: number,
  orientation: 'coronal' | 'sagittal'
): SlabJob {
  const slices = volume.slices;
  const { widthPixels: width, heightPixels: height, pixelSpacingXMm: sx, pixelSpacingYMm: sy } = slices[0];
  const { depths, bounds } = volumeInfo(volume);
  const alongY = orientation === 'coronal';

  const planeCount = alongY ? height : width;
  const planeOrigin = alongY ? slices[0].originYMm : slices[0].originXMm;
  const planeSpacing = alongY ? sy : sx;
  const centreAlong = alongY ? plane.positionXyz.y : plane.positionXyz.x;
  const positions = Array.from({ length: planeCount }, (_, j) => planeOrigin + j * planeSpacing);
  const weights = coverageWeights(positions, centreAlong - slab.thicknessMm / 2, centreAlong + slab.thicknessMm / 2);
  if (weights.every((w) => w === 0)) return undefined;

  const outSpacing = outputSpacing(volume) * spacingScale;
  const grid = planeGrid(volume, orientation, outSpacing);
  const { widthPixels: outWidth, heightPixels: outHeight } = grid;
  const size = outWidth * outHeight;

  // Columns run along x for coronal and y for sagittal; a flat index is colA + the voxel plane's offset.
  const inPlane = alongY ? axisWeights(outWidth, outSpacing, sx, width) : axisWeights(outWidth, outSpacing, sy, height);
  const colStride = alongY ? 1 : width;
  const colA = new Int32Array(outWidth);
  const colB = new Int32Array(outWidth);
  const colT = new Float64Array(outWidth);
  for (let c = 0; c < outWidth; c++) {
    colA[c] = Math.max(0, inPlane.i0[c]) * colStride;
    colB[c] = Math.max(0, inPlane.i1[c]) * colStride;
    colT[c] = inPlane.t[c];
  }
  const blended = colT.some((t) => t > 0);

  // Rows are z, shared by every voxel plane. Superior (higher z) at the top of the image.
  const rowA: Int16Array[] = new Array(outHeight);
  const rowB: (Int16Array | null)[] = new Array(outHeight);
  const rowT = new Float64Array(outHeight);
  const zw = createWeights(1);
  for (let r = 0; r < outHeight; r++) {
    setWeight(zw, 0, depthToSliceCoordinate(depths, bounds.max.z - r * outSpacing), slices.length);
    const valid = zw.i0[0] >= 0;
    rowA[r] = slices[Math.max(0, zw.i0[0])].radiodensities;
    rowT[r] = valid ? zw.t[0] : 0;
    rowB[r] = valid && zw.t[0] > 0 ? slices[zw.i1[0]].radiodensities : null;
  }

  if (!alongY) {
    // Sagittal: voxel x is the contiguous direction in memory, so reduce across the slab's planes in the inner loop.
    const base = weights.includes(1) ? weights.indexOf(1) : weights.indexOf(Math.max(...weights));
    const planeIndex: number[] = [];
    const planeWeight: number[] = [];
    let total = 0;
    for (let j = 0; j < planeCount; j++) {
      if (weights[j] === 0) continue;
      total += weights[j];
      if (slab.mode !== 'average' && j === base) continue;
      planeIndex.push(j);
      planeWeight.push(weights[j]);
    }

    const result = new Float32Array(size);
    for (let r = 0; r < outHeight; r++) {
      const dataA = rowA[r];
      const dataB = rowB[r];
      const tz = rowT[r];
      for (let c = 0; c < outWidth; c++) {
        const a = colA[c];
        const b = colB[c];
        const t = colT[c];
        let value: number;
        if (slab.mode === 'average') {
          let sum = 0;
          for (let k = 0; k < planeIndex.length; k++) sum += planeWeight[k] * readVoxel(dataA, dataB, tz, a, b, t, planeIndex[k]);
          value = sum / total;
        } else {
          value = readVoxel(dataA, dataB, tz, a, b, t, base);
          for (let k = 0; k < planeIndex.length; k++) {
            const other = readVoxel(dataA, dataB, tz, a, b, t, planeIndex[k]);
            if (slab.mode === 'max' ? other > value : other < value) value += planeWeight[k] * (other - value);
          }
        }
        result[r * outWidth + c] = value;
      }
      if ((r & 7) === 7) yield;
    }
    return { ...grid, radiodensities: result, geometry: planeImageGeometry(volume, plane, outSpacing) };
  }

  const planeValues = new Float32Array(size);
  const readPlane = (j: number) => {
    const offset = alongY ? j * width : j;
    for (let r = 0; r < outHeight; r++) {
      const dataA = rowA[r];
      const dataB = rowB[r];
      const tz = rowT[r];
      const base = r * outWidth;
      for (let c = 0; c < outWidth; c++) {
        const a = colA[c] + offset;
        let value = dataA[a];
        if (blended) value += (dataA[colB[c] + offset] - value) * colT[c];
        if (dataB) {
          let other = dataB[a];
          if (blended) other += (dataB[colB[c] + offset] - other) * colT[c];
          value += (other - value) * tz;
        }
        planeValues[base + c] = value;
      }
    }
  };

  const accumulated = new Float32Array(size);
  const baseIndex = weights.includes(1) ? weights.indexOf(1) : weights.indexOf(Math.max(...weights));
  if (slab.mode !== 'average') {
    readPlane(baseIndex);
    accumulated.set(planeValues);
  }
  let totalWeight = 0;
  for (let j = 0; j < planeCount; j++) {
    if (weights[j] === 0 || (slab.mode !== 'average' && j === baseIndex)) continue;
    readPlane(j);
    foldInto(accumulated, planeValues, weights[j], slab.mode);
    totalWeight += weights[j];
    yield;
  }
  if (slab.mode === 'average') {
    for (let o = 0; o < size; o++) accumulated[o] /= totalWeight;
  }

  return { ...grid, radiodensities: accumulated, geometry: planeImageGeometry(volume, plane, outSpacing) };
}

function runToCompletion<T>(job: Generator<void, T, void>): T {
  let result = job.next();
  while (!result.done) result = job.next();
  return result.value;
}

// Projects a slab centred on the plane; samples outside the volume are ignored.
export function sampleSlab(volume: Volume, viewablePlane: ViewablePlane, slab: SlabOptions): RadioDensities | undefined {
  return runToCompletion(sampleSlabJob(volume, viewablePlane, slab));
}

export function* sampleSlabJob(volume: Volume, viewablePlane: ViewablePlane, slab: SlabOptions): SlabJob {
  if (volume.slices.length === 0) return undefined;

  const maxSamples = slab.maxSamples ?? MAX_SLAB_SAMPLES;
  const spacingScale = slab.spacingScale ?? 1;
  const orientation = orientationFromNormal(viewablePlane.normalXyz);
  const aligned = isAxisAligned(viewablePlane);
  const sampleCount = slabSampleCount(volume, orientation, slab.thicknessMm, maxSamples);
  if (sampleCount <= 1) return sampleCrossSection(volume, viewablePlane, spacingScale);

  const { pixelSpacingXMm: sx, pixelSpacingYMm: sy } = volume.slices[0];
  if (aligned && orientation === 'axial' && sx === sy && Number.isInteger(spacingScale)) {
    const direct = yield* sampleAxialSlabFromSlices(
      volume.slices,
      viewablePlane.positionXyz.z,
      slab,
      spacingScale,
      planeImageGeometry(volume, viewablePlane, sx * spacingScale)
    );
    if (direct) return direct;
  }
  if (aligned && orientation !== 'axial') {
    const direct = yield* sampleSideSlabFromVoxelPlanes(volume, viewablePlane, slab, spacingScale, orientation);
    if (direct) return direct;
  }

  const { grid, spacing, run } = createPlaneSampling(volume, viewablePlane, spacingScale);
  const size = grid.widthPixels * grid.heightPixels;
  const initial = slab.mode === 'max' ? -Infinity : slab.mode === 'min' ? Infinity : 0;
  const accumulated = new Float64Array(size).fill(initial);
  const counts = new Uint16Array(size);
  const width = grid.widthPixels;

  const sink: RowSink =
    slab.mode === 'max'
      ? (row, colStart, colEnd, values) => {
          for (let col = colStart; col <= colEnd; col++) {
            const value = values[col];
            if (Number.isNaN(value)) continue;
            const i = row * width + col;
            counts[i]++;
            if (value > accumulated[i]) accumulated[i] = value;
          }
        }
      : slab.mode === 'min'
        ? (row, colStart, colEnd, values) => {
            for (let col = colStart; col <= colEnd; col++) {
              const value = values[col];
              if (Number.isNaN(value)) continue;
              const i = row * width + col;
              counts[i]++;
              if (value < accumulated[i]) accumulated[i] = value;
            }
          }
        : (row, colStart, colEnd, values) => {
            for (let col = colStart; col <= colEnd; col++) {
              const value = values[col];
              if (Number.isNaN(value)) continue;
              const i = row * width + col;
              counts[i]++;
              accumulated[i] += value;
            }
          };

  const step = slab.thicknessMm / (sampleCount - 1);
  for (let k = 0; k < sampleCount; k++) {
    run(moveViewablePlaneForward(viewablePlane, -slab.thicknessMm / 2 + k * step), sink);
    yield;
  }

  const out = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    if (counts[i] === 0) out[i] = OUTSIDE_VOLUME_VALUE;
    else out[i] = slab.mode === 'average' ? accumulated[i] / counts[i] : accumulated[i];
  }
  return { ...grid, radiodensities: out, geometry: planeImageGeometry(volume, viewablePlane, spacing) };
}
