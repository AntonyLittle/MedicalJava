import type { PointerEvent } from 'react';
import type { ViewTransform } from '../utils/canvasMath';
import { usePointerDragMode } from './usePointerDragMode';
import { useViewTransform } from './useViewTransform';
import { useWlwwDrag } from './useWlwwDrag';

interface UseViewerInteractionsParams {
  windowLevel: number;
  windowWidth: number;
  onWindowLevelChange: (level: number) => void;
  onWindowWidthChange: (width: number) => void;
}

// Left drag = pan, right drag = zoom, left+right drag = window level/width.
export function useViewerInteractions(params: UseViewerInteractionsParams): {
  viewTransform: ViewTransform;
  handlePointerEvent: (e: PointerEvent<HTMLCanvasElement>) => void;
} {
  const { viewTransform, startPan, startZoom } = useViewTransform();
  const startWlww = useWlwwDrag(
    params.windowLevel,
    params.windowWidth,
    params.onWindowLevelChange,
    params.onWindowWidthChange
  );
  const handlePointerEvent = usePointerDragMode({ 1: startPan, 2: startZoom, 3: startWlww });

  return { viewTransform, handlePointerEvent };
}
