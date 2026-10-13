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
    (_startX, startY) => {
      const startRotation = rotation;
      const startPlane = viewablePlane;
      return (_clientX, clientY) => onRotationChange(computeRotationFromDrag(startRotation, startPlane, startY, clientY));
    },
    [viewablePlane, rotation, onRotationChange]
  );
}
