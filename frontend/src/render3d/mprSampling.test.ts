import { describe, expect, it } from 'vitest';
import type { Volume } from '../api/types';
import { buildMprPlanes, quaternionFromAxisAngle, type Coordinate, type ViewablePlane } from '../utils/canvasMath';
import { sampleCrossSection, volumeCentre } from '../utils/mprSampler';
import { makeVolume } from '../utils/testVolumes';
import { sampleVolumeAt } from '../utils/volumeGeometry';
import { outsideValue } from '../utils/volumeValues';
import { planMprSampling, type MprSampling } from './mprSampling';

const pattern = (i: number, j: number, k: number) => Math.round(100 * Math.sin(i * 0.7 + j * 0.3) + 37 * j - 11 * k * k);

const toSagittal = (p: Coordinate): Coordinate => ({ x: -p.z, y: p.x, z: -p.y });

const volumes: Record<string, Volume> = {
  axial: makeVolume({
    width: 12,
    height: 9,
    depths: [0, 1.5, 3, 4.5, 6, 7.5],
    spacingX: 0.8,
    spacingY: 0.8,
    origin: { x: -4, y: 2, z: 10 },
    value: pattern,
  }),
  sagittal: makeVolume({
    width: 12,
    height: 9,
    depths: [0, 1.5, 3, 4.5, 6, 7.5],
    spacingX: 0.8,
    spacingY: 0.8,
    row: toSagittal({ x: 1, y: 0, z: 0 }),
    column: toSagittal({ x: 0, y: 1, z: 0 }),
    origin: toSagittal({ x: -4, y: 2, z: 10 }),
    value: pattern,
  }),
  anisotropic: makeVolume({ width: 10, height: 8, depths: [0, 3, 6, 9], spacingX: 0.7, spacingY: 0.9, value: pattern }),
  sheared: makeVolume({ width: 10, height: 10, depths: [0, 2, 4, 6, 8], shear: { x: 0, y: 0.3 }, value: pattern }),
};

function planesThrough(position: Coordinate): ViewablePlane[] {
  const straight = buildMprPlanes(position, { x: 0, y: 0, z: 0, w: 1 });
  const tilted = buildMprPlanes(position, quaternionFromAxisAngle({ x: 0.48, y: 0.6, z: 0.64 }, 0.5));
  return [straight.axial, straight.coronal, straight.sagittal, tilted.axial, tilted.coronal, tilted.sagittal];
}

// Sample k of a pixel, as the shader computes it.
function samplePoint(sampling: MprSampling, column: number, row: number, k: number): Coordinate {
  const { origin: o, columnStep: c, rowStep: r, sampleStep: s } = sampling;
  return {
    x: o.x + c.x * column + r.x * row + s.x * k,
    y: o.y + c.y * column + r.y * row + s.y * k,
    z: o.z + c.z * column + r.z * row + s.z * k,
  };
}

describe('planMprSampling', () => {
  it('samples each pixel where the CPU sampler does', () => {
    for (const [name, volume] of Object.entries(volumes)) {
      const centre = volumeCentre(volume);
      const position = { x: centre.x + 0.3, y: centre.y - 0.6, z: centre.z + 0.4 };
      for (const plane of planesThrough(position)) {
        const sampling = planMprSampling(volume, plane);
        const expected = sampleCrossSection(volume, plane)!;
        expect(sampling.sampleCount).toBe(1);
        expect(sampling.widthPixels, name).toBe(expected.widthPixels);
        expect(sampling.heightPixels, name).toBe(expected.heightPixels);
        expect(sampling.geometry).toEqual(expected.geometry);

        let compared = 0;
        for (let row = 0; row < sampling.heightPixels; row++) {
          for (let column = 0; column < sampling.widthPixels; column++) {
            const cpu = expected.radiodensities[row * expected.widthPixels + column];
            const gpu = sampleVolumeAt(volume, samplePoint(sampling, column, row, 0));
            if (Number.isNaN(gpu) || cpu === outsideValue(volume)) continue;
            expect(gpu, `${name} pixel ${column},${row}`).toBeCloseTo(cpu, 3);
            compared++;
          }
        }
        expect(compared, name).toBeGreaterThan(10);
      }
    }
  });

  it('spreads slab samples evenly from face to face, centred on the plane', () => {
    const volume = volumes.axial;
    const plane = buildMprPlanes({ x: 0, y: 5, z: 13 }, quaternionFromAxisAngle({ x: 1, y: 0, z: 0 }, 0.3)).axial;
    const thin = planMprSampling(volume, plane);
    const slab = planMprSampling(volume, plane, { slab: { thicknessMm: 4, mode: 'max' }, stepFactor: 0.5 });

    expect(slab.mode).toBe('max');
    // Smallest spacing 0.8 mm, step 0.4 mm: 11 samples over 4 mm.
    expect(slab.sampleCount).toBe(11);
    const first = samplePoint(slab, 2, 3, 0);
    const middle = samplePoint(slab, 2, 3, 5);
    const last = samplePoint(slab, 2, 3, 10);
    const centre = samplePoint(thin, 2, 3, 0);
    const n = plane.normalXyz;
    expect(middle.x).toBeCloseTo(centre.x, 9);
    expect(middle.y).toBeCloseTo(centre.y, 9);
    expect(middle.z).toBeCloseTo(centre.z, 9);
    const span = (last.x - first.x) * n.x + (last.y - first.y) * n.y + (last.z - first.z) * n.z;
    expect(span).toBeCloseTo(4, 9);
  });

  it('uses a single sample for slabs thinner than a step', () => {
    const plane = buildMprPlanes({ x: 0, y: 5, z: 13 }, { x: 0, y: 0, z: 0, w: 1 }).axial;
    const sampling = planMprSampling(volumes.axial, plane, { slab: { thicknessMm: 0.1, mode: 'average' } });
    expect(sampling.sampleCount).toBe(1);
  });
});
