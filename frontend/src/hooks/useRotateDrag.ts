import { useCallback } from 'react';
import { computeRotationFromDrag, type Quaternion, type ViewablePlane } from '../utils/canvasMath';
import type { DragStarter } from './usePointerDragMode';

// The rotation is anchored to the plane and frame at drag start so the axis stays fixed during the drag.
export function useRotateDrag(
  viewablePlane: ViewablePlane,
  rotation: Quaternion,
  onRotationChange: (rotation: Quaternion) => void
): DragStarter {
  return useCallback<DragStarter>(
    (startX) => {
      const startRotation = rotation;
      const startPlane = viewablePlane;
      return (clientX) => onRotationChange(computeRotationFromDrag(startRotation, startPlane, startX, clientX));
    },
    [viewablePlane, rotation, onRotationChange]
  );
}
