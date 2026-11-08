import { describe, expect, it } from 'vitest';
import {
  acquisitionPlane,
  clampToVolume,
  sampleVolumeAt,
  toLocalPoint,
  toPatientPoint,
  voxelToPatient,
  volumeGeometry,
} from './volumeGeometry';
import { makeVolume } from './testVolumes';

const ramp = (i: number, j: number, k: number) => i + 10 * j + 100 * k;

function expectClose(actual: { x: number; y: number; z: number }, expected: { x: number; y: number; z: number }) {
  expect(actual.x).toBeCloseTo(expected.x, 9);
  expect(actual.y).toBeCloseTo(expected.y, 9);
  expect(actual.z).toBeCloseTo(expected.z, 9);
}

describe('volumeGeometry', () => {
  it('treats legacy volumes without orientation as axial stacks', () => {
    const volume = makeVolume({ width: 3, height: 2, depths: [0, 2, 4], origin: { x: -5, y: 7, z: 10 }, value: ramp });
    delete volume.rowDirection;
    delete volume.columnDirection;
    for (const slice of volume.slices) delete slice.positionXMm;

    const g = volumeGeometry(volume);
    expectClose(g.normal, { x: 0, y: 0, z: 1 });
    expect(g.depths).toEqual([0, 2, 4]);
    expect(g.depthStep).toBe(2);
    expectClose(g.bounds.min, { x: -5, y: 7, z: 10 });
    expectClose(g.bounds.max, { x: -3, y: 8, z: 14 });
    expect(acquisitionPlane(volume)).toBe('axial');
  });

  it('places a sagittal acquisition along its own axes', () => {
    // Rows run anterior→posterior (+y), columns superior→inferior (-z); the stack runs along -x.
    const volume = makeVolume({
      width: 4,
      height: 3,
      depths: [0, 1.5, 3],
      spacingX: 0.5,
      spacingY: 2,
      row: { x: 0, y: 1, z: 0 },
      column: { x: 0, y: 0, z: -1 },
      origin: { x: 10, y: -20, z: 30 },
      value: ramp,
    });
    const g = volumeGeometry(volume);

    expect(acquisitionPlane(volume)).toBe('sagittal');
    expectClose(g.normal, { x: -1, y: 0, z: 0 });
    expectClose(voxelToPatient(g, 3, 2, 3), { x: 7, y: -18.5, z: 26 });
    expectClose(g.bounds.min, { x: 7, y: -20, z: 26 });
    expectClose(g.bounds.max, { x: 10, y: -18.5, z: 30 });
    expect(sampleVolumeAt(volume, { x: 8.5, y: -19, z: 28 })).toBeCloseTo(ramp(2, 1, 1), 9);
  });

  it('round-trips points through an oblique frame', () => {
    const c = Math.cos(0.3);
    const s = Math.sin(0.3);
    const volume = makeVolume({
      width: 5,
      height: 5,
      depths: [0, 1, 2, 3],
      row: { x: c, y: s, z: 0 },
      column: { x: -s * c, y: c * c, z: s },
      origin: { x: 1, y: 2, z: 3 },
      value: ramp,
    });
    const g = volumeGeometry(volume);
    const p = { x: 4.2, y: -1.5, z: 7.75 };
    expectClose(toPatientPoint(g, toLocalPoint(g, p)), p);
    expect(acquisitionPlane(volume)).toBe('oblique');
  });

  it('detects gantry-tilt shear and samples through it', () => {
    const volume = makeVolume({
      width: 4,
      height: 4,
      depths: [0, 2, 4, 6],
      shear: { x: 0, y: 0.25 },
      value: ramp,
    });
    const g = volumeGeometry(volume);
    expect(g.sheared).toBe(true);
    expect(g.shear.y).toBeCloseTo(0.25, 12);
    // Voxel (1, 2) of slice 2 sits half a millimetre further along y per 2 mm of depth.
    expect(sampleVolumeAt(volume, { x: 1, y: 2 + 0.25 * 4, z: 4 })).toBeCloseTo(ramp(1, 2, 2), 9);
    expect(Number.isNaN(sampleVolumeAt(volume, { x: 1, y: -0.5, z: 6 }))).toBe(true);
  });

  it('clamps points to the volume in its own frame', () => {
    const volume = makeVolume({
      width: 3,
      height: 3,
      depths: [0, 1, 2],
      row: { x: 0, y: 1, z: 0 },
      column: { x: 0, y: 0, z: -1 },
      value: ramp,
    });
    expectClose(clampToVolume(volume, { x: 5, y: 1, z: -1 }), { x: 0, y: 1, z: -1 });
    expectClose(clampToVolume(volume, { x: -9, y: 9, z: 9 }), { x: -2, y: 2, z: 0 });
  });
});
