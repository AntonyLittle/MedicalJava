import type { Volume } from '../api/types';
import type { Coordinate } from '../utils/canvasMath';
import { toPatientPoint } from '../utils/volumeGeometry';
import type { Labelmap } from './labelmap';
import type { LabelJob } from './algorithms';
import { voxelSpace } from './voxelSpace';

// Triangle surface of one segment, from naive surface nets: one vertex per cell (cube of 8 voxel centres) the surface
// crosses, at the mean of its crossing edges' midpoints, and a quad around every voxel edge whose ends differ.
// The mask is padded with background, so the surface is closed even where the segment touches the volume's edge.
export interface Mesh {
  // Patient-space (LPS, mm) vertex positions, xyz per vertex.
  positions: Float32Array;
  // Vertex indices, three per triangle, counter-clockwise seen from outside.
  triangles: Uint32Array;
}

class Growable<T extends Float32Array | Uint32Array> {
  data: T;
  length = 0;
  private readonly make: (size: number) => T;
  constructor(make: (size: number) => T) {
    this.make = make;
    this.data = make(4096);
  }
  push(...values: number[]): void {
    if (this.length + values.length > this.data.length) {
      const grown = this.make(Math.max(this.data.length * 2, this.length + values.length));
      grown.set(this.data);
      this.data = grown;
    }
    for (const v of values) this.data[this.length++] = v;
  }
  result(): T {
    return this.data.slice(0, this.length) as T;
  }
}

export function* surfaceMeshJob(volume: Volume, map: Labelmap, label: number): LabelJob<Mesh | null> {
  const bounds = map.boundsOf(label);
  if (!bounds) return null;
  const space = voxelSpace(volume);
  const g = space.geometry;
  const { depths } = space;

  // Samples: the bounds plus one background voxel all round; sample (a, b, c) is voxel (x0 + a, y0 + b, z0 + c).
  const x0 = bounds.min[0] - 1;
  const y0 = bounds.min[1] - 1;
  const z0 = bounds.min[2] - 1;
  const sx = bounds.max[0] - bounds.min[0] + 3;
  const sy = bounds.max[1] - bounds.min[1] + 3;
  const sz = bounds.max[2] - bounds.min[2] + 3;
  const inside = (a: number, b: number, c: number): number => {
    const i = x0 + a;
    const j = y0 + b;
    const k = z0 + c;
    if (i < 0 || j < 0 || k < 0 || i >= map.width || j >= map.height || k >= map.depth) return 0;
    return map.data[map.index(i, j, k)] === label ? 1 : 0;
  };

  const depthAt = (k: number): number => {
    const last = depths.length - 1;
    if (last === 0) return depths[0] + k * space.sliceSpacing;
    if (k <= 0) return depths[0] + k * (depths[1] - depths[0]);
    if (k >= last) return depths[last] + (k - last) * (depths[last] - depths[last - 1]);
    const lo = Math.floor(k);
    return depths[lo] + (depths[lo + 1] - depths[lo]) * (k - lo);
  };
  const toPatient = (a: number, b: number, c: number): Coordinate => {
    const depth = depthAt(z0 + c);
    return toPatientPoint(g, {
      x: (x0 + a) * g.spacingX + g.shear.x * depth,
      y: (y0 + b) * g.spacingY + g.shear.y * depth,
      z: depth,
    });
  };

  const positions = new Growable((n) => new Float32Array(n));
  const triangles = new Growable((n) => new Uint32Array(n));
  const cellsX = sx - 1;
  const cellsY = sy - 1;
  let previous = new Int32Array(cellsX * cellsY).fill(-1);
  let current = new Int32Array(cellsX * cellsY).fill(-1);
  let vertexCount = 0;

  // Edges of a cell, as pairs of corner offsets (dx, dy, dz).
  const corners = [
    [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
  ];
  const edges = [
    [0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  const values = new Uint8Array(8);

  const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) triangles.push(a, d, c, a, c, b);
    else triangles.push(a, b, c, a, c, d);
  };

  for (let c = 0; c < sz - 1; c++) {
    current.fill(-1);
    // Vertices of cell layer c.
    for (let b = 0; b < cellsY; b++) {
      for (let a = 0; a < cellsX; a++) {
        let mask = 0;
        for (let n = 0; n < 8; n++) {
          values[n] = inside(a + corners[n][0], b + corners[n][1], c + corners[n][2]);
          mask |= values[n] << n;
        }
        if (mask === 0 || mask === 255) continue;
        let px = 0;
        let py = 0;
        let pz = 0;
        let crossings = 0;
        for (const [e0, e1] of edges) {
          if (values[e0] === values[e1]) continue;
          px += (corners[e0][0] + corners[e1][0]) / 2;
          py += (corners[e0][1] + corners[e1][1]) / 2;
          pz += (corners[e0][2] + corners[e1][2]) / 2;
          crossings++;
        }
        const p = toPatient(a + px / crossings, b + py / crossings, c + pz / crossings);
        positions.push(p.x, p.y, p.z);
        current[b * cellsX + a] = vertexCount++;
      }
    }

    // Quads around the sample edges whose surrounding cells are all known by now. For an edge along axis A the
    // cells are ordered so the quad's normal points along +A; it is flipped when the inside is at the far end.
    // The padding means no edge on the outermost samples crosses the surface.
    const cell = (ca: number, cb: number, layer: Int32Array) => layer[cb * cellsX + ca];
    for (let b = 0; b < sy - 1; b++) {
      for (let a = 0; a < sx - 1; a++) {
        const here = inside(a, b, c);
        // Along z, from sample layer c to c + 1: cells (a-1..a, b-1..b) of layer c; quad in the x-y plane.
        if (a > 0 && b > 0 && here !== inside(a, b, c + 1)) {
          quad(cell(a - 1, b - 1, current), cell(a, b - 1, current), cell(a, b, current), cell(a - 1, b, current), here === 0);
        }
        if (c === 0) continue;
        // Along x and y within sample layer c: cells of layers c - 1 (previous) and c (current).
        if (b > 0 && here !== inside(a + 1, b, c)) {
          // Plane (y, z): y × z = +x.
          quad(cell(a, b - 1, previous), cell(a, b, previous), cell(a, b, current), cell(a, b - 1, current), here === 0);
        }
        if (a > 0 && here !== inside(a, b + 1, c)) {
          // Plane (z, x): z × x = +y.
          quad(cell(a - 1, b, previous), cell(a - 1, b, current), cell(a, b, current), cell(a, b, previous), here === 0);
        }
      }
    }
    [previous, current] = [current, previous];
    yield (c + 1) / (sz - 1);
  }

  return { positions: positions.result(), triangles: triangles.result() };
}

// Binary STL of the mesh, in millimetres. The patient frame (LPS) has the determinant of a right-handed frame, so
// counter-clockwise triangles keep facing outwards.
export function meshToStl(mesh: Mesh, name: string): Blob {
  const count = mesh.triangles.length / 3;
  const buffer = new ArrayBuffer(84 + count * 50);
  const view = new DataView(buffer);
  const header = new TextEncoder().encode(`MedicalJava segment ${name}`.slice(0, 79));
  new Uint8Array(buffer, 0, 80).set(header);
  view.setUint32(80, count, true);
  const p = mesh.positions;
  let offset = 84;
  for (let t = 0; t < count; t++) {
    const [a, b, c] = [mesh.triangles[t * 3] * 3, mesh.triangles[t * 3 + 1] * 3, mesh.triangles[t * 3 + 2] * 3];
    const ux = p[b] - p[a];
    const uy = p[b + 1] - p[a + 1];
    const uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a];
    const vy = p[c + 1] - p[a + 1];
    const vz = p[c + 2] - p[a + 2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz) || 1;
    nx /= length;
    ny /= length;
    nz /= length;
    for (const value of [nx, ny, nz, p[a], p[a + 1], p[a + 2], p[b], p[b + 1], p[b + 2], p[c], p[c + 1], p[c + 2]]) {
      view.setFloat32(offset, value, true);
      offset += 4;
    }
    view.setUint16(offset, 0, true);
    offset += 2;
  }
  return new Blob([buffer], { type: 'model/stl' });
}

// Signed volume enclosed by the mesh (mm³); positive when its triangles face outwards.
export function meshVolume(mesh: Mesh): number {
  const p = mesh.positions;
  let sum = 0;
  for (let t = 0; t < mesh.triangles.length; t += 3) {
    const a = mesh.triangles[t] * 3;
    const b = mesh.triangles[t + 1] * 3;
    const c = mesh.triangles[t + 2] * 3;
    sum +=
      p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
      p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
      p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return sum / 6;
}
