import { useCallback } from 'react';
import { computeWindowLevelFromDrag, computeWindowWidthFromDrag, type DragAnchor } from '../utils/canvasMath';

export function useWlwwDrag(
  onWindowLevelChange: (level: number) => void,
  onWindowWidthChange: (width: number) => void
): (anchor: DragAnchor, clientX: number, clientY: number) => void {
  return useCallback(
    (anchor: DragAnchor, clientX: number, clientY: number) => {
      onWindowLevelChange(computeWindowLevelFromDrag(anchor, clientX));
      onWindowWidthChange(computeWindowWidthFromDrag(anchor, clientY));
    },
    [onWindowLevelChange, onWindowWidthChange]
  );
}
