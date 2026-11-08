import type { Volume } from '../api/types';
import type { Coordinate, ViewablePlane } from '../utils/canvasMath';
import { planeParams, volumeCentre } from '../utils/mprSampler';
import { slicePosition, toLocalDirection, toLocalPoint, volumeGeometry, type VolumeGeometry } from '../utils/volumeGeometry';

// Nearest-voxel lookups for labels, which must never be interpolated. Works in the volume's own frame (see
// volumeGeometry): slice k lies at local depth depths[k], voxel (i, j) of it at (i·sx + shear.x·depth, j·sy +
// shear.y·depth). A point belongs to the nearest slice if it is within that slice's half thickness.

export interface VoxelSpace {
  geometry: VolumeGeometry;
  width: number;
  height: number;
  depth: number;
  depths: number[];
  // Half the thickness each slice stands for: half the distance to each neighbour (half a pixel for one slice).
  halfThickness: Float64Array;
  // Mean distance between slices (the smaller pixel spacing for a single slice).
  sliceSpacing: number;
  // How far beyond the first and last slice a point still belongs to them.
  endReach: [number, number];
}

const cache = new WeakMap<Volume, VoxelSpace>();

export function voxelSpace(volume: Volume): VoxelSpace {
  const cached = cache.get(volume);
  if (cached) return cached;
  const geometry = volumeGeometry(volume);
  const { depths } = geometry;
  const n = depths.length;
  const fallback = Math.min(geometry.spacingX, geometry.spacingY);
  const halfThickness = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const below = k > 0 ? depths[k] - depths[k - 1] : NaN;
    const above = k < n - 1 ? depths[k + 1] - depths[k] : NaN;
    const thickness =
      n === 1 ? fallback : ((Number.isNaN(below) ? above : below) + (Number.isNaN(above) ? below : above)) / 2;
    halfThickness[k] = thickness / 2 + 1e-4;
  }
  const space: VoxelSpace = {
    geometry,
    width: geometry.widthPixels,
    height: geometry.heightPixels,
    depth: n,
    depths,
    halfThickness,
    sliceSpacing: n > 1 ? (depths[n - 1] - depths[0]) / (n - 1) : fallback,
    endReach: [halfThickness[0], halfThickness[n - 1]],
  };
  cache.set(volume, space);
  return space;
}

// Whether every slice has the same size, as labelmaps require.
export function hasUniformSlices(volume: Volume): boolean {
  const first = volume.slices[0];
  return !!first && volume.slices.every((s) => s.widthPixels === first.widthPixels && s.heightPixels === first.heightPixels);
}

// Index of the slice nearest to a local depth, or -1 when the depth lies outside every slice's thickness.
export function nearestSlice(space: VoxelSpace, depth: number): number {
  const { depths } = space;
  const last = depths.length - 1;
  let k: number;
  if (space.geometry.depthStep > 0) {
    k = Math.round((depth - depths[0]) / space.geometry.depthStep);
    k = Math.min(last, Math.max(0, k));
  } else {
    let lo = 0;
    let hi = last;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (depths[mid] <= depth) lo = mid;
      else hi = mid;
    }
    k = Math.abs(depth - depths[lo]) <= Math.abs(depth - depths[hi]) ? lo : hi;
  }
  // Every depth between the end slices belongs to its nearest slice; beyond them, only within half a gap.
  if (depth < depths[0] - space.endReach[0] || depth > depths[last] + space.endReach[1]) return -1;
  return k;
}

export interface VoxelIndex {
  i: number;
  j: number;
  k: number;
}

// The voxel nearest a patient-space point, or null outside the volume.
export function voxelAt(space: VoxelSpace, p: Coordinate): VoxelIndex | null {
  const g = space.geometry;
  const l = toLocalPoint(g, p);
  const k = nearestSlice(space, l.z);
  if (k < 0) return null;
  const depth = space.depths[k];
  // | 0 turns -0 into 0.
  const i = Math.round((l.x - g.shear.x * depth) / g.spacingX) | 0;
  const j = Math.round((l.y - g.shear.y * depth) / g.spacingY) | 0;
  if (i < 0 || j < 0 || i >= space.width || j >= space.height) return null;
  return { i, j, k };
}

// Local-frame centre of a voxel.
export function voxelCentreLocal(space: VoxelSpace, i: number, j: number, k: number): Coordinate {
  const g = space.geometry;
  const depth = space.depths[k];
  return { x: i * g.spacingX + g.shear.x * depth, y: j * g.spacingY + g.shear.y * depth, z: depth };
}

// How a displayed 2D image sits in patient space: pixel (column, row)'s centre is origin + column·columnStep +
// row·rowStep. normal is the image's unit normal.
export interface ImageMapping {
  widthPixels: number;
  heightPixels: number;
  origin: Coordinate;
  columnStep: Coordinate;
  rowStep: Coordinate;
  normal: Coordinate;
}

function along(base: Coordinate, direction: Coordinate, distance: number): Coordinate {
  return { x: base.x + direction.x * distance, y: base.y + direction.y * distance, z: base.z + direction.z * distance };
}

function scaled(v: Coordinate, s: number): Coordinate {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

// The mapping of an MPR image laid out by mprSampler.imageLayout (or planMprSampling) for the plane.
export function mprImageMapping(
  volume: Volume,
  plane: ViewablePlane,
  image: { widthPixels: number; heightPixels: number; geometry: { uMinMm: number; vMinMm: number; spacingUMm: number; spacingVMm: number } }
): ImageMapping {
  const { offsetMm } = planeParams(volume, plane);
  const centre = along(volumeCentre(volume), plane.normalXyz, offsetMm);
  const { geometry } = image;
  return {
    widthPixels: image.widthPixels,
    heightPixels: image.heightPixels,
    origin: along(along(centre, plane.rightXyz, geometry.uMinMm), plane.downXyz, geometry.vMinMm),
    columnStep: scaled(plane.rightXyz, geometry.spacingUMm),
    rowStep: scaled(plane.downXyz, geometry.spacingVMm),
    normal: plane.normalXyz,
  };
}

// The mapping of an acquired slice shown at its own pixel grid.
export function sliceImageMapping(volume: Volume, sliceIndex: number): ImageMapping {
  const g = volumeGeometry(volume);
  const slice = volume.slices[sliceIndex];
  return {
    widthPixels: slice.widthPixels,
    heightPixels: slice.heightPixels,
    origin: slicePosition(slice),
    columnStep: scaled(g.right, slice.pixelSpacingXMm),
    rowStep: scaled(g.down, slice.pixelSpacingYMm),
    normal: g.normal,
  };
}

export function imagePointToPatient(mapping: ImageMapping, column: number, row: number): Coordinate {
  const { origin, columnStep: c, rowStep: r } = mapping;
  return {
    x: origin.x + c.x * column + r.x * row,
    y: origin.y + c.y * column + r.y * row,
    z: origin.z + c.z * column + r.z * row,
  };
}

// Label array index of the voxel under every pixel of the image (-1 outside the volume), row by row.
export function sampleVoxelIndices(space: VoxelSpace, mapping: ImageMapping, out?: Int32Array): Int32Array {
  const { widthPixels: width, heightPixels: height } = mapping;
  const result = out && out.length === width * height ? out : new Int32Array(width * height);
  const g = space.geometry;
  const o = toLocalPoint(g, mapping.origin);
  const c = toLocalDirection(g, mapping.columnStep);
  const r = toLocalDirection(g, mapping.rowStep);
  const sliceSize = space.width * space.height;
  const { depths } = space;
  const constantDepth = Math.abs(c.z) < 1e-9 && Math.abs(r.z) < 1e-9;
  const fixedK = constantDepth ? nearestSlice(space, o.z) : -1;
  if (constantDepth && fixedK < 0) {
    result.fill(-1);
    return result;
  }

  for (let row = 0; row < height; row++) {
    const rx = o.x + r.x * row;
    const ry = o.y + r.y * row;
    const rz = o.z + r.z * row;
    const base = row * width;
    for (let column = 0; column < width; column++) {
      const z = rz + c.z * column;
      const k = constantDepth ? fixedK : nearestSlice(space, z);
      if (k < 0) {
        result[base + column] = -1;
        continue;
      }
      const depth = depths[k];
      const i = Math.round((rx + c.x * column - g.shear.x * depth) / g.spacingX);
      const j = Math.round((ry + c.y * column - g.shear.y * depth) / g.spacingY);
      result[base + column] = i < 0 || j < 0 || i >= space.width || j >= space.height ? -1 : k * sliceSize + j * space.width + i;
    }
  }
  return result;
}
