import type { Slice, Volume } from '../api/types';
import type { Coordinate } from '../utils/canvasMath';

// Edge length, in voxels, of the blocks used for empty-space skipping; a power of two.
const BRICK_SHIFT = 3;
export const BRICK_SIZE = 1 << BRICK_SHIFT;

export interface Box {
  min: Coordinate;
  max: Coordinate;
}

// A regular voxel grid in patient space (mm); voxel (i, j, k) is centred at origin + (i, j, k) * spacing.
export interface VolumeGrid {
  dims: [number, number, number];
  origin: Coordinate;
  spacing: Coordinate;
  // Region rays are marched through: the voxel centres, widened by half a voxel along single-voxel axes.
  box: Box;
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

// Maps the volume's slices onto a regular grid no bigger than maxSize along any axis. Evenly spaced slices are used
// as they are; uneven ones are resampled to evenly spaced depths, and oversized axes are decimated.
export function planVolumeGrid(volume: Volume, maxSize: number): GridSampler {
  if (volume.slices.length === 0) throw new Error('Volume has no slices');
  const slices: Slice[] = [...volume.slices].sort((a, b) => a.depthPositionMm - b.depthPositionMm);
  const first = slices[0];
  const sourceWidth = first.widthPixels;
  const depths = slices.map((s) => s.depthPositionMm);
  const count = slices.length;

  const strideX = Math.ceil(sourceWidth / maxSize);
  const strideY = Math.ceil(first.heightPixels / maxSize);
  const nx = Math.floor((sourceWidth - 1) / strideX) + 1;
  const ny = Math.floor((first.heightPixels - 1) / strideY) + 1;

  const zMin = depths[0];
  const zMax = depths[count - 1];
  const extentZ = zMax - zMin;
  const step = count > 1 ? extentZ / (count - 1) : 0;
  const evenlySpaced = step > 0 && depths.every((d, i) => Math.abs(d - (zMin + i * step)) <= 1e-3 * step);
  const nz = extentZ <= 1e-6 ? 1 : Math.min(count, maxSize);
  const direct = nz === count && (count === 1 || evenlySpaced);

  const spacing = {
    x: first.pixelSpacingXMm * strideX,
    y: first.pixelSpacingYMm * strideY,
    z: nz > 1 ? extentZ / (nz - 1) : Math.min(first.pixelSpacingXMm, first.pixelSpacingYMm),
  };
  const origin = { x: first.originXMm, y: first.originYMm, z: zMin };
  const dims: [number, number, number] = [nx, ny, nz];
  const half = (n: number, s: number) => (n === 1 ? s / 2 : 0);
  const box: Box = {
    min: {
      x: origin.x - half(nx, spacing.x),
      y: origin.y - half(ny, spacing.y),
      z: origin.z - half(nz, spacing.z),
    },
    max: {
      x: origin.x + (nx - 1) * spacing.x + half(nx, spacing.x),
      y: origin.y + (ny - 1) * spacing.y + half(ny, spacing.y),
      z: origin.z + (nz - 1) * spacing.z + half(nz, spacing.z),
    },
  };

  const fillSlice = (k: number, out: Float32Array) => {
    let lower = k;
    let t = 0;
    if (!direct) {
      const z = zMin + k * spacing.z;
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

  return { grid: { dims, origin, spacing, box }, fillSlice };
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
