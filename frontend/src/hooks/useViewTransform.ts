import { useCallback, useState } from 'react';
import { computePanFromDrag, computeZoomFromDrag, IDENTITY_VIEW_TRANSFORM, type ViewTransform } from '../utils/canvasMath';
import type { DragStarter } from './usePointerDragMode';

export function useViewTransform(): { viewTransform: ViewTransform; startPan: DragStarter; startZoom: DragStarter } {
  const [viewTransform, setViewTransform] = useState<ViewTransform>(IDENTITY_VIEW_TRANSFORM);

  const startPan = useCallback<DragStarter>(
    (startX, startY) => {
      const start = viewTransform;
      return (clientX, clientY) => setViewTransform(computePanFromDrag(start, startX, startY, clientX, clientY));
    },
    [viewTransform]
  );

  const startZoom = useCallback<DragStarter>(
    (_startX, startY) => {
      const start = viewTransform;
      return (_clientX, clientY) => setViewTransform(computeZoomFromDrag(start, startY, clientY));
    },
    [viewTransform]
  );

  return { viewTransform, startPan, startZoom };
}
