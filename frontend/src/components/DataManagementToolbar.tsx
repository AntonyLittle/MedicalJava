import { useState } from 'react';
import { Box, Button, Chip, CircularProgress } from '@mui/material';
import { deletePatient, deleteVolume, rescanDataDirectory } from '../api/client';
import type { ImportStatus, Patient, ScanResult, Volume } from '../api/types';
import { ConfirmDialog } from './ConfirmDialog';
import { ImportStatusDialog } from './ImportStatusDialog';
import { UploadDialog } from './UploadDialog';

function describeVolumeCount(count: number): string {
  if (count === 0) return '';
  return count === 1 ? ' and their volume' : ` and all ${count} of their volumes`;
}

type OpenDialog = 'upload' | 'deleteVolume' | 'deletePatient' | 'importStatus' | null;

interface DataManagementToolbarProps {
  selectedPatient: Patient | null;
  selectedVolume: Volume | null;
  patientVolumeCount: number;
  importStatus: ImportStatus | null;
  onUploaded: (volumes: Volume[]) => void;
  onVolumeDeleted: (volume: Volume) => void;
  onPatientDeleted: (patient: Patient) => void;
  onRescanned: (result: ScanResult) => void;
  onError: (message: string) => void;
}

export function DataManagementToolbar({
  selectedPatient,
  selectedVolume,
  patientVolumeCount,
  importStatus,
  onUploaded,
  onVolumeDeleted,
  onPatientDeleted,
  onRescanned,
  onError,
}: DataManagementToolbarProps) {
  const [openDialog, setOpenDialog] = useState<OpenDialog>(null);
  const [deleting, setDeleting] = useState(false);
  const [rescanning, setRescanning] = useState(false);
  // Captured when a delete dialog opens so its text stays intact while it closes after the selection is cleared.
  const [deleteTarget, setDeleteTarget] = useState<{ patient: Patient; volume: Volume | null; volumeCount: number }>();

  const importRunning = rescanning || (importStatus?.running ?? false);
  const failureCount = importStatus?.failures.length ?? 0;

  const runDelete = async (action: () => Promise<void>) => {
    setDeleting(true);
    try {
      await action();
      setOpenDialog(null);
    } catch (e) {
      setOpenDialog(null);
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(false);
    }
  };

  const openDelete = (dialog: 'deleteVolume' | 'deletePatient') => {
    if (!selectedPatient) return;
    setDeleteTarget({ patient: selectedPatient, volume: selectedVolume, volumeCount: patientVolumeCount });
    setOpenDialog(dialog);
  };

  const handleDeleteVolume = () => {
    const volume = deleteTarget?.volume;
    if (!volume) return;
    runDelete(async () => {
      await deleteVolume(volume.patientId, volume.volumeId);
      onVolumeDeleted(volume);
    });
  };

  const handleDeletePatient = () => {
    const patient = deleteTarget?.patient;
    if (!patient) return;
    runDelete(async () => {
      await deletePatient(patient.patientId);
      onPatientDeleted(patient);
    });
  };

  const handleRescan = async () => {
    setRescanning(true);
    try {
      onRescanned(await rescanDataDirectory());
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setRescanning(false);
    }
  };

  let statusChip;
  if (importRunning) {
    statusChip = (
      <Chip
        icon={<CircularProgress size={14} />}
        label="Importing data folder…"
        onClick={() => setOpenDialog('importStatus')}
      />
    );
  } else if (failureCount > 0) {
    statusChip = (
      <Chip
        color="warning"
        label={`${failureCount} import failure${failureCount === 1 ? '' : 's'}`}
        onClick={() => setOpenDialog('importStatus')}
      />
    );
  } else {
    statusChip = <Chip variant="outlined" label="Import status" onClick={() => setOpenDialog('importStatus')} />;
  }

  return (
    <>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1, mt: 2 }}>
        <Button variant="contained" onClick={() => setOpenDialog('upload')}>
          Upload…
        </Button>
        <Button
          variant="outlined"
          color="error"
          disabled={!selectedPatient || !selectedVolume}
          onClick={() => openDelete('deleteVolume')}
        >
          Delete volume
        </Button>
        <Button
          variant="outlined"
          color="error"
          disabled={!selectedPatient}
          onClick={() => openDelete('deletePatient')}
        >
          Delete patient
        </Button>
        <Button
          variant="outlined"
          disabled={importRunning}
          onClick={handleRescan}
          startIcon={rescanning ? <CircularProgress size={16} color="inherit" /> : undefined}
        >
          Rescan data folder
        </Button>
        {statusChip}
      </Box>

      {openDialog === 'upload' && (
        <UploadDialog
          selectedPatient={selectedPatient}
          onClose={() => setOpenDialog(null)}
          onUploaded={(volumes) => {
            setOpenDialog(null);
            onUploaded(volumes);
          }}
        />
      )}

      <ConfirmDialog
        open={openDialog === 'deleteVolume'}
        title="Delete volume?"
        confirmLabel="Delete volume"
        busy={deleting}
        onConfirm={handleDeleteVolume}
        onCancel={() => setOpenDialog(null)}
      >
        <p>
          Delete <strong>{deleteTarget?.volume?.name}</strong> from <strong>{deleteTarget?.patient.name}</strong>? Its stored
          pixel data is removed and this cannot be undone.
        </p>
        <p>Volumes imported from the data folder are not re-imported by later scans.</p>
      </ConfirmDialog>

      <ConfirmDialog
        open={openDialog === 'deletePatient'}
        title="Delete patient?"
        confirmLabel="Delete patient"
        busy={deleting}
        onConfirm={handleDeletePatient}
        onCancel={() => setOpenDialog(null)}
      >
        <p>
          Delete <strong>{deleteTarget?.patient.name}</strong>
          {describeVolumeCount(deleteTarget?.volumeCount ?? 0)}? This cannot be undone.
        </p>
        <p>Volumes imported from the data folder are not re-imported by later scans.</p>
      </ConfirmDialog>

      <ImportStatusDialog
        open={openDialog === 'importStatus'}
        status={importStatus}
        onClose={() => setOpenDialog(null)}
      />
    </>
  );
}
