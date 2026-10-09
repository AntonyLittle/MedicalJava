import { Box, Slider, Typography } from '@mui/material';

interface WindowLevelControlsProps {
  windowLevel: number;
  windowWidth: number;
  onLevelChange: (level: number) => void;
  onWidthChange: (width: number) => void;
}

export function WindowLevelControls({
  windowLevel,
  windowWidth,
  onLevelChange,
  onWidthChange,
}: WindowLevelControlsProps) {
  return (
    <Box sx={{ width: '100%', px: 2, display: 'flex', gap: 4 }}>
      <Box sx={{ flex: 1 }}>
        <Typography gutterBottom>Window Level: {windowLevel}</Typography>
        <Slider
          min={-2000}
          max={2000}
          value={windowLevel}
          onChange={(_, value) => onLevelChange(value as number)}
        />
      </Box>
      <Box sx={{ flex: 1 }}>
        <Typography gutterBottom>Window Width: {windowWidth}</Typography>
        <Slider
          min={1}
          max={4000}
          value={windowWidth}
          onChange={(_, value) => onWidthChange(value as number)}
        />
      </Box>
    </Box>
  );
}
