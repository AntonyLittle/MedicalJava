import { useCallback, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormControlLabel,
  FormLabel,
  LinearProgress,
  Radio,
  RadioGroup,
  Typography,
} from '@mui/material';
import { uploadVolumes } from '../api/client';
import type { Patient, Volume } from '../api/types';
import { filesFromDrop, formatBytes, visibleFiles } from '../utils/droppedFiles';

type Destination = 'selected' | 'fromTags';
type Phase = 'idle' | 'uploading' | 'processing';

const MAX_LISTED_FILES = 5;

interface UploadDialogProps {
  selectedPatient: Patient | null;
  onClose: () => void;
  onUploaded: (volumes: Volume[]) => void;
}

// Mount only while open so every opening starts from a clean state.
export function UploadDialog({ selectedPatient, onClose, onUploaded }: UploadDialogProps) {
  const [destination, setDestination] = useState<Destination>(selectedPatient ? 'selected' : 'fromTags');
  const [files, setFiles] = useState<File[]>([]);
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const folderInputRef = useCallback((input: HTMLInputElement | null) => {
    if (input) input.webkitdirectory = true;
  }, []);

  const busy = phase !== 'idle';
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);

  const addFiles = (added: File[]) => {
    setError(null);
    setFiles((current) => [...current, ...visibleFiles(added)]);
  };

  const handleInput = (event: ChangeEvent<HTMLInputElement>) => {
    addFiles(Array.from(event.target.files ?? []));
    // Allow picking the same file/folder again after clearing.
    event.target.value = '';
  };

  const handleDrop = async (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    if (busy) return;
    try {
      addFiles(await filesFromDrop(event.dataTransfer));
    } catch (e) {
      setError(`Could not read dropped items: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleUpload = async () => {
    const controller = new AbortController();
    abortRef.current = controller;
    setError(null);
    setProgress(0);
    setPhase('uploading');
    try {
      const volumes = await uploadVolumes({
        patientId: destination === 'selected' && selectedPatient ? selectedPatient.patientId : null,
        files,
        signal: controller.signal,
        onProgress: (fraction) => {
          setProgress(fraction);
          if (fraction >= 1) setPhase('processing');
        },
      });
      onUploaded(volumes);
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        setPhase('idle');
        return;
      }
      setError(e instanceof Error ? e.message : String(e));
      setPhase('idle');
    } finally {
      abortRef.current = null;
    }
  };

  return (
    <Dialog open onClose={busy ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>Upload volumes</DialogTitle>
      <DialogContent>
        <FormControl disabled={busy} sx={{ mb: 2 }}>
          <FormLabel id="upload-destination-label">Add to</FormLabel>
          <RadioGroup
            aria-labelledby="upload-destination-label"
            value={destination}
            onChange={(event) => setDestination(event.target.value as Destination)}
          >
            <FormControlLabel
              value="selected"
              control={<Radio />}
              disabled={!selectedPatient}
              label={selectedPatient ? `Selected patient: ${selectedPatient.name}` : 'Selected patient (none selected)'}
            />
            <FormControlLabel value="fromTags" control={<Radio />} label="Patient named in the DICOM files (created if new)" />
          </RadioGroup>
        </FormControl>

        <Box
          onDragOver={(event) => {
            event.preventDefault();
            if (!busy) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          sx={{
            border: '2px dashed',
            borderColor: dragging ? 'primary.main' : 'divider',
            bgcolor: dragging ? 'action.hover' : undefined,
            borderRadius: 1,
            p: 3,
            textAlign: 'center',
          }}
        >
          <Typography gutterBottom>Drop DICOM files, folders or .zip archives here</Typography>
          <Box sx={{ display: 'flex', gap: 1, justifyContent: 'center' }}>
            <Button component="label" variant="outlined" disabled={busy}>
              Choose files…
              <input hidden type="file" multiple onChange={handleInput} />
            </Button>
            <Button component="label" variant="outlined" disabled={busy}>
              Choose folder…
              <input hidden type="file" ref={folderInputRef} onChange={handleInput} />
            </Button>
          </Box>
        </Box>

        {files.length > 0 && (
          <Box sx={{ mt: 2 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <Typography variant="subtitle2">
                {files.length} file{files.length === 1 ? '' : 's'} ({formatBytes(totalBytes)})
              </Typography>
              <Button size="small" onClick={() => setFiles([])} disabled={busy}>
                Clear
              </Button>
            </Box>
            <Typography variant="body2" color="text.secondary" component="div">
              {files.slice(0, MAX_LISTED_FILES).map((file, i) => (
                <div key={i}>{file.webkitRelativePath || file.name}</div>
              ))}
              {files.length > MAX_LISTED_FILES && <div>…and {files.length - MAX_LISTED_FILES} more</div>}
            </Typography>
          </Box>
        )}

        {busy && (
          <Box sx={{ mt: 2 }}>
            <Typography variant="body2" gutterBottom>
              {phase === 'uploading'
                ? `Uploading… ${Math.round(progress * 100)}%`
                : 'Decoding and storing on the server…'}
            </Typography>
            <LinearProgress
              variant={phase === 'uploading' ? 'determinate' : 'indeterminate'}
              value={progress * 100}
            />
          </Box>
        )}

        {error && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        {/* Once the body is sent the server finishes the import regardless, so cancelling is only offered while uploading. */}
        <Button
          onClick={phase === 'uploading' ? () => abortRef.current?.abort() : onClose}
          disabled={phase === 'processing'}
        >
          Cancel
        </Button>
        <Button variant="contained" onClick={handleUpload} disabled={busy || files.length === 0}>
          Upload
        </Button>
      </DialogActions>
    </Dialog>
  );
}
