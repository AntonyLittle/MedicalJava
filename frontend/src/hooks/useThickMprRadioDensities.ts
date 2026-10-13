import { useCallback } from 'react';
import type { RadioDensities, Volume } from '../api/types';
import type { ViewablePlane } from '../utils/canvasMath';
import {
  planeFromParams,
  PREVIEW_SLAB_SAMPLES,
  PREVIEW_SPACING_SCALE,
  sampleSlab,
  sampleSlabJob,
  type ProjectionMode,
} from '../utils/mprSampler';
import { usePlaneParams } from './usePlaneParams';
import { useProgressiveValue } from './useProgressiveValue';
import { useScrollDeferredParams } from './useScrollDeferredParams';

// Returns a half-resolution result immediately, then the full-quality one once the inputs stop changing.
export function useThickMprRadioDensities(
  volume: Volume,
  viewablePlane: ViewablePlane,
  thicknessMm: number,
  mode: ProjectionMode
): RadioDensities | undefined {
  const params = useScrollDeferredParams(usePlaneParams(volume, viewablePlane));
  const hasSlices = volume.slices.length > 0;

  const computePreview = useCallback(
    () =>
      sampleSlab(volume, planeFromParams(volume, params), {
        thicknessMm,
        mode,
        maxSamples: PREVIEW_SLAB_SAMPLES,
        spacingScale: PREVIEW_SPACING_SCALE,
      }),
    [volume, params, thicknessMm, mode]
  );
  const startFull = useCallback(
    () => sampleSlabJob(volume, planeFromParams(volume, params), { thicknessMm, mode }),
    [volume, params, thicknessMm, mode]
  );

  return useProgressiveValue(computePreview, startFull, hasSlices);
}
