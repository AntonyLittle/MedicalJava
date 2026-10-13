import { useEffect, useMemo, useRef, type RefObject } from 'react';
import { clampToBounds, computeWheelDistanceMm, moveViewablePlaneForward } from '../utils/canvasMath';
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
  const pendingDeltaRef = useRef(0);

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

    let frame: number | null = null;

    // Wheel events can arrive faster than frames render, so they are summed and applied once per frame.
    function applyPendingDelta() {
      frame = null;
      const distanceMm = computeWheelDistanceMm(pendingDeltaRef.current);
      pendingDeltaRef.current = 0;
      if (distanceMm === 0) return;

      const moved = moveViewablePlaneForward(viewablePlaneRef.current, distanceMm);
      const { min, max } = boundsRef.current;
      const next = { ...moved, positionXyz: clampToBounds(moved.positionXyz, min, max) };

      // The prop only catches up after React renders, so later frames must build on this value.
      viewablePlaneRef.current = next;
      onViewablePlaneChangeRef.current(next);
    }

    function handleWheel(e: WheelEvent) {
      e.preventDefault();
      pendingDeltaRef.current += e.deltaY;
      if (frame === null) frame = requestAnimationFrame(applyPendingDelta);
    }

    canvas.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      canvas.removeEventListener('wheel', handleWheel);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [canvasRef]);
}
