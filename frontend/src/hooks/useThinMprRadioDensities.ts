import { useMemo } from 'react';
import type { RadioDensities, Volume } from '../api/types';
import type { ViewablePlane } from '../utils/canvasMath';
import { planeFromOrientation, planeOrientationAndOffset, sampleCrossSection } from '../utils/mprSampler';

export function useThinMprRadioDensities(volume: Volume, viewablePlane: ViewablePlane): RadioDensities | undefined {
  const { orientation, offsetMm } = planeOrientationAndOffset(viewablePlane);

  return useMemo(
    () => sampleCrossSection(volume, planeFromOrientation(orientation, offsetMm)),
    [volume, orientation, offsetMm]
  );
}
