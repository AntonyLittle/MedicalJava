import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  LinearProgress,
  MenuItem,
  Paper,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  createSegmentation,
  deleteSegmentation,
  dicomSegUrl,
  fetchLabels,
  fetchSegmentations,
  importDicomSeg,
  saveLabels,
  updateSegmentation,
} from '../api/client';
import type { Segmentation, Volume } from '../api/types';
import { useSegmentation } from '../hooks/segmentationContext';
import { clearLabelJob, meanVoxelMl, statisticsJob, type LabelStatistics } from '../segmentation/algorithms';
import { meshToStl, surfaceMeshJob } from '../segmentation/mesh';
import { paletteColor, SegmentationSession } from '../segmentation/session';
import { hasUniformSlices } from '../segmentation/voxelSpace';
import { download, safeFileName } from '../utils/download';
import { isHounsfield, realRange } from '../utils/volumeValues';
import { AutoSegmentationDialog } from './AutoSegmentationDialog';
import { ConfirmDialog } from './ConfirmDialog';
import { SegmentationTools } from './SegmentationTools';
import { SegmentList } from './SegmentList';
import { SegmentStatisticsDialog } from './SegmentStatisticsDialog';

type OpenDialog = 'new' | 'rename' | 'delete' | 'auto' | 'stats' | null;

function voxelCount(volume: Volume): number {
  return volume.slices.reduce((sum, s) => sum + s.widthPixels * s.heightPixels, 0);
}

function describeSource(segmentation: Segmentation): string {
  if (segmentation.source.startsWith('auto:')) return `automatic (${segmentation.source.slice(5)})`;
  if (segmentation.source === 'dicom-seg') return 'imported DICOM SEG';
  return 'manual';
}

// Lists the volume's segmentations and edits the open one: segments, tools, saving, DICOM SEG import/export, STL
// export, statistics and automatic segmentation.
export function SegmentationPanel({ volume }: { volume: Volume }) {
  const segmentation = useSegmentation();
  const [segmentations, setSegmentations] = useState<Segmentation[]>([]);
  const [listVersion, setListVersion] = useState(0);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dialog, setDialog] = useState<OpenDialog>(null);
  const [nameInput, setNameInput] = useState('');
  const [statistics, setStatistics] = useState<LabelStatistics[] | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const session = segmentation?.session?.volume === volume ? segmentation.session : null;
  const setSession = segmentation?.setSession;
  const setError = segmentation?.setError;
  const supported = hasUniformSlices(volume) && (volume.formatVersion ?? 0) >= 1;
  const expectedVoxels = voxelCount(volume);

  const reportError = useCallback((e: unknown) => setError?.(e instanceof Error ? e.message : String(e)), [setError]);

  useEffect(() => {
    let cancelled = false;
    fetchSegmentations(volume.patientId, volume.volumeId)
      .then((list) => !cancelled && setSegmentations(list))
      .catch((e) => !cancelled && reportError(e));
    return () => {
      cancelled = true;
    };
  }, [volume, listVersion, reportError]);

  // Range defaults suit the volume's units: bone for CT, the upper half of the values otherwise.
  const setTools = segmentation?.setTools;
  useEffect(() => {
    const [min, max] = realRange(volume);
    setTools?.(
      isHounsfield(volume)
        ? { range: [200, Math.max(200, max)], growTolerance: 100 }
        : { range: [(min + max) / 2, max], growTolerance: (max - min) / 20 }
    );
  }, [volume, setTools]);

  const reloadList = () => setListVersion((v) => v + 1);

  // The latest session, for callbacks that shouldn't change with every edit.
  const sessionRef = useRef(session);
  useEffect(() => {
    sessionRef.current = session;
  });

  const open = useCallback(
    async (target: Segmentation) => {
      if (!setSession) return;
      if (target.voxelCount !== expectedVoxels) {
        setError?.(
          `"${target.name}" was made for a different version of this volume (${target.voxelCount} voxels, the volume now ` +
            `has ${expectedVoxels}) and can't be shown. Delete it, or re-import the series it was made on.`
        );
        return;
      }
      setLoading(true);
      try {
        const labels = await fetchLabels(target);
        if (labels.length !== expectedVoxels) throw new Error('The server sent labels of the wrong size');
        setSession(new SegmentationSession(volume, target, labels));
      } catch (e) {
        reportError(e);
      } finally {
        setLoading(false);
      }
    },
    [setSession, setError, expectedVoxels, volume, reportError]
  );

  const select = (id: string) => {
    if (!segmentation?.confirmDiscard()) return;
    if (id === '') {
      setSession?.(null);
      return;
    }
    const target = segmentations.find((s) => String(s.segmentationId) === id);
    if (target) void open(target);
  };

  const create = async () => {
    setDialog(null);
    if (!segmentation?.confirmDiscard() || !setSession) return;
    try {
      const created = await createSegmentation(volume.patientId, volume.volumeId, nameInput.trim() || 'Segmentation', [
        { label: 1, name: 'Segment 1', color: paletteColor(1), algorithmType: 'MANUAL' },
      ]);
      setSession(new SegmentationSession(volume, created, new Uint8Array(expectedVoxels)));
      segmentation.setTools({ tool: 'brush' });
      reloadList();
    } catch (e) {
      reportError(e);
    }
  };

  const save = useCallback(async () => {
    if (!session) return;
    setSaving(true);
    try {
      if (session.metadataDirty) {
        const saved = await updateSegmentation(session.saved, { name: session.name, segments: session.segmentsForSave() });
        session.markSaved(saved, null, true);
      }
      if (session.labelsChanged) {
        const version = session.labelmap.version;
        const saved = await saveLabels(session.saved, session.labelmap.data);
        session.markSaved(saved, version, false);
      }
      reloadList();
    } catch (e) {
      reportError(e);
    } finally {
      setSaving(false);
    }
  }, [session, reportError]);

  const rename = () => {
    setDialog(null);
    if (session && nameInput.trim()) session.rename(nameInput.trim());
  };

  const remove = async () => {
    if (!session) return;
    try {
      await deleteSegmentation(session.saved);
      setDialog(null);
      setSession?.(null);
      reloadList();
    } catch (e) {
      setDialog(null);
      reportError(e);
    }
  };

  const importFile = async (file: File | undefined) => {
    if (!file || !segmentation?.confirmDiscard()) return;
    setLoading(true);
    try {
      const imported = await importDicomSeg(volume.patientId, volume.volumeId, file);
      reloadList();
      await open(imported);
    } catch (e) {
      reportError(e);
    } finally {
      setLoading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const exportDicom = () => {
    if (!session) return;
    if (session.dirty) {
      setError?.('Save the segmentation before exporting it, so the export matches what is stored.');
      return;
    }
    download(dicomSegUrl(session.saved), `${safeFileName(session.name)}.dcm`);
  };

  const exportStl = async () => {
    const segment = session?.activeSegment;
    if (!session || !segment || !segmentation) return;
    const mesh = await segmentation.runTask('Building surface', surfaceMeshJob(volume, session.labelmap, segment.label));
    if (mesh === undefined) return;
    if (!mesh) {
      setError?.(`"${segment.name}" has no voxels.`);
      return;
    }
    download(meshToStl(mesh, segment.name), `${safeFileName(segment.name)}.stl`);
  };

  const showStatistics = async () => {
    if (!session || !segmentation) return;
    const result = await segmentation.runTask('Computing statistics', statisticsJob(volume, session.labelmap));
    if (result) {
      setStatistics(result);
      setDialog('stats');
    }
  };

  const removeSegment = (label: number) => {
    if (!session || !segmentation) return;
    const segment = session.segmentFor(label);
    const voxels = session.labelmap.counts[label];
    if (voxels > 0 && !window.confirm(`Remove "${segment?.name}" and its ${voxels.toLocaleString()} voxels?`)) return;
    session.removeSegment(label);
    if (voxels > 0) void segmentation.runEdit(`Remove ${segment?.name ?? 'segment'}`, (edit) => clearLabelJob(edit, label));
  };

  const autoFinished = useCallback(
    async (segmentationId: number) => {
      const list = await fetchSegmentations(volume.patientId, volume.volumeId);
      setSegmentations(list);
      const created = list.find((s) => s.segmentationId === segmentationId);
      if (created && (!sessionRef.current?.dirty || window.confirm('Open the new segmentation, discarding unsaved changes?'))) {
        await open(created);
      }
    },
    [volume, open]
  );

  // Ctrl+S saves.
  useEffect(() => {
    if (!session) return;
    const handleKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (session.dirty) void save();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [session, save]);

  if (!segmentation) return null;
  const { busy, error } = segmentation;
  const selectedId = session ? String(session.saved.segmentationId) : '';
  const listed = segmentations.some((s) => String(s.segmentationId) === selectedId);

  return (
    <Paper variant="outlined" sx={{ p: 2, mb: 2, textAlign: 'left' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <Typography variant="h6" sx={{ mr: 1 }}>
          Segmentation
        </Typography>
        <TextField
          select
          size="small"
          label="Open"
          value={listed || !session ? selectedId : ''}
          onChange={(e) => select(e.target.value)}
          disabled={!supported || loading || !!busy}
          sx={{ minWidth: 220 }}
        >
          <MenuItem value="">
            <em>None</em>
          </MenuItem>
          {segmentations.map((s) => (
            <MenuItem key={s.segmentationId} value={String(s.segmentationId)}>
              {s.name}
              {s.stale ? ' (stale)' : ''}
            </MenuItem>
          ))}
        </TextField>
        {loading && <CircularProgress size={20} />}
        <Button
          size="small"
          variant="outlined"
          disabled={!supported || !!busy}
          onClick={() => {
            setNameInput(`Segmentation ${segmentations.length + 1}`);
            setDialog('new');
          }}
        >
          New
        </Button>
        <Button size="small" variant="outlined" disabled={!supported || !!busy} onClick={() => setDialog('auto')}>
          Auto…
        </Button>
        <Button size="small" variant="outlined" disabled={!supported || !!busy} onClick={() => fileInput.current?.click()}>
          Import DICOM SEG…
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept=".dcm,application/dicom"
          hidden
          onChange={(e) => void importFile(e.target.files?.[0])}
        />
        {session && (
          <>
            <Button
              size="small"
              variant="contained"
              disabled={!session.dirty || saving || !!busy}
              onClick={() => void save()}
              startIcon={saving ? <CircularProgress size={14} color="inherit" /> : undefined}
            >
              Save
            </Button>
            {session.dirty && <Chip size="small" color="warning" label="Unsaved" />}
            <Button
              size="small"
              onClick={() => {
                setNameInput(session.name);
                setDialog('rename');
              }}
            >
              Rename
            </Button>
            <Button size="small" onClick={() => void showStatistics()} disabled={!!busy}>
              Statistics
            </Button>
            <Tooltip title="Download the segmentation as a DICOM SEG object">
              <span>
                <Button size="small" onClick={exportDicom} disabled={!!busy}>
                  Export DICOM SEG
                </Button>
              </span>
            </Tooltip>
            <Tooltip title="Download the active segment's surface as an STL mesh (mm, patient LPS coordinates)">
              <span>
                <Button size="small" onClick={() => void exportStl()} disabled={!!busy || !session.activeSegment}>
                  Export STL
                </Button>
              </span>
            </Tooltip>
            <Button size="small" color="error" onClick={() => setDialog('delete')} disabled={!!busy}>
              Delete
            </Button>
          </>
        )}
      </Box>

      {!supported && (
        <Alert severity="info" sx={{ mt: 1 }}>
          Segmentation needs a volume whose slices all have the same size and that was stored with its orientation
          (rescan or upload it again).
        </Alert>
      )}
      {error && (
        <Alert severity="error" onClose={() => segmentation.setError(null)} sx={{ mt: 1 }}>
          {error}
        </Alert>
      )}
      {busy && (
        <Box sx={{ mt: 1 }}>
          <Typography variant="body2">{busy.description}…</Typography>
          <LinearProgress variant="determinate" value={busy.progress * 100} />
        </Box>
      )}

      {session && (
        <>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            {session.name} · {describeSource(session.saved)} · saved revision {session.saved.revision}
          </Typography>
          {session.saved.stale && (
            <Alert severity="warning" sx={{ mt: 1 }}>
              The volume was re-imported with a different geometry after this segmentation was saved, so its labels may
              not line up with the anatomy. Saving stores it against the current geometry.
            </Alert>
          )}
          <Box sx={{ display: 'flex', gap: 3, mt: 1, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <Box sx={{ flex: '1 1 340px', minWidth: 300 }}>
              <SegmentList session={session} voxelMl={meanVoxelMl(volume)} disabled={!!busy} onRemove={removeSegment} />
            </Box>
            <Box sx={{ flex: '2 1 420px', minWidth: 320 }}>
              <SegmentationTools volume={volume} />
            </Box>
          </Box>
        </>
      )}

      <Dialog open={dialog === 'new' || dialog === 'rename'} onClose={() => setDialog(null)}>
        <DialogTitle>{dialog === 'new' ? 'New segmentation' : 'Rename segmentation'}</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            margin="dense"
            label="Name"
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                if (dialog === 'new') void create();
                else rename();
              }
            }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialog(null)}>Cancel</Button>
          <Button variant="contained" onClick={() => (dialog === 'new' ? void create() : rename())}>
            {dialog === 'new' ? 'Create' : 'Rename'}
          </Button>
        </DialogActions>
      </Dialog>

      <ConfirmDialog
        open={dialog === 'delete'}
        title="Delete segmentation?"
        confirmLabel="Delete"
        busy={false}
        onConfirm={() => void remove()}
        onCancel={() => setDialog(null)}
      >
        This permanently deletes “{session?.name}” and all its segments.
      </ConfirmDialog>

      <AutoSegmentationDialog
        open={dialog === 'auto'}
        volume={volume}
        onClose={() => setDialog(null)}
        onFinished={autoFinished}
      />

      <SegmentStatisticsDialog
        open={dialog === 'stats'}
        volume={volume}
        session={session}
        statistics={statistics}
        onClose={() => setDialog(null)}
      />
    </Paper>
  );
}
