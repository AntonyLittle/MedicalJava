import { useEffect, useRef, type RefObject } from 'react';
import { clamp, computeWheelSliceSteps } from '../utils/canvasMath';

// React's synthetic onWheel is passive, so preventDefault() there can't stop page scroll;
// a native listener with { passive: false } is required instead.
export function useWheelSliceScroll(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  sliceIndex: number,
  maxSliceIndex: number,
  onSliceIndexChange: (index: number) => void
): void {
  const wheelAccumRef = useRef(0);

  // Kept fresh every render so the listener (registered once below) always sees current values.
  const sliceIndexRef = useRef(sliceIndex);
  const maxSliceIndexRef = useRef(maxSliceIndex);
  const onSliceIndexChangeRef = useRef(onSliceIndexChange);
  useEffect(() => {
    sliceIndexRef.current = sliceIndex;
    maxSliceIndexRef.current = maxSliceIndex;
    onSliceIndexChangeRef.current = onSliceIndexChange;
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    function handleWheel(e: WheelEvent) {
      e.preventDefault();
      wheelAccumRef.current += e.deltaY;
      const { steps, remainder } = computeWheelSliceSteps(wheelAccumRef.current);
      if (steps === 0) return;

      wheelAccumRef.current = remainder;
      onSliceIndexChangeRef.current(clamp(sliceIndexRef.current + steps, 0, maxSliceIndexRef.current));
    }

    canvas.addEventListener('wheel', handleWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', handleWheel);
  }, [canvasRef]);
}
