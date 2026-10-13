import { useEffect, useMemo, useState } from 'react';
import type { RadioDensities, Volume } from '../api/types';
import type { ViewablePlane } from '../utils/canvasMath';
import {
  planeFromOrientation,
  planeOrientationAndOffset,
  PREVIEW_SLAB_SAMPLES,
  sampleSlab,
  slabSampleCount,
  type ProjectionMode,
} from '../utils/mprSampler';

const REFINE_DELAY_MS = 150;

interface RefinedResult {
  volume: Volume;
  key: string;
  value: RadioDensities | undefined;
}

// Returns a cheap low-sample result immediately, then the full-quality one once the inputs stop changing.
export function useThickMprRadioDensities(
  volume: Volume,
  viewablePlane: ViewablePlane,
  thicknessMm: number,
  mode: ProjectionMode
): RadioDensities | undefined {
  const { orientation, offsetMm } = planeOrientationAndOffset(viewablePlane);
  const key = `${orientation}|${offsetMm}|${thicknessMm}|${mode}`;
  const needsRefinement =
    volume.slices.length > 0 && slabSampleCount(volume, orientation, thicknessMm) > PREVIEW_SLAB_SAMPLES;

  const preview = useMemo(
    () =>
      sampleSlab(volume, planeFromOrientation(orientation, offsetMm), {
        thicknessMm,
        mode,
        maxSamples: PREVIEW_SLAB_SAMPLES,
      }),
    [volume, orientation, offsetMm, thicknessMm, mode]
  );

  const [refined, setRefined] = useState<RefinedResult>();
  useEffect(() => {
    if (!needsRefinement) return;
    const timer = setTimeout(() => {
      const value = sampleSlab(volume, planeFromOrientation(orientation, offsetMm), { thicknessMm, mode });
      setRefined({ volume, key, value });
    }, REFINE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [needsRefinement, volume, key, orientation, offsetMm, thicknessMm, mode]);

  return needsRefinement && refined?.volume === volume && refined.key === key ? refined.value : preview;
}
