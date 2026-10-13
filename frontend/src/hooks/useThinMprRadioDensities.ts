import { useCallback } from 'react';
import type { RadioDensities, Volume } from '../api/types';
import type { ViewablePlane } from '../utils/canvasMath';
import { isAxisAligned, planeFromParams, PREVIEW_SPACING_SCALE, sampleCrossSection } from '../utils/mprSampler';
import { usePlaneParams } from './usePlaneParams';
import { immediateJob, useProgressiveValue } from './useProgressiveValue';
import { useScrollDeferredParams } from './useScrollDeferredParams';

// Rotated planes show a coarser result first, then full quality once the plane stops changing.
export function useThinMprRadioDensities(volume: Volume, viewablePlane: ViewablePlane): RadioDensities | undefined {
  const params = useScrollDeferredParams(usePlaneParams(volume, viewablePlane));
  const oblique = !isAxisAligned(params);

  const computePreview = useCallback(
    () => sampleCrossSection(volume, planeFromParams(volume, params), oblique ? PREVIEW_SPACING_SCALE : 1),
    [volume, params, oblique]
  );
  const startFull = useCallback(
    () => immediateJob(() => sampleCrossSection(volume, planeFromParams(volume, params))),
    [volume, params]
  );

  return useProgressiveValue(computePreview, startFull, oblique);
}
