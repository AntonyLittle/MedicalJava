import { useCallback, useContext } from 'react';
import { computeWindowLevelFromDrag, computeWindowWidthFromDrag } from '../utils/canvasMath';
import type { DragStarter } from './usePointerDragMode';
import { WindowDragScaleContext } from './windowDragScale';

export function useWlwwDrag(
  windowLevel: number,
  windowWidth: number,
  onWindowLevelChange: (level: number) => void,
  onWindowWidthChange: (width: number) => void
): DragStarter {
  const scale = useContext(WindowDragScaleContext);
  return useCallback<DragStarter>(
    (startX, startY) => {
      const startLevel = windowLevel;
      const startWidth = windowWidth;
      return (clientX, clientY) => {
        onWindowLevelChange(computeWindowLevelFromDrag(startLevel, startX, clientX, scale));
        onWindowWidthChange(computeWindowWidthFromDrag(startWidth, startY, clientY, scale));
      };
    },
    [windowLevel, windowWidth, onWindowLevelChange, onWindowWidthChange, scale]
  );
}
