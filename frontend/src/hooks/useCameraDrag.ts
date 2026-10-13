import { useCallback } from 'react';
import { computeCameraRotationFromDrag, type Quaternion, type ViewablePlane } from '../utils/canvasMath';
import type { DragStarter } from './usePointerDragMode';

// The camera frame at drag start anchors the axes so they stay fixed during the drag.
export function useCameraDrag(
  camera: ViewablePlane,
  rotation: Quaternion,
  onRotationChange: (rotation: Quaternion) => void
): DragStarter {
  return useCallback<DragStarter>(
    (startX, startY) => {
      const startRotation = rotation;
      const startCamera = camera;
      return (clientX, clientY) =>
        onRotationChange(computeCameraRotationFromDrag(startRotation, startCamera, startX, startY, clientX, clientY));
    },
    [camera, rotation, onRotationChange]
  );
}
