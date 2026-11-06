import { useCallback, useMemo, useState } from 'react';
import { add, cameraFrame, scale, type CameraFrame, type OrbitCameraState, type Projection } from '../render3d/camera';
import {
  clamp,
  computeZoomFromDrag,
  IDENTITY_ROTATION,
  type Coordinate,
  type Quaternion,
  type ViewablePlane,
} from '../utils/canvasMath';
import { useCameraDrag } from './useCameraDrag';
import type { DragStarter } from './usePointerDragMode';

export const DEFAULT_ORBIT_CAMERA: OrbitCameraState = { rotation: IDENTITY_ROTATION, panMm: { x: 0, y: 0, z: 0 }, zoom: 1 };

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 16;
const WHEEL_ZOOM_PER_DELTA = 0.0015;

interface UseOrbitCameraParams {
  centre: Coordinate;
  // Radius of the sphere that fills the view at zoom 1.
  fitRadiusMm: number;
  // Canvas size in CSS pixels.
  width: number;
  height: number;
  projection: Projection;
}

// Orbit camera about the volume centre with rotate, pan and zoom drags plus wheel zoom.
export function useOrbitCamera({ centre, fitRadiusMm, width, height, projection }: UseOrbitCameraParams) {
  const [state, setState] = useState<OrbitCameraState>(DEFAULT_ORBIT_CAMERA);
  const frame = useMemo<CameraFrame>(
    () => cameraFrame(state, centre, fitRadiusMm, width / height, projection),
    [state, centre, fitRadiusMm, width, height, projection]
  );

  const setRotation = useCallback((rotation: Quaternion) => setState((s) => ({ ...s, rotation })), []);
  const dragPlane = useMemo<ViewablePlane>(
    () => ({ positionXyz: frame.target, normalXyz: frame.forward, rightXyz: frame.right, downXyz: frame.down }),
    [frame]
  );
  const startRotate = useCameraDrag(dragPlane, state.rotation, setRotation);

  // The target moves opposite to the drag so the volume follows the pointer.
  const startPan = useCallback<DragStarter>(
    (startX, startY) => {
      const startPanMm = state.panMm;
      const mmPerPixel = (2 * frame.halfHeightMm) / height;
      const { right, down } = frame;
      return (clientX, clientY) => {
        const shift = add(scale(right, (startX - clientX) * mmPerPixel), scale(down, (startY - clientY) * mmPerPixel));
        setState((s) => ({ ...s, panMm: add(startPanMm, shift) }));
      };
    },
    [frame, state.panMm, height]
  );

  const startZoom = useCallback<DragStarter>(
    (_startX, startY) => {
      const start = { panX: 0, panY: 0, zoom: state.zoom };
      return (_clientX, clientY) => setState((s) => ({ ...s, zoom: computeZoomFromDrag(start, startY, clientY).zoom }));
    },
    [state.zoom]
  );

  const zoomByWheel = useCallback((deltaY: number) => {
    setState((s) => ({ ...s, zoom: clamp(s.zoom * Math.exp(-deltaY * WHEEL_ZOOM_PER_DELTA), MIN_ZOOM, MAX_ZOOM) }));
  }, []);

  const reset = useCallback(() => setState(DEFAULT_ORBIT_CAMERA), []);

  return { frame, startRotate, startPan, startZoom, zoomByWheel, reset };
}
