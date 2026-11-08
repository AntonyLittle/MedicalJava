import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  LinearProgress,
  Radio,
  RadioGroup,
  TextField,
  Typography,
} from '@mui/material';
import { fetchSegmentationJob, fetchSegmentationModels, startAutoSegmentation } from '../api/client';
import type { SegmentationJob, SegmentationModelList, Volume } from '../api/types';

const POLL_INTERVAL_MS = 2000;

interface AutoSegmentationDialogProps {
  open: boolean;
  volume: Volume;
  onClose: () => void;
  // The new segmentation's id once the job succeeded.
  onFinished: (segmentationId: number) => void;
}

function elapsed(job: SegmentationJob): string {
  const start = Date.parse(job.startedAt ?? job.createdAt);
  const end = job.finishedAt ? Date.parse(job.finishedAt) : Date.now();
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

// Picks a model on the segmentation worker, starts it on the volume and follows the job until it finishes. Closing
// the dialog leaves the job running on the server.
export function AutoSegmentationDialog({ open, volume, onClose, onFinished }: AutoSegmentationDialogProps) {
  const [models, setModels] = useState<SegmentationModelList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [model, setModel] = useState('');
  const [name, setName] = useState('');
  const [job, setJob] = useState<SegmentationJob | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetchSegmentationModels()
      .then((list) => {
        if (cancelled) return;
        setModels(list);
        setLoadError(null);
        setModel((current) => current || list.models.find((m) => m.available)?.id || '');
      })
      .catch((e) => !cancelled && setLoadError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [open]);

  const jobId = job?.jobId;
  const running = job?.state === 'queued' || job?.state === 'running';
  useEffect(() => {
    if (!jobId || !running) return;
    const timer = setInterval(() => {
      fetchSegmentationJob(jobId)
        .then((next) => {
          setJob(next);
          if (next.state === 'succeeded' && next.segmentationId != null) onFinished(next.segmentationId);
        })
        .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [jobId, running, onFinished]);

  const start = async () => {
    setError(null);
    try {
      setJob(await startAutoSegmentation(volume.patientId, volume.volumeId, model, name.trim() || undefined));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const close = () => {
    if (!running) setJob(null);
    onClose();
  };

  return (
    <Dialog open={open} onClose={close} maxWidth="sm" fullWidth>
      <DialogTitle>Automatic segmentation</DialogTitle>
      <DialogContent>
        {!models && !loadError && <CircularProgress size={24} />}
        {loadError && <Alert severity="error">{loadError}</Alert>}
        {models && !models.workerAvailable && (
          <Alert severity="warning">
            {models.error ?? 'The segmentation worker is not available.'}
          </Alert>
        )}
        {models?.workerAvailable && (
          <>
            <RadioGroup value={model} onChange={(e) => setModel(e.target.value)}>
              {models.models.map((m) => (
                <FormControlLabel
                  key={m.id}
                  value={m.id}
                  disabled={!m.available || running}
                  control={<Radio size="small" />}
                  label={
                    <>
                      <Typography variant="body1">{m.name}</Typography>
                      <Typography variant="body2" color="text.secondary">
                        {m.available ? m.description : m.unavailableReason}
                      </Typography>
                    </>
                  }
                  sx={{ alignItems: 'flex-start', mb: 1 }}
                />
              ))}
            </RadioGroup>
            <TextField
              size="small"
              fullWidth
              label="Name (optional)"
              value={name}
              disabled={running}
              onChange={(e) => setName(e.target.value)}
              sx={{ mt: 1 }}
            />
          </>
        )}
        {job && (
          <>
            {running && <LinearProgress sx={{ mt: 2 }} />}
            <Typography variant="body2" sx={{ mt: 1 }}>
              {job.state === 'queued' && 'Waiting for the worker…'}
              {job.state === 'running' && `${job.message ?? 'Segmenting'}… (${elapsed(job)})`}
              {job.state === 'succeeded' && `Finished in ${elapsed(job)}; the new segmentation is open.`}
            </Typography>
            {job.state === 'failed' && <Alert severity="error">{job.message ?? 'The job failed'}</Alert>}
          </>
        )}
        {error && (
          <Alert severity="error" sx={{ mt: 1 }}>
            {error}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={close}>{running ? 'Close (keeps running)' : 'Close'}</Button>
        <Button variant="contained" onClick={start} disabled={!model || running || !models?.workerAvailable}>
          Start
        </Button>
      </DialogActions>
    </Dialog>
  );
}

