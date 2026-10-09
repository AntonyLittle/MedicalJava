import { Box } from '@mui/material';
import type { Volume } from '../api/types';
import { CanvasRenderer } from './CanvasRenderer';
import { SliceSlider } from './SliceSlider';
import { WindowLevelControls } from './WindowLevelControls';

interface VolumeViewerProps {
  volume: Volume;
  sliceIndex: number;
  onSliceIndexChange: (index: number) => void;
  windowLevel: number;
  windowWidth: number;
  onWindowLevelChange: (level: number) => void;
  onWindowWidthChange: (width: number) => void;
}

export function VolumeViewer({
  volume,
  sliceIndex,
  onSliceIndexChange,
  windowLevel,
  windowWidth,
  onWindowLevelChange,
  onWindowWidthChange,
}: VolumeViewerProps) {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
      <CanvasRenderer
        volume={volume}
        sliceIndex={sliceIndex}
        windowLevel={windowLevel}
        windowWidth={windowWidth}
        onSliceIndexChange={onSliceIndexChange}
        onWindowLevelChange={onWindowLevelChange}
        onWindowWidthChange={onWindowWidthChange}
      />
      <SliceSlider
        sliceCount={volume.slices.length}
        sliceIndex={sliceIndex}
        onChange={onSliceIndexChange}
      />
      <WindowLevelControls
        windowLevel={windowLevel}
        windowWidth={windowWidth}
        onLevelChange={onWindowLevelChange}
        onWidthChange={onWindowWidthChange}
      />
    </Box>
  );
}
