import { useEffect, useState } from 'react';
import { Alert, Box, CircularProgress, Container, Typography } from '@mui/material';
import { fetchPatients, fetchVolume, fetchVolumes } from './api/client';
import type { Patient, Volume } from './api/types';
import { HierarchySelector } from './components/HierarchySelector';
import { VolumeViewer } from './components/VolumeViewer';

const DEFAULT_WINDOW_LEVEL = 1000;
const DEFAULT_WINDOW_WIDTH = 2000;

function App() {
  const [patients, setPatients] = useState<Patient[]>([]);
  const [selectedPatientId, setSelectedPatientId] = useState<number | null>(null);

  const [volumes, setVolumes] = useState<Volume[]>([]);
  const [selectedVolumeId, setSelectedVolumeId] = useState<number | null>(null);

  const [volume, setVolume] = useState<Volume | null>(null);
  const [sliceIndex, setSliceIndex] = useState(0);

  const [windowLevel, setWindowLevel] = useState(DEFAULT_WINDOW_LEVEL);
  const [windowWidth, setWindowWidth] = useState(DEFAULT_WINDOW_WIDTH);

  const [error, setError] = useState<string | null>(null);
  const [loadingVolume, setLoadingVolume] = useState(false);

  useEffect(() => {
    fetchPatients().then(setPatients).catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    setVolumes([]);
    setSelectedVolumeId(null);
    setVolume(null);
    setSliceIndex(0);

    if (selectedPatientId == null) return;

    fetchVolumes(selectedPatientId).then(setVolumes).catch((e) => setError(String(e)));
  }, [selectedPatientId]);

  useEffect(() => {
    setVolume(null);
    setSliceIndex(0);

    if (selectedPatientId == null || selectedVolumeId == null) return;

    setLoadingVolume(true);
    fetchVolume(selectedPatientId, selectedVolumeId)
      .then(setVolume)
      .catch((e) => setError(String(e)))
      .finally(() => setLoadingVolume(false));
  }, [selectedPatientId, selectedVolumeId]);

  return (
    <Container sx={{ py: 4 }}>
      <Typography variant="h4" gutterBottom>
        DICOM Viewer
      </Typography>

      {error && (
        <Alert severity="error" onClose={() => setError(null)} sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      <HierarchySelector
        patients={patients}
        selectedPatientId={selectedPatientId}
        onPatientChange={setSelectedPatientId}
        volumes={volumes}
        selectedVolumeId={selectedVolumeId}
        onVolumeChange={setSelectedVolumeId}
      />

      <Box sx={{ mt: 4 }}>
        {loadingVolume && <CircularProgress />}
        {!loadingVolume && volume && (
          <VolumeViewer
            volume={volume}
            sliceIndex={sliceIndex}
            onSliceIndexChange={setSliceIndex}
            windowLevel={windowLevel}
            windowWidth={windowWidth}
            onWindowLevelChange={setWindowLevel}
            onWindowWidthChange={setWindowWidth}
          />
        )}
      </Box>
    </Container>
  );
}

export default App;
