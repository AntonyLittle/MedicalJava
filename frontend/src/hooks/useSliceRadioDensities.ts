import { useMemo } from 'react';
import type { RadioDensities, Volume } from '../api/types';

export function useSliceRadioDensities(volume: Volume, sliceIndex: number): RadioDensities | undefined {
  return useMemo(() => volume.slices[sliceIndex], [volume, sliceIndex]);
}
