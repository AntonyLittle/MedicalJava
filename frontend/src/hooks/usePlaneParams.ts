import { useMemo } from 'react';
import type { Volume } from '../api/types';
import type { ViewablePlane } from '../utils/canvasMath';
import { planeParams, type PlaneParams } from '../utils/mprSampler';

// Keeps the result referentially stable while only irrelevant parts of the plane (e.g. in-plane position) change.
export function usePlaneParams(volume: Volume, viewablePlane: ViewablePlane): PlaneParams {
  const key = JSON.stringify(planeParams(volume, viewablePlane));
  return useMemo(() => JSON.parse(key) as PlaneParams, [key]);
}
