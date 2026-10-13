import { memo, useRef } from 'react';
import type { Volume } from '../api/types';
import { CanvasRenderer } from './CanvasRenderer';
import { useWheelSliceScroll as useWheelScroll } from '../hooks/useWheelSliceScroll';
import { useViewerInteractions } from '../hooks/useViewerInteractions';
import { useSliceRadioDensities } from '../hooks/useSliceRadioDensities';

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
});
