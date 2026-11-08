import type { Slice, Volume } from '../api/types';
import type { Coordinate } from './canvasMath';

export type AcquisitionPlane = 'axial' | 'coronal' | 'sagittal' | 'oblique';

export interface Box {
  min: Coordinate;
  max: Coordinate;
}

// A volume's own frame. Local coordinates are (x, y, z) = millimetres along (right, down, normal) from origin,
// so every volume is an axial-style stack in its own frame: slice k lies at local z = depths[k], and its voxel (i, j)
// at local (i * spacingX + shear.x * z, j * spacingY + shear.y * z). Shear is non-zero only for stacks that are
// not perpendicular to their slices (gantry tilt).
export interface VolumeGeometry {
  right: Coordinate;
  down: Coordinate;
  normal: Coordinate;
  // Patient position of the first voxel of the first slice.
  origin: Coordinate;
  depths: number[];
  // Spacing of evenly spaced slices; 0 when uneven.
  depthStep: number;
  spacingX: number;
  spacingY: number;
  widthPixels: number;
  heightPixels: number;
  shear: { x: number; y: number };
  sheared: boolean;
  // Corner voxel centres; index bit 1 = last column, 2 = last row, 4 = last slice.
  localCorners: Coordinate[];
  localBounds: Box;
  localCentre: Coordinate;
  corners: Coordinate[];
  // Axis-aligned patient-space box around the corners.
  bounds: Box;
  centre: Coordinate;
}

const IDENTITY_ROW: Coordinate = { x: 1, y: 0, z: 0 };
const IDENTITY_COLUMN: Coordinate = { x: 0, y: 1, z: 0 };
// Offsets smaller than this fraction of a pixel across the whole stack are treated as no shear.
const SHEAR_TOLERANCE_PIXELS = 0.01;
const NAMED_PLANE_COSINE = Math.cos((10 * Math.PI) / 180);

function dot(a: Coordinate, b: Coordinate): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function subtract(a: Coordinate, b: Coordinate): Coordinate {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function scaled(a: Coordinate, s: number): Coordinate {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

function normalized(a: Coordinate): Coordinate {
  const length = Math.hypot(a.x, a.y, a.z);
  return length > 0 ? scaled(a, 1 / length) : a;
}

function cross(a: Coordinate, b: Coordinate): Coordinate {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

function vector(values: [number, number, number] | undefined, fallback: Coordinate): Coordinate {
  return values ? { x: values[0], y: values[1], z: values[2] } : fallback;
}

export function slicePosition(slice: Slice): Coordinate {
  return slice.positionXMm === undefined
    ? { x: slice.originXMm, y: slice.originYMm, z: slice.depthPositionMm }
    : { x: slice.positionXMm, y: slice.positionYMm ?? 0, z: slice.positionZMm ?? 0 };
}

function boxAround(points: Coordinate[]): Box {
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const p of points) {
    for (const axis of ['x', 'y', 'z'] as const) {
      min[axis] = Math.min(min[axis], p[axis]);
      max[axis] = Math.max(max[axis], p[axis]);
    }
  }
  return { min, max };
}

function mean(points: Coordinate[]): Coordinate {
  const sum = points.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y, z: acc.z + p.z }), { x: 0, y: 0, z: 0 });
  return scaled(sum, 1 / points.length);
}

// Volumes are immutable once loaded, and the frame is needed for every plane and ray.
const cache = new WeakMap<Volume, VolumeGeometry>();

// Assumes slices are ordered along the normal, as the server stores them.
export function volumeGeometry(volume: Volume): VolumeGeometry {
  const cached = cache.get(volume);
  if (cached) return cached;

  const first = volume.slices[0];
  const right = normalized(vector(volume.rowDirection, IDENTITY_ROW));
  const columns = vector(volume.columnDirection, IDENTITY_COLUMN);
  const down = normalized(subtract(columns, scaled(right, dot(columns, right))));
  const normal = cross(right, down);
  const origin = slicePosition(first);
  const offsets = volume.slices.map((s) => subtract(slicePosition(s), origin));
  const depths = offsets.map((o) => dot(normal, o));

  const last = depths.length - 1;
  const extent = depths[last];
  const step = last > 0 ? extent / last : 0;
  const depthStep = step > 0 && depths.every((d, i) => Math.abs(d - i * step) <= 1e-3 * step) ? step : 0;

  const spacingX = first.pixelSpacingXMm;
  const spacingY = first.pixelSpacingYMm;
  const lastOffset = offsets[last];
  const shiftX = dot(right, lastOffset);
  const shiftY = dot(down, lastOffset);
  const sheared =
    extent > 0 &&
    (Math.abs(shiftX) > SHEAR_TOLERANCE_PIXELS * spacingX || Math.abs(shiftY) > SHEAR_TOLERANCE_PIXELS * spacingY);
  const shear = sheared ? { x: shiftX / extent, y: shiftY / extent } : { x: 0, y: 0 };

  const maxX = (first.widthPixels - 1) * spacingX;
  const maxY = (first.heightPixels - 1) * spacingY;
  const localCorners = Array.from({ length: 8 }, (_, i) => {
    const z = i & 4 ? extent : 0;
    return { x: (i & 1 ? maxX : 0) + shear.x * z, y: (i & 2 ? maxY : 0) + shear.y * z, z };
  });

  const toPatient = (l: Coordinate): Coordinate => ({
    x: origin.x + right.x * l.x + down.x * l.y + normal.x * l.z,
    y: origin.y + right.y * l.x + down.y * l.y + normal.y * l.z,
    z: origin.z + right.z * l.x + down.z * l.y + normal.z * l.z,
  });
  const corners = localCorners.map(toPatient);

  const geometry: VolumeGeometry = {
    right,
    down,
    normal,
    origin,
    depths,
    depthStep,
    spacingX,
    spacingY,
    widthPixels: first.widthPixels,
    heightPixels: first.heightPixels,
    shear,
    sheared,
    localCorners,
    localBounds: boxAround(localCorners),
    localCentre: mean(localCorners),
    corners,
    bounds: boxAround(corners),
    centre: mean(corners),
  };
  cache.set(volume, geometry);
  return geometry;
}

export function toLocalPoint(g: VolumeGeometry, p: Coordinate): Coordinate {
  const relative = subtract(p, g.origin);
  return { x: dot(g.right, relative), y: dot(g.down, relative), z: dot(g.normal, relative) };
}

export function toLocalDirection(g: VolumeGeometry, v: Coordinate): Coordinate {
  return { x: dot(g.right, v), y: dot(g.down, v), z: dot(g.normal, v) };
}

export function toPatientPoint(g: VolumeGeometry, l: Coordinate): Coordinate {
  return {
    x: g.origin.x + g.right.x * l.x + g.down.x * l.y + g.normal.x * l.z,
    y: g.origin.y + g.right.y * l.x + g.down.y * l.y + g.normal.y * l.z,
    z: g.origin.z + g.right.z * l.x + g.down.z * l.y + g.normal.z * l.z,
  };
}

// Patient position of the voxel (fractional indices allowed); k indexes slices, interpolating between depths.
export function voxelToPatient(g: VolumeGeometry, i: number, j: number, depth: number): Coordinate {
  return toPatientPoint(g, { x: i * g.spacingX + g.shear.x * depth, y: j * g.spacingY + g.shear.y * depth, z: depth });
}

// The nearest point inside the volume, measured in the volume's own frame.
export function clampToVolume(volume: Volume, p: Coordinate): Coordinate {
  const g = volumeGeometry(volume);
  const l = toLocalPoint(g, p);
  const { min, max } = g.localBounds;
  return toPatientPoint(g, {
    x: Math.min(max.x, Math.max(min.x, l.x)),
    y: Math.min(max.y, Math.max(min.y, l.y)),
    z: Math.min(max.z, Math.max(min.z, l.z)),
  });
}

export function acquisitionPlane(volume: Volume): AcquisitionPlane {
  const n = volumeGeometry(volume).normal;
  const ax = Math.abs(n.x);
  const ay = Math.abs(n.y);
  const az = Math.abs(n.z);
  const largest = Math.max(ax, ay, az);
  if (largest < NAMED_PLANE_COSINE) return 'oblique';
  if (largest === az) return 'axial';
  return largest === ay ? 'coronal' : 'sagittal';
}

// Fractional slice index for a local depth, or NaN outside the stack.
export function depthToSliceIndex(depths: number[], depth: number, epsilon = 1e-6): number {
  const last = depths.length - 1;
  if (depth < depths[0] - epsilon || depth > depths[last] + epsilon) return NaN;
  if (last === 0) return 0;
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (depths[mid] <= depth) lo = mid;
    else hi = mid;
  }
  const span = depths[hi] - depths[lo];
  const t = span > 0 ? (depth - depths[lo]) / span : 0;
  return Math.min(last, Math.max(0, lo + t));
}

// Trilinear value at a patient-space point; NaN outside the volume.
export function sampleVolumeAt(volume: Volume, p: Coordinate): number {
  const g = volumeGeometry(volume);
  const l = toLocalPoint(g, p);
  const fk = depthToSliceIndex(g.depths, l.z, 1e-3);
  const fi = (l.x - g.shear.x * l.z) / g.spacingX;
  const fj = (l.y - g.shear.y * l.z) / g.spacingY;
  const lastX = g.widthPixels - 1;
  const lastY = g.heightPixels - 1;
  if (Number.isNaN(fk) || fi < -1e-3 || fj < -1e-3 || fi > lastX + 1e-3 || fj > lastY + 1e-3) return NaN;

  const x = Math.min(lastX, Math.max(0, fi));
  const y = Math.min(lastY, Math.max(0, fj));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const k0 = Math.floor(fk);
  const x1 = Math.min(lastX, x0 + 1);
  const y1 = Math.min(lastY, y0 + 1);
  const k1 = Math.min(g.depths.length - 1, k0 + 1);
  const tx = x - x0;
  const ty = y - y0;
  const tz = fk - k0;
  const width = g.widthPixels;
  const bilinear = (data: Int16Array) => {
    const top = data[y0 * width + x0] + (data[y0 * width + x1] - data[y0 * width + x0]) * tx;
    const bottom = data[y1 * width + x0] + (data[y1 * width + x1] - data[y1 * width + x0]) * tx;
    return top + (bottom - top) * ty;
  };
  const a = bilinear(volume.slices[k0].radiodensities);
  return tz > 0 ? a + (bilinear(volume.slices[k1].radiodensities) - a) * tz : a;
}
