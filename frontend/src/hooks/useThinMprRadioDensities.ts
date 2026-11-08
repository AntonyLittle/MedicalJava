import { useCallback } from 'react';
import type { RadioDensities, Volume } from '../api/types';
import type { ViewablePlane } from '../utils/canvasMath';
import { isAxisAligned, planeFromParams, PREVIEW_SPACING_SCALE, sampleCrossSection } from '../utils/mprSampler';
import { usePlaneParams } from './usePlaneParams';
import { immediateJob, useProgressiveValue } from './useProgressiveValue';
import { useScrollDeferredParams } from './useScrollDeferredParams';

// Rotated planes show a coarser result first, then full quality once the plane stops changing. CPU sampling, used when
// the GPU can't render the plane; nothing is computed while active is false.
export function useThinMprRadioDensities(
  volume: Volume,
  viewablePlane: ViewablePlane,
  active = true
): RadioDensities | undefined {
  const params = useScrollDeferredParams(usePlaneParams(volume, viewablePlane));
  const oblique = !isAxisAligned(volume, params);

  const computePreview = useCallback(
    () =>
      active ? sampleCrossSection(volume, planeFromParams(volume, params), oblique ? PREVIEW_SPACING_SCALE : 1) : undefined,
    [active, volume, params, oblique]
  );
  const startFull = useCallback(
    () => immediateJob(() => sampleCrossSection(volume, planeFromParams(volume, params))),
    [volume, params]
  );

  return useProgressiveValue(computePreview, startFull, active && oblique);
}
