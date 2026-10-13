import { useCallback } from 'react';
import { computeWindowLevelFromDrag, computeWindowWidthFromDrag } from '../utils/canvasMath';
import type { DragStarter } from './usePointerDragMode';

export function useWlwwDrag(
  windowLevel: number,
  windowWidth: number,
  onWindowLevelChange: (level: number) => void,
  onWindowWidthChange: (width: number) => void
): DragStarter {
  return useCallback<DragStarter>(
    (startX, startY) => {
      const startLevel = windowLevel;
      const startWidth = windowWidth;
      return (clientX, clientY) => {
        onWindowLevelChange(computeWindowLevelFromDrag(startLevel, startX, clientX));
        onWindowWidthChange(computeWindowWidthFromDrag(startWidth, startY, clientY));
      };
    },
    [windowLevel, windowWidth, onWindowLevelChange, onWindowWidthChange]
  );
}
