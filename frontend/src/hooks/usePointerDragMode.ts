import { useCallback, useEffect, useRef } from 'react';
import type { PointerEvent } from 'react';

// Called when a drag begins; returns the updater invoked for each subsequent pointer position.
export type DragStarter = (startX: number, startY: number) => (clientX: number, clientY: number) => void;

// Keyed by the PointerEvent `buttons` bitmask (1 = left, 2 = right, 3 = both).
export type DragStarters = Partial<Record<number, DragStarter>>;

export function usePointerDragMode(starters: DragStarters): (e: PointerEvent<HTMLCanvasElement>) => void {
  const dragUpdateRef = useRef<((clientX: number, clientY: number) => void) | null>(null);
  const lastButtonsRef = useRef(0);

  // Kept fresh every render so the stable handler below always starts drags with current values.
  const startersRef = useRef(starters);
  useEffect(() => {
    startersRef.current = starters;
  });

  // Pressing/releasing a secondary button while another is already held does not fire a new
  // pointerdown/pointerup (only pointermove with an updated `buttons` mask), so every pointer
  // event is routed through here to detect button-combination changes and re-anchor the drag.
  return useCallback((e: PointerEvent<HTMLCanvasElement>) => {
    if (e.buttons !== lastButtonsRef.current) {
      lastButtonsRef.current = e.buttons;
      dragUpdateRef.current = startersRef.current[e.buttons]?.(e.clientX, e.clientY) ?? null;
    }

    if (e.buttons === 0) {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } else {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
    }

    dragUpdateRef.current?.(e.clientX, e.clientY);
  }, []);
}
