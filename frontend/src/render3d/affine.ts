import type { Coordinate } from '../utils/canvasMath';

// Row-major 3×4 affine transform [r0 | t0; r1 | t1; r2 | t2] mapping p to R·p + t.
export type Affine = readonly number[];

export function applyAffine(m: Affine, p: Coordinate): Coordinate {
  return {
    x: m[0] * p.x + m[1] * p.y + m[2] * p.z + m[3],
    y: m[4] * p.x + m[5] * p.y + m[6] * p.z + m[7],
    z: m[8] * p.x + m[9] * p.y + m[10] * p.z + m[11],
  };
}

export function applyLinear(m: Affine, v: Coordinate): Coordinate {
  return {
    x: m[0] * v.x + m[1] * v.y + m[2] * v.z,
    y: m[4] * v.x + m[5] * v.y + m[6] * v.z,
    z: m[8] * v.x + m[9] * v.y + m[10] * v.z,
  };
}

// The affine with the given column vectors (images of the unit axes) and translation.
export function affineFromColumns(a: Coordinate, b: Coordinate, c: Coordinate, t: Coordinate): Affine {
  return [a.x, b.x, c.x, t.x, a.y, b.y, c.y, t.y, a.z, b.z, c.z, t.z];
}

export function invertAffine(m: Affine): Affine {
  const [a, b, c, tx, d, e, f, ty, g, h, i, tz] = m;
  const A = e * i - f * h;
  const B = f * g - d * i;
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) throw new Error('Volume geometry is degenerate');
  const inv = [
    A / det,
    (c * h - b * i) / det,
    (b * f - c * e) / det,
    B / det,
    (a * i - c * g) / det,
    (c * d - a * f) / det,
    C / det,
    (b * g - a * h) / det,
    (a * e - b * d) / det,
  ];
  return [
    inv[0], inv[1], inv[2], -(inv[0] * tx + inv[1] * ty + inv[2] * tz),
    inv[3], inv[4], inv[5], -(inv[3] * tx + inv[4] * ty + inv[5] * tz),
    inv[6], inv[7], inv[8], -(inv[6] * tx + inv[7] * ty + inv[8] * tz),
  ];
}

// Column-major 4×4 for WebGL's uniformMatrix4fv.
export function affineToMat4(m: Affine): Float32Array {
  return new Float32Array([m[0], m[4], m[8], 0, m[1], m[5], m[9], 0, m[2], m[6], m[10], 0, m[3], m[7], m[11], 1]);
}
