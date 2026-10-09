import { Box, Slider, Typography } from '@mui/material';

interface SliceSliderProps {
  sliceCount: number;
  sliceIndex: number;
  onChange: (index: number) => void;
}

export function SliceSlider({ sliceCount, sliceIndex, onChange }: SliceSliderProps) {
  return (
    <Box sx={{ width: '100%', px: 2 }}>
      <Typography gutterBottom>
        Slice {sliceIndex + 1} of {sliceCount}
      </Typography>
      <Slider
        min={0}
        max={sliceCount - 1}
        value={sliceIndex}
        onChange={(_, value) => onChange(value as number)}
      />
    </Box>
  );
}
