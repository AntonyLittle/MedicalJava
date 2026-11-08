import { Box, Slider, Typography } from '@mui/material';

// Level and width are in real units (e.g. HU); the sliders cover the loaded volume's value range.
interface WindowLevelControlsProps {
  windowLevel: number;
  windowWidth: number;
  minLevel: number;
  maxLevel: number;
  maxWidth: number;
  units: string;
  onLevelChange: (level: number) => void;
  onWidthChange: (width: number) => void;
}

function sliderStep(range: number): number {
  return range > 100 ? 1 : 10 ** Math.floor(Math.log10(Math.max(range, 1e-6) / 100));
}

function format(value: number, units: string): string {
  const text = Number.isInteger(value) ? `${value}` : value.toPrecision(4);
  return units ? `${text} ${units}` : text;
}

export function WindowLevelControls({
  windowLevel,
  windowWidth,
  minLevel,
  maxLevel,
  maxWidth,
  units,
  onLevelChange,
  onWidthChange,
}: WindowLevelControlsProps) {
  return (
    <Box sx={{ width: '100%', px: 2, display: 'flex', gap: 4 }}>
      <Box sx={{ flex: 1 }}>
        <Typography gutterBottom>Window Level: {format(windowLevel, units)}</Typography>
        <Slider
          min={minLevel}
          max={maxLevel}
          step={sliderStep(maxLevel - minLevel)}
          value={windowLevel}
          onChange={(_, value) => onLevelChange(value as number)}
        />
      </Box>
      <Box sx={{ flex: 1 }}>
        <Typography gutterBottom>Window Width: {format(windowWidth, units)}</Typography>
        <Slider
          min={sliderStep(maxWidth)}
          max={maxWidth}
          step={sliderStep(maxWidth)}
          value={windowWidth}
          onChange={(_, value) => onWidthChange(value as number)}
        />
      </Box>
    </Box>
  );
}
