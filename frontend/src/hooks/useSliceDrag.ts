import { useCallback } from 'react';
import { computeSliceDragIndex, type DragAnchor } from '../utils/canvasMath';

export function useSliceDrag(
  maxSliceIndex: number,
  onSliceIndexChange: (index: number) => void
): (anchor: DragAnchor, clientY: number) => void {
  return useCallback(
    (anchor: DragAnchor, clientY: number) => {
      onSliceIndexChange(computeSliceDragIndex(anchor, clientY, maxSliceIndex));
    },
    [maxSliceIndex, onSliceIndexChange]
  );
}
