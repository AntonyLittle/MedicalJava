import { useCallback, useEffect, useRef } from 'react';
import type { PointerEvent } from 'react';
import type { DragAnchor, DragMode } from '../utils/canvasMath';

interface UsePointerDragModeParams {
  sliceIndex: number;
  windowLevel: number;
  windowWidth: number;
  onSliceDrag: (anchor: DragAnchor, clientY: number) => void;
  onWlwwDrag: (anchor: DragAnchor, clientX: number, clientY: number) => void;
}

export function usePointerDragMode(
  params: UsePointerDragModeParams
): (e: PointerEvent<HTMLCanvasElement>) => void {
  const dragModeRef = useRef<DragMode>(null);
  const dragAnchorRef = useRef<DragAnchor | null>(null);
  const lastButtonsRef = useRef(0);

  // Kept fresh every render so the stable handler below always anchors drags with current values.
  const sliceIndexRef = useRef(params.sliceIndex);
  const windowLevelRef = useRef(params.windowLevel);
  const windowWidthRef = useRef(params.windowWidth);
  const onSliceDragRef = useRef(params.onSliceDrag);
  const onWlwwDragRef = useRef(params.onWlwwDrag);
  useEffect(() => {
    sliceIndexRef.current = params.sliceIndex;
    windowLevelRef.current = params.windowLevel;
    windowWidthRef.current = params.windowWidth;
    onSliceDragRef.current = params.onSliceDrag;
    onWlwwDragRef.current = params.onWlwwDrag;
  });

  // Pressing/releasing a secondary button while another is already held does not fire a new
  // pointerdown/pointerup (only pointermove with an updated `buttons` mask), so every pointer
  // event is routed through here to detect button-combination changes and re-anchor the drag.
  return useCallback((e: PointerEvent<HTMLCanvasElement>) => {
    if (e.buttons !== lastButtonsRef.current) {
      lastButtonsRef.current = e.buttons;

      if (e.buttons === 1) {
        dragModeRef.current = 'slice';
        dragAnchorRef.current = {
          x: e.clientX,
          y: e.clientY,
          sliceIndex: sliceIndexRef.current,
          windowLevel: windowLevelRef.current,
          windowWidth: windowWidthRef.current,
        };
      } else if (e.buttons === 3) {
        dragModeRef.current = 'wlww';
        dragAnchorRef.current = {
          x: e.clientX,
          y: e.clientY,
          sliceIndex: sliceIndexRef.current,
          windowLevel: windowLevelRef.current,
          windowWidth: windowWidthRef.current,
        };
      } else {
        dragModeRef.current = null;
        dragAnchorRef.current = null;
      }
    }

    if (e.buttons === 0) {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } else {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
    }

    const mode = dragModeRef.current;
    const anchor = dragAnchorRef.current;
    if (!mode || !anchor) return;

    if (mode === 'slice') {
      onSliceDragRef.current(anchor, e.clientY);
    } else {
      onWlwwDragRef.current(anchor, e.clientX, e.clientY);
    }
  }, []);
}
