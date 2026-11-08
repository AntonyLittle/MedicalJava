import { describe, expect, it } from 'vitest';
import type { RadioDensities } from '../api/types';
import { buildMprPlanes, quaternionFromAxisAngle, type Coordinate, type ViewablePlane } from './canvasMath';
import { isAxisAligned, sampleCrossSection, sampleSlab, volumeCentre, volumeCorners } from './mprSampler';
import { makeVolume } from './testVolumes';
import { sampleVolumeAt } from './volumeGeometry';

// A smooth but non-separable pattern so interpolation errors and transposed axes both show.
const pattern = (i: number, j: number, k: number) => Math.round(100 * Math.sin(i * 0.7 + j * 0.3) + 37 * j - 11 * k * k);

// Maps patient space so that x → y, y → -z, z → -x: an axial acquisition becomes a sagittal one.
const toSagittal = (p: Coordinate): Coordinate => ({ x: -p.z, y: p.x, z: -p.y });

function rotatePlane(plane: ViewablePlane, rotate: (p: Coordinate) => Coordinate): ViewablePlane {
  return {
    positionXyz: rotate(plane.positionXyz),
    normalXyz: rotate(plane.normalXyz),
    rightXyz: rotate(plane.rightXyz),
    downXyz: rotate(plane.downXyz),
  };
}

function expectSameImage(actual: RadioDensities | undefined, expected: RadioDensities | undefined) {
  expect(actual).toBeDefined();
  expect(expected).toBeDefined();
  expect(actual!.widthPixels).toBe(expected!.widthPixels);
  expect(actual!.heightPixels).toBe(expected!.heightPixels);
  expect(actual!.geometry!.uMinMm).toBeCloseTo(expected!.geometry!.uMinMm, 9);
  expect(actual!.geometry!.vMinMm).toBeCloseTo(expected!.geometry!.vMinMm, 9);
  for (let i = 0; i < expected!.radiodensities.length; i++) {
    expect(actual!.radiodensities[i]).toBeCloseTo(expected!.radiodensities[i], 6);
  }
}

const axial = makeVolume({
  width: 12,
  height: 9,
  depths: [0, 1.5, 3, 4.5, 6, 7.5],
  spacingX: 0.8,
  spacingY: 0.8,
  origin: { x: -4, y: 2, z: 10 },
  value: pattern,
});
// The same voxels acquired sagittally: every patient-space position is rotated by toSagittal.
const sagittal = makeVolume({
  width: 12,
  height: 9,
  depths: [0, 1.5, 3, 4.5, 6, 7.5],
  spacingX: 0.8,
  spacingY: 0.8,
  row: toSagittal({ x: 1, y: 0, z: 0 }),
  column: toSagittal({ x: 0, y: 1, z: 0 }),
  origin: toSagittal({ x: -4, y: 2, z: 10 }),
  value: pattern,
});

function planesThrough(position: Coordinate): ViewablePlane[] {
  const straight = buildMprPlanes(position, { x: 0, y: 0, z: 0, w: 1 });
  const tilted = buildMprPlanes(position, quaternionFromAxisAngle({ x: 0.48, y: 0.6, z: 0.64 }, 0.5));
  return [straight.axial, straight.coronal, straight.sagittal, tilted.axial, tilted.coronal, tilted.sagittal];
}

describe('mprSampler in a volume frame', () => {
  it('samples a rotated acquisition exactly like the same voxels acquired axially', () => {
    const position = { x: 0.3, y: 5.1, z: 13.2 };
    for (const plane of planesThrough(position)) {
      const rotated = rotatePlane(plane, toSagittal);
      expectSameImage(sampleCrossSection(sagittal, rotated), sampleCrossSection(axial, plane));
      for (const mode of ['average', 'max', 'min'] as const) {
        const slab = { thicknessMm: 4, mode };
        expectSameImage(sampleSlab(sagittal, rotated, slab), sampleSlab(axial, plane, slab));
      }
    }
  });

  it('shows the acquired slice itself for a view along the acquisition plane', () => {
    // Slice 2 of the sagittal acquisition lies at x = -(10 + 3).
    const plane: ViewablePlane = {
      positionXyz: { x: -13, y: 0, z: 0 },
      normalXyz: { x: 1, y: 0, z: 0 },
      rightXyz: { x: 0, y: 1, z: 0 },
      downXyz: { x: 0, y: 0, z: -1 },
    };
    expect(isAxisAligned(sagittal, plane)).toBe(true);
    const image = sampleCrossSection(sagittal, plane);
    expect(image?.radiodensities).toBe(sagittal.slices[2].radiodensities);
  });

  it('reports patient-space centre and corners for an oblique acquisition', () => {
    const corners = volumeCorners(sagittal);
    const centre = volumeCentre(sagittal);
    expect(corners[0]).toEqual(toSagittal({ x: -4, y: 2, z: 10 }));
    expect(centre.x).toBeCloseTo(-(10 + 7.5 / 2), 9);
  });

  it('follows the shear of a gantry-tilted stack', () => {
    const tilted = makeVolume({
      width: 10,
      height: 10,
      depths: [0, 2, 4, 6, 8],
      shear: { x: 0, y: 0.3 },
      value: pattern,
    });
    const plane = buildMprPlanes({ x: 4, y: 5, z: 3 }, { x: 0, y: 0, z: 0, w: 1 }).coronal;
    const image = sampleCrossSection(tilted, plane)!;
    const geometry = image.geometry!;
    const centre = volumeCentre(tilted);
    let compared = 0;
    for (let row = 0; row < image.heightPixels; row++) {
      for (let col = 0; col < image.widthPixels; col++) {
        const u = geometry.uMinMm + col * geometry.spacingUMm;
        const v = geometry.vMinMm + row * geometry.spacingVMm;
        const point = {
          x: centre.x + plane.rightXyz.x * u + plane.downXyz.x * v,
          y: plane.positionXyz.y,
          z: centre.z + plane.rightXyz.z * u + plane.downXyz.z * v,
        };
        const expected = sampleVolumeAt(tilted, point);
        if (Number.isNaN(expected)) continue;
        expect(image.radiodensities[row * image.widthPixels + col]).toBeCloseTo(expected, 3);
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(30);
  });
});
