import { useCallback } from 'react';
import type { RadioDensities, Volume } from '../api/types';
import type { ViewablePlane } from '../utils/canvasMath';
import {
  isAxisAligned,
  orientationFromNormal,
  planeFromParams,
  PREVIEW_SLAB_SAMPLES,
  PREVIEW_SPACING_SCALE,
  sampleSlab,
  slabSampleCount,
  type ProjectionMode,
} from '../utils/mprSampler';
import { usePlaneParams } from './usePlaneParams';
import { useProgressiveValue } from './useProgressiveValue';

// Returns a cheap low-quality result immediately, then the full-quality one once the inputs stop changing.
export function useThickMprRadioDensities(
  volume: Volume,
  viewablePlane: ViewablePlane,
  thicknessMm: number,
  mode: ProjectionMode
): RadioDensities | undefined {
  const params = usePlaneParams(volume, viewablePlane);
  const oblique = !isAxisAligned(params);
  const needsRefinement =
    volume.slices.length > 0 &&
    (oblique || slabSampleCount(volume, orientationFromNormal(params.normalXyz), thicknessMm) > PREVIEW_SLAB_SAMPLES);

  const computePreview = useCallback(
    () =>
      sampleSlab(volume, planeFromParams(volume, params), {
        thicknessMm,
        mode,
        maxSamples: PREVIEW_SLAB_SAMPLES,
        spacingScale: oblique ? PREVIEW_SPACING_SCALE : 1,
      }),
    [volume, params, thicknessMm, mode, oblique]
  );
  const computeFull = useCallback(
    () => sampleSlab(volume, planeFromParams(volume, params), { thicknessMm, mode }),
    [volume, params, thicknessMm, mode]
  );

  return useProgressiveValue(computePreview, computeFull, needsRefinement);
}
