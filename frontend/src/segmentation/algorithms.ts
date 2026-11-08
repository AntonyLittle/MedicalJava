import type { Volume } from '../api/types';
import type { LabelEdit, Labelmap, VoxelBox } from './labelmap';
import { voxelSpace, type VoxelIndex, type VoxelSpace } from './voxelSpace';

// Whole-volume operations, written as generators that yield their progress (0..1) between chunks of work so the
// caller can spread them over several frames (see runJob). Values and ranges are stored values. Unless
// `overwrite` is set, operations that add voxels to a segment only take background voxels.

export type LabelJob<T = void> = Generator<number, T, void>;

// ---- helpers ----

class BitSet {
  private readonly words: Uint32Array;
  constructor(size: number) {
    this.words = new Uint32Array((size + 31) >>> 5);
  }
  has(i: number): boolean {
    return (this.words[i >>> 5] & (1 << (i & 31))) !== 0;
  }
  add(i: number): void {
    this.words[i >>> 5] |= 1 << (i & 31);
  }
  clear(): void {
    this.words.fill(0);
  }
}

class IntStack {
  private items = new Int32Array(4096);
  length = 0;
  push(value: number): void {
    if (this.length === this.items.length) {
      const grown = new Int32Array(this.items.length * 2);
      grown.set(this.items);
      this.items = grown;
    }
    this.items[this.length++] = value;
  }
  pop(): number {
    return this.items[--this.length];
  }
}

// A sub-box of the volume with its own dense indexing.
interface Region {
  x0: number;
  y0: number;
  z0: number;
  nx: number;
  ny: number;
  nz: number;
}

function regionAround(map: Labelmap, box: VoxelBox, margin: [number, number, number]): Region {
  const x0 = Math.max(0, box.min[0] - margin[0]);
  const y0 = Math.max(0, box.min[1] - margin[1]);
  const z0 = Math.max(0, box.min[2] - margin[2]);
  const x1 = Math.min(map.width - 1, box.max[0] + margin[0]);
  const y1 = Math.min(map.height - 1, box.max[1] + margin[1]);
  const z1 = Math.min(map.depth - 1, box.max[2] + margin[2]);
  return { x0, y0, z0, nx: x1 - x0 + 1, ny: y1 - y0 + 1, nz: z1 - z0 + 1 };
}

function canPaint(current: number, label: number, overwrite: boolean): boolean {
  return current !== label && (overwrite || current === 0);
}

// ---- threshold and region growing ----

export interface FillOptions {
  label: number;
  low: number;
  high: number;
  overwrite: boolean;
}

// Adds every voxel with a value in [low, high] to the segment.
export function* thresholdJob(volume: Volume, edit: LabelEdit, options: FillOptions): LabelJob<number> {
  const map = edit.labelmap;
  const { label, low, high, overwrite } = options;
  let changed = 0;
  for (let k = 0; k < map.depth; k++) {
    const values = volume.slices[k].radiodensities;
    const base = k * map.sliceSize;
    for (let p = 0; p < map.sliceSize; p++) {
      const value = values[p];
      if (value >= low && value <= high && canPaint(map.data[base + p], label, overwrite) && edit.set(base + p, label)) changed++;
    }
    yield (k + 1) / map.depth;
  }
  return changed;
}

// Flood fill from the seed through face-connected voxels with values in [low, high]. Voxels already in the segment
// are passed through; with overwrite off, other segments stop the fill.
export function* regionGrowJob(volume: Volume, edit: LabelEdit, seed: VoxelIndex, options: FillOptions): LabelJob<number> {
  const map = edit.labelmap;
  const { width, height, depth, sliceSize, data } = map;
  const { label, low, high, overwrite } = options;
  const slices = volume.slices;
  const visited = new BitSet(data.length);
  const stack = new IntStack();
  const accepts = (index: number): boolean => {
    const current = data[index];
    if (current !== label && current !== 0 && !overwrite) return false;
    const k = (index / sliceSize) | 0;
    const value = slices[k].radiodensities[index - k * sliceSize];
    return value >= low && value <= high;
  };

  const start = map.index(seed.i, seed.j, seed.k);
  let changed = 0;
  if (!accepts(start)) return 0;
  visited.add(start);
  stack.push(start);
  let processed = 0;
  while (stack.length > 0) {
    const index = stack.pop();
    if (edit.set(index, label)) changed++;
    const k = (index / sliceSize) | 0;
    const rest = index - k * sliceSize;
    const j = (rest / width) | 0;
    const i = rest - j * width;
    const visit = (n: number) => {
      if (!visited.has(n)) {
        visited.add(n);
        if (accepts(n)) stack.push(n);
      }
    };
    if (i > 0) visit(index - 1);
    if (i < width - 1) visit(index + 1);
    if (j > 0) visit(index - width);
    if (j < height - 1) visit(index + width);
    if (k > 0) visit(index - sliceSize);
    if (k < depth - 1) visit(index + sliceSize);
    if (++processed % 200000 === 0) yield Math.min(0.99, processed / data.length);
  }
  return changed;
}

// ---- distance transforms ----

const INF = 1e20;

// Squared distance to the nearest feature along one line (Felzenszwalb & Huttenlocher), for samples at arbitrary
// increasing positions. f holds 0 at features and INF elsewhere on entry, and the squared distances on return.
function distanceLine(f: Float64Array, positions: ArrayLike<number>, n: number, v: Int32Array, z: Float64Array, out: Float64Array): void {
  let k = -1;
  for (let q = 0; q < n; q++) {
    if (f[q] >= INF) continue;
    const pq = positions[q];
    if (k < 0) {
      k = 0;
      v[0] = q;
      z[0] = -INF;
      z[1] = INF;
      continue;
    }
    const intersection = (r: number) => {
      const pr = positions[r];
      return (f[q] + pq * pq - (f[r] + pr * pr)) / (2 * (pq - pr));
    };
    // z[0] is -INF, so this stops at k = 0.
    let s = intersection(v[k]);
    while (s <= z[k]) {
      k--;
      s = intersection(v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  if (k < 0) {
    out.fill(INF, 0, n);
    return;
  }
  let j = 0;
  for (let q = 0; q < n; q++) {
    const pq = positions[q];
    while (z[j + 1] < pq) j++;
    const d = pq - positions[v[j]];
    out[q] = d * d + f[v[j]];
  }
}

// Squared distances (mm²) from every voxel of the region to the nearest voxel where feature() is true.
function* distanceTransform(
  space: VoxelSpace,
  region: Region,
  feature: (index: number) => boolean
): Generator<number, Float64Array, void> {
  const { nx, ny, nz } = region;
  const g = space.geometry;
  const count = nx * ny * nz;
  const dist = new Float64Array(count);
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      const base = (z * ny + y) * nx;
      for (let x = 0; x < nx; x++) dist[base + x] = feature(base + x) ? 0 : INF;
    }
  }
  const longest = Math.max(nx, ny, nz);
  const f = new Float64Array(longest);
  const out = new Float64Array(longest);
  const v = new Int32Array(longest);
  const zs = new Float64Array(longest + 1);
  const xPositions = Float64Array.from({ length: nx }, (_, i) => (region.x0 + i) * g.spacingX);
  const yPositions = Float64Array.from({ length: ny }, (_, j) => (region.y0 + j) * g.spacingY);
  const zPositions = Float64Array.from({ length: nz }, (_, k) => space.depths[region.z0 + k]);

  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      const base = (z * ny + y) * nx;
      for (let x = 0; x < nx; x++) f[x] = dist[base + x];
      distanceLine(f, xPositions, nx, v, zs, out);
      for (let x = 0; x < nx; x++) dist[base + x] = out[x];
    }
    yield (z + 1) / (3 * nz);
  }
  for (let z = 0; z < nz; z++) {
    for (let x = 0; x < nx; x++) {
      for (let y = 0; y < ny; y++) f[y] = dist[(z * ny + y) * nx + x];
      distanceLine(f, yPositions, ny, v, zs, out);
      for (let y = 0; y < ny; y++) dist[(z * ny + y) * nx + x] = out[y];
    }
    yield (nz + z + 1) / (3 * nz);
  }
  if (nz > 1) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        for (let z = 0; z < nz; z++) f[z] = dist[(z * ny + y) * nx + x];
        distanceLine(f, zPositions, nz, v, zs, out);
        for (let z = 0; z < nz; z++) dist[(z * ny + y) * nx + x] = out[z];
      }
      yield (2 * nz + ((y + 1) / ny) * nz) / (3 * nz);
    }
  }
  return dist;
}

function regionIndexToVolume(map: Labelmap, region: Region, r: number): number {
  const x = r % region.nx;
  const rest = (r - x) / region.nx;
  const y = rest % region.ny;
  const z = (rest - y) / region.ny;
  return map.index(region.x0 + x, region.y0 + y, region.z0 + z);
}

// Voxels within `mm` along each axis, plus one.
function marginFor(space: VoxelSpace, mm: number): [number, number, number] {
  const g = space.geometry;
  return [Math.ceil(mm / g.spacingX) + 1, Math.ceil(mm / g.spacingY) + 1, Math.ceil(mm / Math.max(1e-6, space.sliceSpacing)) + 1];
}

// ---- morphology ----

export interface MorphologyOptions {
  label: number;
  radiusMm: number;
  overwrite: boolean;
}

// Grows the segment by every voxel within radiusMm of it.
export function* dilateJob(volume: Volume, edit: LabelEdit, options: MorphologyOptions): LabelJob<number> {
  const map = edit.labelmap;
  const bounds = map.boundsOf(options.label);
  if (!bounds) return 0;
  const space = voxelSpace(volume);
  const region = regionAround(map, bounds, marginFor(space, options.radiusMm));
  const toVolume = (r: number) => regionIndexToVolume(map, region, r);
  const dist = yield* scaledProgress(
    distanceTransform(space, region, (r) => map.data[toVolume(r)] === options.label),
    0,
    0.9
  );
  const radiusSq = options.radiusMm * options.radiusMm;
  let changed = 0;
  for (let r = 0; r < dist.length; r++) {
    if (dist[r] === 0 || dist[r] > radiusSq) continue;
    const index = toVolume(r);
    if (canPaint(map.data[index], options.label, options.overwrite) && edit.set(index, options.label)) changed++;
  }
  return changed;
}

// Removes every voxel of the segment within radiusMm of a voxel outside it.
export function* erodeJob(volume: Volume, edit: LabelEdit, options: MorphologyOptions): LabelJob<number> {
  const map = edit.labelmap;
  const bounds = map.boundsOf(options.label);
  if (!bounds) return 0;
  const space = voxelSpace(volume);
  const region = regionAround(map, bounds, marginFor(space, options.radiusMm));
  const toVolume = (r: number) => regionIndexToVolume(map, region, r);
  const dist = yield* scaledProgress(
    distanceTransform(space, region, (r) => map.data[toVolume(r)] !== options.label),
    0,
    0.9
  );
  const radiusSq = options.radiusMm * options.radiusMm;
  let changed = 0;
  for (let r = 0; r < dist.length; r++) {
    if (dist[r] === 0 || dist[r] > radiusSq) continue;
    if (edit.set(toVolume(r), 0)) changed++;
  }
  return changed;
}

function* scaledProgress<T>(job: Generator<number, T, void>, from: number, to: number): Generator<number, T, void> {
  let step = job.next();
  while (!step.done) {
    yield from + (to - from) * step.value;
    step = job.next();
  }
  return step.value;
}

// ---- connectivity ----

// Calls visit for every voxel of the region connected (through faces) to start where inside() holds.
function floodRegion(region: Region, start: number, inside: (r: number) => boolean, visited: BitSet, stack: IntStack, visit?: (r: number) => void): number {
  const { nx, ny, nz } = region;
  const plane = nx * ny;
  let size = 0;
  visited.add(start);
  stack.push(start);
  while (stack.length > 0) {
    const r = stack.pop();
    size++;
    visit?.(r);
    const x = r % nx;
    const y = ((r - x) / nx) % ny;
    const z = (r - x - y * nx) / plane;
    const push = (n: number) => {
      if (!visited.has(n) && inside(n)) {
        visited.add(n);
        stack.push(n);
      }
    };
    if (x > 0) push(r - 1);
    if (x < nx - 1) push(r + 1);
    if (y > 0) push(r - nx);
    if (y < ny - 1) push(r + nx);
    if (z > 0) push(r - plane);
    if (z < nz - 1) push(r + plane);
  }
  return size;
}

// Removes every part of the segment except its largest face-connected piece.
export function* keepLargestComponentJob(edit: LabelEdit, label: number): LabelJob<number> {
  const map = edit.labelmap;
  const bounds = map.boundsOf(label);
  if (!bounds) return 0;
  const region = regionAround(map, bounds, [0, 0, 0]);
  const count = region.nx * region.ny * region.nz;
  const toVolume = (r: number) => regionIndexToVolume(map, region, r);
  const inside = (r: number) => map.data[toVolume(r)] === label;
  const visited = new BitSet(count);
  const stack = new IntStack();

  let largest = -1;
  let largestSize = 0;
  for (let r = 0; r < count; r++) {
    if (visited.has(r) || !inside(r)) continue;
    const size = floodRegion(region, r, inside, visited, stack);
    if (size > largestSize) {
      largestSize = size;
      largest = r;
    }
    if (r % 100000 === 0) yield (0.5 * r) / count;
  }
  visited.clear();
  floodRegion(region, largest, inside, visited, stack);
  let changed = 0;
  for (let r = 0; r < count; r++) {
    if (!visited.has(r) && inside(r) && edit.set(toVolume(r), 0)) changed++;
  }
  return changed;
}

// Fills the cavities of the segment: voxels that can't reach the outside of its bounding box without crossing it.
// With perSlice, each acquired slice is filled on its own (holes open along the stack are filled too).
export function* fillHolesJob(edit: LabelEdit, label: number, perSlice: boolean, overwrite: boolean): LabelJob<number> {
  const map = edit.labelmap;
  const bounds = map.boundsOf(label);
  if (!bounds) return 0;
  const box = regionAround(map, bounds, [1, 1, perSlice ? 0 : 1]);
  const regions: Region[] = perSlice
    ? Array.from({ length: box.nz }, (_, z) => ({ ...box, z0: box.z0 + z, nz: 1 }))
    : [box];

  let changed = 0;
  for (let n = 0; n < regions.length; n++) {
    const region = regions[n];
    const count = region.nx * region.ny * region.nz;
    const toVolume = (r: number) => regionIndexToVolume(map, region, r);
    const open = (r: number) => map.data[toVolume(r)] !== label;
    const reached = new BitSet(count);
    const stack = new IntStack();
    const { nx, ny, nz } = region;
    // Seeds: background on the region's faces.
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          const onFace = x === 0 || y === 0 || x === nx - 1 || y === ny - 1 || (nz > 1 && (z === 0 || z === nz - 1));
          if (!onFace) continue;
          const r = (z * ny + y) * nx + x;
          if (!reached.has(r) && open(r)) floodRegion(region, r, open, reached, stack);
        }
      }
    }
    for (let r = 0; r < count; r++) {
      if (reached.has(r)) continue;
      const index = toVolume(r);
      if (canPaint(map.data[index], label, overwrite) && edit.set(index, label)) changed++;
    }
    yield (n + 1) / regions.length;
  }
  return changed;
}

// Removes the segment entirely.
export function* clearLabelJob(edit: LabelEdit, label: number): LabelJob<number> {
  const map = edit.labelmap;
  let changed = 0;
  for (let k = 0; k < map.depth; k++) {
    const base = k * map.sliceSize;
    for (let p = 0; p < map.sliceSize; p++) if (map.data[base + p] === label && edit.set(base + p, 0)) changed++;
    yield (k + 1) / map.depth;
  }
  return changed;
}

// ---- interpolation between slices ----

// Signed distance (mm, negative inside) to the segment's outline within one slice of the region.
function signedDistanceSlice(space: VoxelSpace, map: Labelmap, region: Region, k: number, label: number): Float64Array {
  const slice: Region = { ...region, z0: k, nz: 1 };
  const inside = (r: number) => map.data[regionIndexToVolume(map, slice, r)] === label;
  const outsideDist = runToEnd(distanceTransform(space, slice, inside));
  const insideDist = runToEnd(distanceTransform(space, slice, (r) => !inside(r)));
  const result = new Float64Array(outsideDist.length);
  for (let r = 0; r < result.length; r++) {
    result[r] = inside(r) ? -Math.sqrt(insideDist[r]) : Math.sqrt(outsideDist[r]);
  }
  return result;
}

// Fills the slices between drawn slices of the segment by blending their signed distance maps (shape-based
// interpolation) along the stack. Only gaps where the segment is missing entirely are filled.
export function* interpolateSlicesJob(volume: Volume, edit: LabelEdit, label: number, overwrite: boolean): LabelJob<number> {
  const map = edit.labelmap;
  const bounds = map.boundsOf(label);
  if (!bounds) return 0;
  const space = voxelSpace(volume);
  const present: boolean[] = [];
  for (let k = 0; k < map.depth; k++) {
    let any = false;
    const base = k * map.sliceSize;
    for (let p = 0; p < map.sliceSize && !any; p++) any = map.data[base + p] === label;
    present.push(any);
  }
  const keys = present.flatMap((p, k) => (p ? [k] : []));
  const gaps = keys.slice(1).map((k1, n) => [keys[n], k1] as const).filter(([k0, k1]) => k1 - k0 > 1);
  if (gaps.length === 0) return 0;

  // In-plane region: the segment's bounds plus room for shapes that grow between the key slices.
  const region = regionAround(map, { min: [bounds.min[0], bounds.min[1], 0], max: [bounds.max[0], bounds.max[1], 0] }, [2, 2, 0]);
  let changed = 0;
  for (let n = 0; n < gaps.length; n++) {
    const [k0, k1] = gaps[n];
    const d0 = signedDistanceSlice(space, map, region, k0, label);
    const d1 = signedDistanceSlice(space, map, region, k1, label);
    const span = space.depths[k1] - space.depths[k0];
    for (let k = k0 + 1; k < k1; k++) {
      const t = span > 0 ? (space.depths[k] - space.depths[k0]) / span : (k - k0) / (k1 - k0);
      for (let r = 0; r < d0.length; r++) {
        if ((1 - t) * d0[r] + t * d1[r] > 0) continue;
        const x = r % region.nx;
        const y = (r - x) / region.nx;
        const index = map.index(region.x0 + x, region.y0 + y, k);
        if (canPaint(map.data[index], label, overwrite) && edit.set(index, label)) changed++;
      }
    }
    yield (n + 1) / gaps.length;
  }
  return changed;
}

function runToEnd<T>(job: Generator<number, T, void>): T {
  let step = job.next();
  while (!step.done) step = job.next();
  return step.value;
}

// ---- statistics ----

export interface LabelStatistics {
  label: number;
  voxelCount: number;
  volumeMl: number;
  // Stored values; convert with the volume's slope and intercept.
  mean: number;
  standardDeviation: number;
  min: number;
  max: number;
}

// Statistics of every label present. A slice's voxels are as thick as its share of the stack.
export function* statisticsJob(volume: Volume, map: Labelmap): LabelJob<LabelStatistics[]> {
  const space = voxelSpace(volume);
  const g = space.geometry;
  const count = new Float64Array(256);
  const volumeMm3 = new Float64Array(256);
  const sum = new Float64Array(256);
  const sumSquares = new Float64Array(256);
  const min = new Float64Array(256).fill(Infinity);
  const max = new Float64Array(256).fill(-Infinity);
  const sliceCount = new Float64Array(256);
  for (let k = 0; k < map.depth; k++) {
    const values = volume.slices[k].radiodensities;
    const base = k * map.sliceSize;
    sliceCount.fill(0);
    for (let p = 0; p < map.sliceSize; p++) {
      const label = map.data[base + p];
      if (label === 0) continue;
      const value = values[p];
      sliceCount[label]++;
      sum[label] += value;
      sumSquares[label] += value * value;
      if (value < min[label]) min[label] = value;
      if (value > max[label]) max[label] = value;
    }
    const voxelMm3 = g.spacingX * g.spacingY * 2 * (space.halfThickness[k] - 1e-4);
    for (let label = 1; label < 256; label++) {
      count[label] += sliceCount[label];
      volumeMm3[label] += sliceCount[label] * voxelMm3;
    }
    yield (k + 1) / map.depth;
  }
  const result: LabelStatistics[] = [];
  for (let label = 1; label < 256; label++) {
    if (count[label] === 0) continue;
    const mean = sum[label] / count[label];
    result.push({
      label,
      voxelCount: count[label],
      volumeMl: volumeMm3[label] / 1000,
      mean,
      standardDeviation: Math.sqrt(Math.max(0, sumSquares[label] / count[label] - mean * mean)),
      min: min[label],
      max: max[label],
    });
  }
  return result;
}

// Mean volume of a voxel, in millilitres; for live (approximate) segment volumes from voxel counts.
export function meanVoxelMl(volume: Volume): number {
  const space = voxelSpace(volume);
  return (space.geometry.spacingX * space.geometry.spacingY * space.sliceSpacing) / 1000;
}

