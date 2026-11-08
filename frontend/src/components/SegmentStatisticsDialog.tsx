import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import type { Volume } from '../api/types';
import type { LabelStatistics } from '../segmentation/algorithms';
import type { SegmentationSession } from '../segmentation/session';
import { toRealValue, valueSlope, valueUnits } from '../utils/volumeValues';

interface SegmentStatisticsDialogProps {
  open: boolean;
  volume: Volume;
  session: SegmentationSession | null;
  statistics: LabelStatistics[] | null;
  onClose: () => void;
}

function format(value: number): string {
  return Math.abs(value) >= 100 ? value.toFixed(0) : value.toPrecision(3);
}

export function SegmentStatisticsDialog({ open, volume, session, statistics, onClose }: SegmentStatisticsDialogProps) {
  const units = valueUnits(volume);
  const unitSuffix = units ? ` (${units})` : '';
  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>Segment statistics</DialogTitle>
      <DialogContent>
        {statistics && statistics.length === 0 && <Typography>No segment has any voxels yet.</Typography>}
        {statistics && statistics.length > 0 && (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Segment</TableCell>
                <TableCell align="right">Voxels</TableCell>
                <TableCell align="right">Volume (mL)</TableCell>
                <TableCell align="right">Mean{unitSuffix}</TableCell>
                <TableCell align="right">SD</TableCell>
                <TableCell align="right">Min</TableCell>
                <TableCell align="right">Max</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {statistics.map((s) => {
                const segment = session?.segmentFor(s.label);
                return (
                  <TableRow key={s.label}>
                    <TableCell>
                      <span
                        style={{
                          display: 'inline-block',
                          width: 10,
                          height: 10,
                          marginRight: 6,
                          background: segment?.color ?? '#999',
                        }}
                      />
                      {segment?.name ?? `Label ${s.label}`}
                    </TableCell>
                    <TableCell align="right">{s.voxelCount.toLocaleString()}</TableCell>
                    <TableCell align="right">{format(s.volumeMl)}</TableCell>
                    <TableCell align="right">{format(toRealValue(volume, s.mean))}</TableCell>
                    <TableCell align="right">{format(s.standardDeviation * valueSlope(volume))}</TableCell>
                    <TableCell align="right">{format(toRealValue(volume, s.min))}</TableCell>
                    <TableCell align="right">{format(toRealValue(volume, s.max))}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          Includes unsaved edits. Each slice's voxels are as thick as the slice's share of the stack.
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
