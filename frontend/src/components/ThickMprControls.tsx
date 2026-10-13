import { Box, Slider, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import type { ProjectionMode } from '../utils/mprSampler';

interface ThickMprControlsProps {
  slabThicknessMm: number;
  projectionMode: ProjectionMode;
  onSlabThicknessChange: (thicknessMm: number) => void;
  onProjectionModeChange: (mode: ProjectionMode) => void;
}

export function ThickMprControls({
  slabThicknessMm,
  projectionMode,
  onSlabThicknessChange,
  onProjectionModeChange,
}: ThickMprControlsProps) {
  return (
    <Box sx={{ width: '100%', px: 2, display: 'flex', gap: 4, alignItems: 'center' }}>
      <Box sx={{ flex: 1 }}>
        <Typography gutterBottom>Slab Thickness: {slabThicknessMm} mm</Typography>
        <Slider
          min={1}
          max={100}
          value={slabThicknessMm}
          onChange={(_, value) => onSlabThicknessChange(value as number)}
        />
      </Box>
      <ToggleButtonGroup
        exclusive
        size="small"
        value={projectionMode}
        onChange={(_, value: ProjectionMode | null) => value && onProjectionModeChange(value)}
      >
        <ToggleButton value="average">Avg</ToggleButton>
        <ToggleButton value="max">MIP</ToggleButton>
        <ToggleButton value="min">MinIP</ToggleButton>
      </ToggleButtonGroup>
    </Box>
  );
}
