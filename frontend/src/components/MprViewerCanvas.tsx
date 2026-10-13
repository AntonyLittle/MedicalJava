import { useRef } from 'react';
import type { RadioDensities, Volume } from '../api/types';
import { CanvasRenderer } from './CanvasRenderer';
import { useWheelDistanceScroll } from '../hooks/useWheelDistanceScroll';
import { useViewerInteractions } from '../hooks/useViewerInteractions';
import { useRotateDrag } from '../hooks/useRotateDrag';
import { IDENTITY_ROTATION, type Quaternion, type ViewablePlane } from '../utils/canvasMath';

export interface MprViewerCanvasProps {
  volume: Volume;
  viewablePlane: ViewablePlane;
  onViewablePlaneChange: (viewablePlane: ViewablePlane) => void;
  mprRotation: Quaternion;
  onMprRotationChange: (rotation: Quaternion) => void;
  windowLevel: number;
  windowWidth: number;
  onWindowLevelChange: (level: number) => void;
  onWindowWidthChange: (width: number) => void;
}

export function MprViewerCanvas({
  radioDensities,
  volume,
  viewablePlane,
  onViewablePlaneChange,
  mprRotation,
  onMprRotationChange,
  windowLevel,
  windowWidth,
  onWindowLevelChange,
  onWindowWidthChange,
}: MprViewerCanvasProps & { radioDensities: RadioDensities | undefined }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const startRotate = useRotateDrag(viewablePlane, mprRotation, onMprRotationChange);
  const { viewTransform, handlePointerEvent } = useViewerInteractions({
    windowLevel,
    windowWidth,
    onWindowLevelChange,
    onWindowWidthChange,
    startRotate,
  });
  useWheelDistanceScroll(canvasRef, viewablePlane, volume, onViewablePlaneChange);

  return (
    <CanvasRenderer
      ref={canvasRef}
      width={400}
      height={400}
      radioDensities={radioDensities}
      windowLevel={windowLevel}
      windowWidth={windowWidth}
      viewTransform={viewTransform}
      onPointerDown={handlePointerEvent}
      onPointerMove={handlePointerEvent}
      onPointerUp={handlePointerEvent}
      onDoubleClick={() => onMprRotationChange(IDENTITY_ROTATION)}
    />
  );
}
