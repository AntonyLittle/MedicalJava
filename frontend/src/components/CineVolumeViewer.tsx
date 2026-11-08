import { memo, useCallback, useMemo, useRef } from 'react';
import type { PointerEvent } from 'react';
import type { Volume } from '../api/types';
import { CanvasRenderer } from './CanvasRenderer';
import { useWheelSliceScroll as useWheelScroll } from '../hooks/useWheelSliceScroll';
import { useViewerInteractions } from '../hooks/useViewerInteractions';
import { useSliceRadioDensities } from '../hooks/useSliceRadioDensities';
import { useSegmentationView } from '../hooks/useSegmentationView';
import { hasUniformSlices, sliceImageMapping } from '../segmentation/voxelSpace';

const CANVAS_SIZE = 400;

interface VolumeViewerProps {
  volume: Volume;
  sliceIndex: number;
  onSliceIndexChange: (index: number) => void;
  windowLevel: number;
  windowWidth: number;
  onWindowLevelChange: (level: number) => void;
  onWindowWidthChange: (width: number) => void;
}

export const CineVolumeViewer = memo(function CineVolumeViewer({
  volume,
  sliceIndex,
  onSliceIndexChange,
  windowLevel,
  windowWidth,
  onWindowLevelChange,
  onWindowWidthChange,
}: VolumeViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const maxSliceIndex = volume.slices.length - 1;
  const radioDensities = useSliceRadioDensities(volume, sliceIndex);

  const { viewTransform, handlePointerEvent } = useViewerInteractions({
    windowLevel,
    windowWidth,
    onWindowLevelChange,
    onWindowWidthChange,
  });
  useWheelScroll(canvasRef, sliceIndex, maxSliceIndex, onSliceIndexChange);

  const mapping = useMemo(
    () => (volume.slices[sliceIndex] && hasUniformSlices(volume) ? sliceImageMapping(volume, sliceIndex) : null),
    [volume, sliceIndex]
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
      windowLevel={windowLevel}
      windowWidth={windowWidth}
      viewTransform={viewTransform}
      onPointerDown={handleEvent}
      onPointerMove={handleEvent}
      onPointerUp={handleEvent}
      onPointerLeave={segmentation.handlePointerLeave}
      drawOverlay={segmentation.drawOverlay}
    />
  );
});
