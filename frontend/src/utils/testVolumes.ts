import type { Slice, Volume } from '../api/types';
import type { Coordinate } from './canvasMath';

export interface TestVolumeOptions {
  width: number;
  height: number;
  depths: number[];
  spacingX?: number;
  spacingY?: number;
  row?: Coordinate;
  column?: Coordinate;
  origin?: Coordinate;
  // In-plane offset (along row, column) per mm of depth.
  shear?: { x: number; y: number };
  value: (i: number, j: number, k: number) => number;
}

function cross(a: Coordinate, b: Coordinate): Coordinate {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

// A volume as the server would send it: slices ordered along row × column, with positions and legacy fields.
export function makeVolume(options: TestVolumeOptions): Volume {
  const { width, height, depths } = options;
  const sx = options.spacingX ?? 1;
  const sy = options.spacingY ?? 1;
  const row = options.row ?? { x: 1, y: 0, z: 0 };
  const column = options.column ?? { x: 0, y: 1, z: 0 };
  const origin = options.origin ?? { x: 0, y: 0, z: 0 };
  const shear = options.shear ?? { x: 0, y: 0 };
  const normal = cross(row, column);

  const slices: Slice[] = depths.map((d, k) => {
    const position = {
      x: origin.x + normal.x * d + row.x * shear.x * d + column.x * shear.y * d,
      y: origin.y + normal.y * d + row.y * shear.x * d + column.y * shear.y * d,
      z: origin.z + normal.z * d + row.z * shear.x * d + column.z * shear.y * d,
    };
    const radiodensities = new Int16Array(width * height);
    for (let j = 0; j < height; j++) {
      for (let i = 0; i < width; i++) radiodensities[j * width + i] = options.value(i, j, k);
    }
    return {
      sliceId: k,
      volumeId: 1,
      patientId: 1,
      index: k,
      widthPixels: width,
      heightPixels: height,
      widthMm: width * sx,
      heightMm: height * sy,
      depthPositionMm: normal.x * position.x + normal.y * position.y + normal.z * position.z,
      originXMm: position.x,
      originYMm: position.y,
      pixelSpacingXMm: sx,
      pixelSpacingYMm: sy,
      positionXMm: position.x,
      positionYMm: position.y,
      positionZMm: position.z,
      radiodensities,
    };
  });

  return {
    volumeId: 1,
    patientId: 1,
    name: 'test',
    modality: 'CT',
    slices,
    rowDirection: [row.x, row.y, row.z],
    columnDirection: [column.x, column.y, column.z],
    valueSlope: 1,
    valueIntercept: 0,
    valueUnits: 'HU',
    formatVersion: 1,
  };
}
