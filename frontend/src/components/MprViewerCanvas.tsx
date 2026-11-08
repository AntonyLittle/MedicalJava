import { useCallback, useMemo, useRef } from 'react';
import type { PointerEvent } from 'react';
import type { RadioDensities, Volume } from '../api/types';
import { CanvasRenderer, type PaintedImage } from './CanvasRenderer';
import { useWheelDistanceScroll } from '../hooks/useWheelDistanceScroll';
import { useViewerInteractions } from '../hooks/useViewerInteractions';
import { useRotateDrag } from '../hooks/useRotateDrag';
import { usePlaneParams } from '../hooks/usePlaneParams';
import { useSegmentationView } from '../hooks/useSegmentationView';
import { mprImageMapping } from '../segmentation/voxelSpace';
import { IDENTITY_ROTATION, type Quaternion, type ViewablePlane } from '../utils/canvasMath';
import { MPR_COLOR_BY_ORIENTATION } from '../utils/mprColors';
import { planeFromParams, type PlaneOrientation } from '../utils/mprSampler';

const CANVAS_SIZE = 400;

export interface MprViewerCanvasProps {
  volume: Volume;
  orientation: PlaneOrientation;
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
  image,
  volume,
  orientation,
  viewablePlane,
  onViewablePlaneChange,
  mprRotation,
  onMprRotationChange,
  windowLevel,
  windowWidth,
  onWindowLevelChange,
  onWindowWidthChange,
}: MprViewerCanvasProps & { radioDensities: RadioDensities | undefined; image?: PaintedImage }) {
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

  // Thick views show the labels on their centre plane.
  const shown = image ?? radioDensities;
  const params = usePlaneParams(volume, viewablePlane);
  const widthPixels = shown?.widthPixels;
  const heightPixels = shown?.heightPixels;
  const geometry = shown?.geometry;
  const mapping = useMemo(
    () =>
      widthPixels && heightPixels && geometry
        ? mprImageMapping(volume, planeFromParams(volume, params), { widthPixels, heightPixels, geometry })
        : null,
    [volume, params, widthPixels, heightPixels, geometry]
  );
  const segmentation = useSegmentationView({
    volume,
    mapping,
    canvasWidth: CANVAS_SIZE,
    canvasHeight: CANVAS_SIZE,
    viewTransform,
  });
  const { handlePointer } = segmentation;
  const handleEvent = useCallback(
    (e: PointerEvent<HTMLCanvasElement>) => {
      if (!handlePointer(e)) handlePointerEvent(e);
    },
    [handlePointer, handlePointerEvent]
  );

  return (
    <CanvasRenderer
      ref={canvasRef}
      width={CANVAS_SIZE}
      height={CANVAS_SIZE}
      radioDensities={radioDensities}
      image={image}
      windowLevel={windowLevel}
      windowWidth={windowWidth}
      viewTransform={viewTransform}
      borderColor={MPR_COLOR_BY_ORIENTATION[orientation]}
      onPointerDown={handleEvent}
      onPointerMove={handleEvent}
      onPointerUp={handleEvent}
      onPointerLeave={segmentation.handlePointerLeave}
      drawOverlay={segmentation.drawOverlay}
      onDoubleClick={() => onMprRotationChange(IDENTITY_ROTATION)}
    />
  );
}
