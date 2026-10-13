import type { PointerEvent } from 'react';
import type { ViewTransform } from '../utils/canvasMath';
import { usePointerDragMode } from './usePointerDragMode';
import { useViewTransform } from './useViewTransform';
import { useWlwwDrag } from './useWlwwDrag';
import type { DragStarter } from './usePointerDragMode';

interface UseViewerInteractionsParams {
  windowLevel: number;
  windowWidth: number;
  onWindowLevelChange: (level: number) => void;
  onWindowWidthChange: (width: number) => void;
  startRotate?: DragStarter;
}

// Left drag = pan, right drag = zoom, left+right drag = window level/width, middle drag = rotate (if provided).
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
  const handlePointerEvent = usePointerDragMode({ 1: startPan, 2: startZoom, 3: startWlww, 4: params.startRotate });

  return { viewTransform, handlePointerEvent };
}
