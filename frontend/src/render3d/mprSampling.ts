import type { ImageGeometry, Volume } from '../api/types';
import type { Coordinate, ViewablePlane } from '../utils/canvasMath';
import { imageLayout, planeParams, volumeCentre, type ProjectionMode } from '../utils/mprSampler';
import { volumeGeometry } from '../utils/volumeGeometry';

// Slab sample spacing as a fraction of the smallest voxel spacing: finer for the settled image than while it moves.
export const SLAB_STEP_FACTOR = 0.5;
export const PREVIEW_SLAB_STEP_FACTOR = 1;

// Bounds the per-pixel loop for very thick slabs on finely sampled volumes.
export const MAX_GPU_SLAB_SAMPLES = 4096;

export interface SlabSettings {
  thicknessMm: number;
  mode: ProjectionMode;
}

// How an MPR image samples the volume, in patient space. Sample k of pixel (column, row) lies at
// origin + column·columnStep + row·rowStep + k·sampleStep; a pixel combines its samples inside the volume.
export interface MprSampling {
  widthPixels: number;
  heightPixels: number;
  geometry: ImageGeometry;
  origin: Coordinate;
  columnStep: Coordinate;
  rowStep: Coordinate;
  sampleStep: Coordinate;
  sampleCount: number;
  mode: ProjectionMode;
}

export interface MprSamplingOptions {
  slab?: SlabSettings | null;
  spacingScale?: number;
  stepFactor?: number;
}

function smallestSpacing(volume: Volume): number {
  const { spacingX, spacingY, depths } = volumeGeometry(volume);
  const last = depths.length - 1;
  const spacingZ = last > 0 ? depths[last] / last : Infinity;
  return Math.min(spacingX, spacingY, spacingZ);
}

function along(base: Coordinate, direction: Coordinate, distance: number): Coordinate {
  return { x: base.x + direction.x * distance, y: base.y + direction.y * distance, z: base.z + direction.z * distance };
}

function scaled(direction: Coordinate, s: number): Coordinate {
  return { x: direction.x * s, y: direction.y * s, z: direction.z * s };
}

// The image has the same pixel grid as the CPU sampler's for the plane. A slab is sampled evenly along the normal,
// from one face to the other, at about stepFactor × the smallest voxel spacing.
export function planMprSampling(volume: Volume, plane: ViewablePlane, options: MprSamplingOptions = {}): MprSampling {
  const { widthPixels, heightPixels, geometry } = imageLayout(volume, plane, options.spacingScale ?? 1);
  const { offsetMm } = planeParams(volume, plane);
  const { normalXyz: normal, rightXyz: right, downXyz: down } = plane;

  const centre = along(volumeCentre(volume), normal, offsetMm);
  let origin = along(along(centre, right, geometry.uMinMm), down, geometry.vMinMm);
  let sampleStep: Coordinate = { x: 0, y: 0, z: 0 };
  let sampleCount = 1;

  const slab = options.slab;
  const stepMm = smallestSpacing(volume) * (options.stepFactor ?? SLAB_STEP_FACTOR);
  if (slab && slab.thicknessMm >= stepMm) {
    sampleCount = Math.min(MAX_GPU_SLAB_SAMPLES, Math.floor(slab.thicknessMm / stepMm) + 1);
    origin = along(origin, normal, -slab.thicknessMm / 2);
    sampleStep = scaled(normal, slab.thicknessMm / (sampleCount - 1));
  }

  return {
    widthPixels,
    heightPixels,
    geometry,
    origin,
    columnStep: scaled(right, geometry.spacingUMm),
    rowStep: scaled(down, geometry.spacingVMm),
    sampleStep,
    sampleCount,
    mode: slab?.mode ?? 'average',
  };
}
