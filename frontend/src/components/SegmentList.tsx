import { Box, Button, Checkbox, IconButton, Radio, TextField, Tooltip, Typography } from '@mui/material';
import type { SegmentationSession } from '../segmentation/session';

interface SegmentListProps {
  session: SegmentationSession;
  // Approximate millilitres per voxel, for live segment volumes.
  voxelMl: number;
  disabled: boolean;
  onRemove: (label: number) => void;
}

function formatMl(ml: number): string {
  if (ml === 0) return '0 mL';
  return ml >= 100 ? `${Math.round(ml)} mL` : `${ml.toPrecision(3)} mL`;
}

const ALGORITHM_LABELS = { MANUAL: 'manual', SEMIAUTOMATIC: 'semi-automatic', AUTOMATIC: 'automatic' } as const;

// The segment table: the active segment (which tools paint), visibility, colour, name and current volume.
export function SegmentList({ session, voxelMl, disabled, onRemove }: SegmentListProps) {
  const { segments, labelmap } = session;
  const allVisible = segments.every((s) => s.visible);
  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography variant="caption" color="text.secondary" sx={{ flexGrow: 1 }}>
          Segments ({segments.length})
        </Typography>
        {segments.length > 1 && (
          <Button size="small" onClick={() => session.setAllVisible(!allVisible)}>
            {allVisible ? 'Hide all' : 'Show all'}
          </Button>
        )}
        <Button size="small" disabled={disabled} onClick={() => session.addSegment()}>
          Add segment
        </Button>
      </Box>
      <Box sx={{ maxHeight: 260, overflowY: 'auto' }}>
        {segments.map((segment) => (
          <Box key={segment.label} sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <Tooltip title="Active segment (tools paint it)">
              <Radio
                size="small"
                checked={session.activeLabel === segment.label}
                onChange={() => session.setActive(segment.label)}
              />
            </Tooltip>
            <Tooltip title={segment.visible ? 'Hide' : 'Show'}>
              <Checkbox
                size="small"
                checked={segment.visible}
                onChange={(_, checked) => session.setSegment(segment.label, { visible: checked })}
              />
            </Tooltip>
            <Tooltip title="Colour">
              <Box
                component="input"
                type="color"
                value={segment.color}
                disabled={disabled}
                onChange={(e) => session.setSegment(segment.label, { color: (e.target as HTMLInputElement).value })}
                sx={{ width: 28, height: 24, p: 0, border: 'none', background: 'none', cursor: 'pointer' }}
              />
            </Tooltip>
            <TextField
              size="small"
              variant="standard"
              value={segment.name}
              disabled={disabled}
              onChange={(e) => session.setSegment(segment.label, { name: e.target.value })}
              sx={{ flexGrow: 1, minWidth: 80 }}
            />
            <Tooltip title={`Label ${segment.label}, ${ALGORITHM_LABELS[segment.algorithmType]}`}>
              <Typography variant="body2" color="text.secondary" sx={{ width: 72, textAlign: 'right' }}>
                {formatMl(labelmap.counts[segment.label] * voxelMl)}
              </Typography>
            </Tooltip>
            <Tooltip title="Remove the segment and its voxels">
              <span>
                <IconButton size="small" disabled={disabled} onClick={() => onRemove(segment.label)}>
                  ×
                </IconButton>
              </span>
            </Tooltip>
          </Box>
        ))}
        {segments.length === 0 && (
          <Typography variant="body2" color="text.secondary">
            No segments yet. Add one to start painting.
          </Typography>
        )}
      </Box>
    </Box>
  );
}
