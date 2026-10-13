import { useEffect, useMemo, useRef, type RefObject } from 'react';
import { clampToBounds, computeWheelSliceSteps, moveViewablePlaneForward } from '../utils/canvasMath';
import type { ViewablePlane } from '../utils/canvasMath';
import type { Volume } from '../api/types';
import { getVolumeBounds } from '../utils/mprSampler';

// React's synthetic onWheel is passive, so preventDefault() there can't stop page scroll;
// a native listener with { passive: false } is required instead.
export function useWheelDistanceScroll(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  viewablePlane: ViewablePlane,
  volume: Volume,
  onViewablePlaneChange: (viewablePlane: ViewablePlane) => void
): void {
  const wheelAccumRef = useRef(0);

  const bounds = useMemo(() => getVolumeBounds(volume), [volume]);

  // Kept fresh every render so the listener (registered once below) always sees current values.
  const viewablePlaneRef = useRef(viewablePlane);
  const boundsRef = useRef(bounds);
  const onViewablePlaneChangeRef = useRef(onViewablePlaneChange);
  useEffect(() => {
    viewablePlaneRef.current = viewablePlane;
    boundsRef.current = bounds;
    onViewablePlaneChangeRef.current = onViewablePlaneChange;
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    function handleWheel(e: WheelEvent) {
      e.preventDefault();
      wheelAccumRef.current += e.deltaY;
      const { steps, remainder } = computeWheelSliceSteps(wheelAccumRef.current);
      if (steps === 0) return;

      const moved = moveViewablePlaneForward(viewablePlaneRef.current, steps);
      const { min, max } = boundsRef.current;

      wheelAccumRef.current = remainder;
      onViewablePlaneChangeRef.current({
        positionXyz: clampToBounds(moved.positionXyz, min, max),
        normalXyz: { ...moved.normalXyz }
      });
    }

    canvas.addEventListener('wheel', handleWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', handleWheel);
  }, [canvasRef]);
}
