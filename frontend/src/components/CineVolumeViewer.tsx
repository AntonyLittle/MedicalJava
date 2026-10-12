import { useRef } from 'react';
import type { Volume } from '../api/types';
import { CanvasRenderer } from './CanvasRenderer';
import { useWheelSliceScroll as useWheelScroll } from '../hooks/useWheelSliceScroll';
import { useSliceDrag } from '../hooks/useSliceDrag';
import { useWlwwDrag } from '../hooks/useWlwwDrag';
import { usePointerDragMode } from '../hooks/usePointerDragMode';
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

export function CineVolumeViewer({
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

  const computeSliceDrag = useSliceDrag(maxSliceIndex, onSliceIndexChange);
  const computeWlwwDrag = useWlwwDrag(onWindowLevelChange, onWindowWidthChange);
  const handlePointerEvent = usePointerDragMode({
    sliceIndex,
    windowLevel,
    windowWidth,
    onSliceDrag: computeSliceDrag,
    onWlwwDrag: computeWlwwDrag,
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
      onPointerDown={handlePointerEvent}
      onPointerMove={handlePointerEvent}
      onPointerUp={handlePointerEvent}
    />
  );
}
