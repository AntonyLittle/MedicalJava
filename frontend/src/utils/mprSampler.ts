import type { RadioDensities, Slice, Volume } from '../api/types';
import type { Coordinate, ViewablePlane } from './canvasMath';

export type PlaneOrientation = 'axial' | 'coronal' | 'sagittal';

// Matches the padding value of the sample DICOM data (air = -2000).
export const OUTSIDE_VOLUME_VALUE = -2000;

const EPSILON = 1e-6;

export function orientationFromNormal(normal: Coordinate): PlaneOrientation {
  const ax = Math.abs(normal.x);
  const ay = Math.abs(normal.y);
  const az = Math.abs(normal.z);
  if (az >= ax && az >= ay) return 'axial';
  if (ay >= ax) return 'coronal';
  return 'sagittal';
}

// Extent of the voxel centres in patient coordinates (mm); assumes slices are sorted by depth and share an x/y origin.
export function getVolumeBounds(volume: Volume): { min: Coordinate; max: Coordinate } {
  const first = volume.slices[0];
  const depths = volume.slices.map((s) => s.depthPositionMm);
  return {
    min: { x: first.originXMm, y: first.originYMm, z: Math.min(...depths) },
    max: {
      x: first.originXMm + (first.widthPixels - 1) * first.pixelSpacingXMm,
      y: first.originYMm + (first.heightPixels - 1) * first.pixelSpacingYMm,
      z: Math.max(...depths),
    },
  };
}

// Fractional slice index for a depth, or NaN when outside the volume.
function depthToSliceCoordinate(depths: number[], z: number): number {
  const last = depths.length - 1;
  if (z < depths[0] - EPSILON || z > depths[last] + EPSILON) return NaN;
  if (last === 0) return 0;

  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (depths[mid] <= z) lo = mid;
    else hi = mid;
  }
  const span = depths[hi] - depths[lo];
  const t = span > 0 ? (z - depths[lo]) / span : 0;
  return Math.min(last, Math.max(0, lo + t));
}

function sampleTrilinear(slices: Slice[], fx: number, fy: number, fz: number): number {
  const width = slices[0].widthPixels;
  const height = slices[0].heightPixels;
  if (Number.isNaN(fz) || fx < -EPSILON || fy < -EPSILON || fx > width - 1 + EPSILON || fy > height - 1 + EPSILON) {
    return OUTSIDE_VOLUME_VALUE;
  }

  const x0 = Math.min(width - 1, Math.max(0, Math.floor(fx)));
  const y0 = Math.min(height - 1, Math.max(0, Math.floor(fy)));
  const z0 = Math.min(slices.length - 1, Math.floor(fz));
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const z1 = Math.min(slices.length - 1, z0 + 1);
  const tx = Math.min(1, Math.max(0, fx - x0));
  const ty = Math.min(1, Math.max(0, fy - y0));
  const tz = fz - z0;

  const bilinear = (data: number[]) => {
    const top = data[y0 * width + x0] * (1 - tx) + data[y0 * width + x1] * tx;
    const bottom = data[y1 * width + x0] * (1 - tx) + data[y1 * width + x1] * tx;
    return top * (1 - ty) + bottom * ty;
  };

  const near = bilinear(slices[z0].radiodensities);
  if (z1 === z0 || tz === 0) return near;
  return near * (1 - tz) + bilinear(slices[z1].radiodensities) * tz;
}

// Only the plane position along its dominant normal axis is used; in-plane axes are fixed per orientation.
export function sampleCrossSection(volume: Volume, viewablePlane: ViewablePlane): RadioDensities | undefined {
  const slices = volume.slices;
  if (slices.length === 0) return undefined;

  const first = slices[0];
  const { pixelSpacingXMm: sx, pixelSpacingYMm: sy } = first;
  const bounds = getVolumeBounds(volume);
  const depths = slices.map((s) => s.depthPositionMm);
  const orientation = orientationFromNormal(viewablePlane.normalXyz);
  const position = viewablePlane.positionXyz;

  // Square output pixels because CanvasRenderer scales both axes by the same factor.
  const outSpacing = Math.min(sx, sy);

  if (orientation === 'axial') {
    const fz = depthToSliceCoordinate(depths, position.z);
    if (Number.isNaN(fz)) return undefined;
    if (sx === sy && Math.abs(fz - Math.round(fz)) < EPSILON) return slices[Math.round(fz)];

    const outWidth = Math.floor((bounds.max.x - bounds.min.x) / outSpacing) + 1;
    const outHeight = Math.floor((bounds.max.y - bounds.min.y) / outSpacing) + 1;
    const out = new Array<number>(outWidth * outHeight);
    for (let row = 0; row < outHeight; row++) {
      for (let col = 0; col < outWidth; col++) {
        out[row * outWidth + col] = sampleTrilinear(slices, (col * outSpacing) / sx, (row * outSpacing) / sy, fz);
      }
    }
    return { widthPixels: outWidth, heightPixels: outHeight, radiodensities: out };
  }

  const alongX = orientation === 'coronal';
  const inPlaneMin = alongX ? bounds.min.x : bounds.min.y;
  const inPlaneMax = alongX ? bounds.max.x : bounds.max.y;
  const inPlaneSpacing = alongX ? sx : sy;
  const fixedCoord = alongX ? position.y : position.x;
  const fixedMin = alongX ? bounds.min.y : bounds.min.x;
  const fixedSpacing = alongX ? sy : sx;
  const fixedFraction = (fixedCoord - fixedMin) / fixedSpacing;

  const outWidth = Math.floor((inPlaneMax - inPlaneMin) / outSpacing) + 1;
  const outHeight = Math.floor((bounds.max.z - bounds.min.z) / outSpacing) + 1;
  const out = new Array<number>(outWidth * outHeight);

  for (let row = 0; row < outHeight; row++) {
    // Superior (higher z) at the top of the image.
    const z = bounds.max.z - row * outSpacing;
    const fz = depthToSliceCoordinate(depths, z);
    for (let col = 0; col < outWidth; col++) {
      const inPlaneFraction = (col * outSpacing) / inPlaneSpacing;
      const fx = alongX ? inPlaneFraction : fixedFraction;
      const fy = alongX ? fixedFraction : inPlaneFraction;
      out[row * outWidth + col] = sampleTrilinear(slices, fx, fy, fz);
    }
  }
  return { widthPixels: outWidth, heightPixels: outHeight, radiodensities: out };
}
