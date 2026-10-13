import { useDeferredValue } from 'react';
import type { Coordinate } from '../utils/canvasMath';
import type { PlaneParams } from '../utils/mprSampler';

function sameCoordinate(a: Coordinate, b: Coordinate): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

// Scrolling only changes the offset, so resampling may lag and skip positions. Rotating changes the axes and must
// stay live: a deferred value is starved while input keeps arriving, which freezes the image until the drag pauses.
export function useScrollDeferredParams(params: PlaneParams): PlaneParams {
  const deferred = useDeferredValue(params);
  const sameAxes =
    sameCoordinate(params.normalXyz, deferred.normalXyz) &&
    sameCoordinate(params.rightXyz, deferred.rightXyz) &&
    sameCoordinate(params.downXyz, deferred.downXyz);
  return sameAxes ? deferred : params;
}
