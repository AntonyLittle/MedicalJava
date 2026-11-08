import type { Volume } from '../api/types';
import type { Coordinate } from '../utils/canvasMath';
import { volumeGeometry, type Box } from '../utils/volumeGeometry';
import { affineFromColumns, applyAffine, invertAffine, type Affine } from './affine';

// Edge length, in voxels, of the blocks used for empty-space skipping; a power of two.
const BRICK_SHIFT = 3;
export const BRICK_SIZE = 1 << BRICK_SHIFT;

// A regular voxel grid in the volume's own (possibly oblique or sheared) frame. Voxel coordinates are fractional
// grid indices: voxel (i, j, k) is centred at voxelToPatient·(i, j, k).
export interface VolumeGrid {
  dims: [number, number, number];
  // Millimetres between neighbouring voxels along each grid axis.
  spacing: Coordinate;
  voxelToPatient: Affine;
  patientToVoxel: Affine;
  // Region rays are marched through, in voxel coordinates: the voxel centres, widened by half a voxel along
  // single-voxel axes.
  voxelBox: Box;
  // Patient-space box around voxelBox; the clip box is a fraction of it.
  bounds: Box;
}

// Value range of each brick, widened to include its neighbours so that interpolation and gradient samples
// near a brick's edge are covered too.
export interface BrickStats {
  dims: [number, number, number];
  min: Float32Array;
  max: Float32Array;
}

export interface GridSampler {
  grid: VolumeGrid;
  // Writes slice k of the grid (dims[0] * dims[1] values, row-major) into out.
  fillSlice: (k: number, out: Float32Array) => void;
}

function lowerIndex(sortedValues: number[], value: number): number {
  let lo = 0;
  let hi = sortedValues.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (sortedValues[mid] <= value) lo = mid;
    else hi = mid;
  }
  return lo;
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

// Maps the volume's slices onto a regular grid no bigger than maxSize along any axis. Evenly spaced slices are used
// as they are; uneven ones are resampled to evenly spaced depths, and oversized axes are decimated. The grid keeps
// the acquisition's orientation (and any gantry-tilt shear); voxelToPatient places it in patient space.
export function planVolumeGrid(volume: Volume, maxSize: number): GridSampler {
  if (volume.slices.length === 0) throw new Error('Volume has no slices');
  const geometry = volumeGeometry(volume);
  const slices = volume.slices;
  const first = slices[0];
  const sourceWidth = first.widthPixels;
  const depths = geometry.depths;
  const count = slices.length;

  const strideX = Math.ceil(sourceWidth / maxSize);
  const strideY = Math.ceil(first.heightPixels / maxSize);
  const nx = Math.floor((sourceWidth - 1) / strideX) + 1;
  const ny = Math.floor((first.heightPixels - 1) / strideY) + 1;

  const extentZ = depths[count - 1];
  const nz = extentZ <= 1e-6 ? 1 : Math.min(count, maxSize);
  const direct = nz === count && (count === 1 || geometry.depthStep > 0);

  const spacing = {
    x: geometry.spacingX * strideX,
    y: geometry.spacingY * strideY,
    z: nz > 1 ? extentZ / (nz - 1) : Math.min(geometry.spacingX, geometry.spacingY),
  };
  const dims: [number, number, number] = [nx, ny, nz];

  const { right, down, normal, shear } = geometry;
  const stackStep: Coordinate = {
    x: (normal.x + right.x * shear.x + down.x * shear.y) * spacing.z,
    y: (normal.y + right.y * shear.x + down.y * shear.y) * spacing.z,
    z: (normal.z + right.z * shear.x + down.z * shear.y) * spacing.z,
  };
  const voxelToPatient = affineFromColumns(
    { x: right.x * spacing.x, y: right.y * spacing.x, z: right.z * spacing.x },
    { x: down.x * spacing.y, y: down.y * spacing.y, z: down.z * spacing.y },
    stackStep,
    geometry.origin
  );
  const half = (n: number) => (n === 1 ? 0.5 : 0);
  const voxelBox: Box = {
    min: { x: -half(nx), y: -half(ny), z: -half(nz) },
    max: { x: nx - 1 + half(nx), y: ny - 1 + half(ny), z: nz - 1 + half(nz) },
  };
  const corners = Array.from({ length: 8 }, (_, i) =>
    applyAffine(voxelToPatient, {
      x: i & 1 ? voxelBox.max.x : voxelBox.min.x,
      y: i & 2 ? voxelBox.max.y : voxelBox.min.y,
      z: i & 4 ? voxelBox.max.z : voxelBox.min.z,
    })
  );
  const grid: VolumeGrid = {
    dims,
    spacing,
    voxelToPatient,
    patientToVoxel: invertAffine(voxelToPatient),
    voxelBox,
    bounds: boxAround(corners),
  };

  const fillSlice = (k: number, out: Float32Array) => {
    let lower = k;
    let t = 0;
    if (!direct) {
      const z = k * spacing.z;
      lower = lowerIndex(depths, z);
      const upper = Math.min(count - 1, lower + 1);
      const span = depths[upper] - depths[lower];
      t = span > 0 ? Math.min(1, Math.max(0, (z - depths[lower]) / span)) : 0;
    }
    const a = slices[lower].radiodensities;
    const b = slices[Math.min(count - 1, lower + 1)].radiodensities;
    if (t === 0 && strideX === 1 && strideY === 1) {
      // Native int16 → float32 conversion of the whole slice.
      out.set(a);
      return;
    }
    for (let j = 0; j < ny; j++) {
      const sourceRow = j * strideY * sourceWidth;
      const outRow = j * nx;
      if (t === 0) {
        for (let i = 0; i < nx; i++) out[outRow + i] = a[sourceRow + i * strideX];
      } else {
        for (let i = 0; i < nx; i++) {
          const index = sourceRow + i * strideX;
          out[outRow + i] = a[index] + (b[index] - a[index]) * t;
        }
      }
    }
  };

  return { grid, fillSlice };
}

export function createBrickStats(grid: VolumeGrid): BrickStats {
  const dims: [number, number, number] = [
    Math.ceil(grid.dims[0] / BRICK_SIZE),
    Math.ceil(grid.dims[1] / BRICK_SIZE),
    Math.ceil(grid.dims[2] / BRICK_SIZE),
  ];
  const count = dims[0] * dims[1] * dims[2];
  return { dims, min: new Float32Array(count).fill(Infinity), max: new Float32Array(count).fill(-Infinity) };
}

// Folds slice k of the grid into the per-brick ranges.
export function accumulateBrickStats(stats: BrickStats, grid: VolumeGrid, k: number, slice: Float32Array): void {
  const [nx, ny] = grid.dims;
  const [bx, by] = stats.dims;
  const { min, max } = stats;
  const zOffset = (k >> BRICK_SHIFT) * bx * by;
  for (let j = 0; j < ny; j++) {
    const rowOffset = zOffset + (j >> BRICK_SHIFT) * bx;
    const row = j * nx;
    for (let i = 0; i < nx; i++) {
      const value = slice[row + i];
      const index = rowOffset + (i >> BRICK_SHIFT);
      if (value < min[index]) min[index] = value;
      if (value > max[index]) max[index] = value;
    }
  }
}

// Spreads every brick's range to its 26 neighbours (separably, one axis at a time).
export function dilateBrickStats(stats: BrickStats): void {
  const [bx, by, bz] = stats.dims;
  const strides = [1, bx, bx * by];
  const sizes = [bx, by, bz];
  for (let axis = 0; axis < 3; axis++) {
    const min = stats.min.slice();
    const max = stats.max.slice();
    const stride = strides[axis];
    for (let z = 0; z < bz; z++) {
      for (let y = 0; y < by; y++) {
        for (let x = 0; x < bx; x++) {
          const position = axis === 0 ? x : axis === 1 ? y : z;
          const index = x + y * bx + z * bx * by;
          if (position > 0) {
            stats.min[index] = Math.min(stats.min[index], min[index - stride]);
            stats.max[index] = Math.max(stats.max[index], max[index - stride]);
          }
          if (position < sizes[axis] - 1) {
            stats.min[index] = Math.min(stats.min[index], min[index + stride]);
            stats.max[index] = Math.max(stats.max[index], max[index + stride]);
          }
        }
      }
    }
  }
}
