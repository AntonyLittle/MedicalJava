import { useMemo } from 'react';
import type { RadioDensities, Volume } from '../api/types';

// The acquired slice as stored; its pixel spacing keeps the aspect ratio right when rows and columns differ.
export function useSliceRadioDensities(volume: Volume, sliceIndex: number): RadioDensities | undefined {
  return useMemo(() => {
    const slice = volume.slices[sliceIndex];
    if (!slice) return undefined;
    return {
      widthPixels: slice.widthPixels,
      heightPixels: slice.heightPixels,
      radiodensities: slice.radiodensities,
      geometry: { uMinMm: 0, vMinMm: 0, spacingUMm: slice.pixelSpacingXMm, spacingVMm: slice.pixelSpacingYMm },
    };
  }, [volume, sliceIndex]);
}
