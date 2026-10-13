import { useMemo } from 'react';
import type { RadioDensities, Volume } from '../api/types';
import type { ViewablePlane } from '../utils/canvasMath';
import { sampleCrossSection } from '../utils/mprSampler';

export function useThinMprRadioDensities(volume: Volume, viewablePlane: ViewablePlane): RadioDensities | undefined {
  const { x, y, z } = viewablePlane.positionXyz;
  const { x: nx, y: ny, z: nz } = viewablePlane.normalXyz;

  return useMemo(
    () => sampleCrossSection(volume, { positionXyz: { x, y, z }, normalXyz: { x: nx, y: ny, z: nz } }),
    [volume, x, y, z, nx, ny, nz]
  );
}
