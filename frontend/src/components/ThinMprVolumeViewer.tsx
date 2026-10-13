import { useRef } from 'react';
import type { Volume } from '../api/types';
import { CanvasRenderer } from './CanvasRenderer';
import { useWheelDistanceScroll } from '../hooks/useWheelDistanceScroll';
import { useViewerInteractions } from '../hooks/useViewerInteractions';
import { useThinMprRadioDensities } from '../hooks/useThinMprRadioDensities';
import type { ViewablePlane } from '../utils/canvasMath';

interface ThinMprVolumeViewerProps {
  volume: Volume;
  viewablePlane: ViewablePlane;
  onViewablePlaneChange: (viewablePlane: ViewablePlane) => void;
  windowLevel: number;
  windowWidth: number;
  onWindowLevelChange: (level: number) => void;
  onWindowWidthChange: (width: number) => void;
}

export function ThinMprVolumeViewer({
  volume,
  viewablePlane,
  onViewablePlaneChange,
  windowLevel,
  windowWidth,
  onWindowLevelChange,
  onWindowWidthChange,
}: ThinMprVolumeViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const radioDensities = useThinMprRadioDensities(volume, viewablePlane);

  const { viewTransform, handlePointerEvent } = useViewerInteractions({
    windowLevel,
    windowWidth,
    onWindowLevelChange,
    onWindowWidthChange,
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
    />
  );
}
