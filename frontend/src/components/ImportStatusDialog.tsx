import {
  Alert,
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
import type { ImportStatus } from '../api/types';
import { formatScanSummary } from '../utils/formatScanSummary';

interface ImportStatusDialogProps {
  open: boolean;
  status: ImportStatus | null;
  onClose: () => void;
}

export function ImportStatusDialog({ open, status, onClose }: ImportStatusDialogProps) {
  const failures = status?.failures ?? [];
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md">
      <DialogTitle>Data folder import</DialogTitle>
      <DialogContent>
        {status?.running && (
          <Alert severity="info" sx={{ mb: 2 }}>
            An import is running.
          </Alert>
        )}
        <Typography variant="subtitle2">Last scan</Typography>
        <Typography gutterBottom>
          {formatScanSummary(status?.lastScan ?? null)}
          {status?.lastScan && (
            <Typography component="span" color="text.secondary">
              {' '}
              (finished {new Date(status.lastScan.finishedAt).toLocaleString()})
            </Typography>
          )}
        </Typography>

        <Typography variant="subtitle2" sx={{ mt: 2 }}>
          Failed folders
        </Typography>
        {failures.length === 0 ? (
          <Typography color="text.secondary">None.</Typography>
        ) : (
          <>
            <Typography variant="body2" color="text.secondary" gutterBottom>
              These folders are retried automatically once their files change.
            </Typography>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Folder</TableCell>
                  <TableCell>Error</TableCell>
                  <TableCell>Failed at</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {failures.map((failure) => (
                  <TableRow key={failure.sourcePath}>
                    <TableCell>{failure.sourcePath}</TableCell>
                    <TableCell>{failure.error}</TableCell>
                    {/* SQLite CURRENT_TIMESTAMP is UTC without a zone designator. */}
                    <TableCell>{new Date(`${failure.failedAt.replace(' ', 'T')}Z`).toLocaleString()}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
