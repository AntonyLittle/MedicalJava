import { useCallback } from 'react';
import type { RadioDensities, Volume } from '../api/types';
import type { ViewablePlane } from '../utils/canvasMath';
import {
  fitSpacingScale,
  fullVolumeThicknessMm,
  planeFromParams,
  PREVIEW_SLAB_SAMPLES,
  PREVIEW_SPACING_SCALE,
  sampleSlab,
  type PlaneParams,
  type ProjectionMode,
} from '../utils/mprSampler';
import { usePlaneParams } from './usePlaneParams';
import { useProgressiveValue } from './useProgressiveValue';

// The canvas is 400 px, so a finer image only costs sampling time.
const MAX_OUTPUT_PIXELS = 512;

function projectVolume(volume: Volume, params: PlaneParams, mode: ProjectionMode, preview: boolean) {
  const plane = planeFromParams(volume, params);
  const baseScale = fitSpacingScale(volume, plane, MAX_OUTPUT_PIXELS);
  return sampleSlab(volume, plane, {
    thicknessMm: fullVolumeThicknessMm(volume, plane.normalXyz),
    mode,
    maxSamples: preview ? PREVIEW_SLAB_SAMPLES : undefined,
    spacingScale: preview ? baseScale * PREVIEW_SPACING_SCALE : baseScale,
  });
}

// Projects the whole volume along the camera plane's normal: coarse while the camera moves, full quality after.
export function useFullVolumeRadioDensities(
  volume: Volume,
  camera: ViewablePlane,
  mode: ProjectionMode
): RadioDensities | undefined {
  const params = usePlaneParams(volume, camera);
  const hasSlices = volume.slices.length > 0;

  const computePreview = useCallback(
    () => (hasSlices ? projectVolume(volume, params, mode, true) : undefined),
    [volume, params, mode, hasSlices]
  );
  const computeFull = useCallback(
    () => (hasSlices ? projectVolume(volume, params, mode, false) : undefined),
    [volume, params, mode, hasSlices]
  );

  return useProgressiveValue(computePreview, computeFull, hasSlices);
}
