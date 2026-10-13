import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { buildMprPlanes, IDENTITY_ROTATION, type Coordinate, type Quaternion, type ViewablePlane } from './utils/canvasMath';
import { getVolumeBounds, type ProjectionMode } from './utils/mprSampler';
import { Alert, Box, Button, CircularProgress, Container, Typography } from '@mui/material';
import { fetchPatients, fetchVolume, fetchVolumes } from './api/client';
import type { Patient, Volume } from './api/types';
import { HierarchySelector } from './components/HierarchySelector';
import { CineVolumeViewer } from './components/CineVolumeViewer';
import { WindowLevelControls } from './components/WindowLevelControls';
import { ThinMprVolumeViewer } from './components/ThinMprVolumeViewer';
import { ThickMprVolumeViewer } from './components/ThickMprVolumeViewer';
import { ThickMprControls } from './components/ThickMprControls';
import { MprOverviewViewer } from './components/MprOverviewViewer';

const DEFAULT_WINDOW_LEVEL = 1000;
const DEFAULT_WINDOW_WIDTH = 2000;
const DEFAULT_SLAB_THICKNESS_MM = 10;

function App() {
  const [patients, setPatients] = useState<Patient[]>([]);
  const [selectedPatientId, setSelectedPatientId] = useState<number | null>(null);

  const [volumes, setVolumes] = useState<Volume[]>([]);
  const [selectedVolumeId, setSelectedVolumeId] = useState<number | null>(null);

  const [volume, setVolume] = useState<Volume | null>(null);
  const [sliceIndex, setSliceIndex] = useState(0);

  const [mprPosition, setMprPosition] = useState<Coordinate>({ x: 0, y: 0, z: 0 });
  const [mprRotation, setMprRotation] = useState<Quaternion>(IDENTITY_ROTATION);
  const mprPlanes = useMemo(() => buildMprPlanes(mprPosition, mprRotation), [mprPosition, mprRotation]);
  const { axial: axialPlane, coronal: coronalPlane, sagittal: sagittalPlane } = mprPlanes;
  const handleMprPlaneChange = (plane: ViewablePlane) => setMprPosition(plane.positionXyz);

  const [slabThicknessMm, setSlabThicknessMm] = useState(DEFAULT_SLAB_THICKNESS_MM);
  const deferredSlabThicknessMm = useDeferredValue(slabThicknessMm);
  const [projectionMode, setProjectionMode] = useState<ProjectionMode>('average');

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
      .then((v) => {
        setVolume(v);
        setMprRotation(IDENTITY_ROTATION);
        if (v.slices.length > 0) {
          const { min, max } = getVolumeBounds(v);
          setMprPosition({ x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 });
        }
      })
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
          <>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', flexDirection: 'row', alignItems: 'center', gap: 2, mb: 2 }}>
              <CineVolumeViewer
                volume={volume}
                sliceIndex={sliceIndex}
                onSliceIndexChange={setSliceIndex}
                windowLevel={windowLevel}
                windowWidth={windowWidth}
                onWindowLevelChange={setWindowLevel}
                onWindowWidthChange={setWindowWidth}
              />
              <MprOverviewViewer
                volume={volume}
                planes={mprPlanes}
                projectionMode={projectionMode}
                windowLevel={windowLevel}
                windowWidth={windowWidth}
                onWindowLevelChange={setWindowLevel}
                onWindowWidthChange={setWindowWidth}
              />
            </Box>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', flexDirection: 'row', alignItems: 'center', gap: 2 }}>
              <ThinMprVolumeViewer
                volume={volume}
                orientation="axial"
                viewablePlane={axialPlane}
                mprRotation={mprRotation}
                onMprRotationChange={setMprRotation}
                onViewablePlaneChange={handleMprPlaneChange}
                windowLevel={windowLevel}
                windowWidth={windowWidth}
                onWindowLevelChange={setWindowLevel}
                onWindowWidthChange={setWindowWidth}
              />
              <ThickMprVolumeViewer
                volume={volume}
                orientation="axial"
                viewablePlane={axialPlane}
                mprRotation={mprRotation}
                onMprRotationChange={setMprRotation}
                onViewablePlaneChange={handleMprPlaneChange}
                windowLevel={windowLevel}
                windowWidth={windowWidth}
                onWindowLevelChange={setWindowLevel}
                onWindowWidthChange={setWindowWidth}
                slabThicknessMm={deferredSlabThicknessMm}
                projectionMode={projectionMode}
              />
              <ThinMprVolumeViewer
                volume={volume}
                orientation="coronal"
                viewablePlane={coronalPlane}
                mprRotation={mprRotation}
                onMprRotationChange={setMprRotation}
                onViewablePlaneChange={handleMprPlaneChange}
                windowLevel={windowLevel}
                windowWidth={windowWidth}
                onWindowLevelChange={setWindowLevel}
                onWindowWidthChange={setWindowWidth}
              />
              <ThickMprVolumeViewer
                volume={volume}
                orientation="coronal"
                viewablePlane={coronalPlane}
                mprRotation={mprRotation}
                onMprRotationChange={setMprRotation}
                onViewablePlaneChange={handleMprPlaneChange}
                windowLevel={windowLevel}
                windowWidth={windowWidth}
                onWindowLevelChange={setWindowLevel}
                onWindowWidthChange={setWindowWidth}
                slabThicknessMm={deferredSlabThicknessMm}
                projectionMode={projectionMode}
              />
              <ThinMprVolumeViewer
                volume={volume}
                orientation="sagittal"
                viewablePlane={sagittalPlane}
                mprRotation={mprRotation}
                onMprRotationChange={setMprRotation}
                onViewablePlaneChange={handleMprPlaneChange}
                windowLevel={windowLevel}
                windowWidth={windowWidth}
                onWindowLevelChange={setWindowLevel}
                onWindowWidthChange={setWindowWidth}
              />
              <ThickMprVolumeViewer
                volume={volume}
                orientation="sagittal"
                viewablePlane={sagittalPlane}
                mprRotation={mprRotation}
                onMprRotationChange={setMprRotation}
                onViewablePlaneChange={handleMprPlaneChange}
                windowLevel={windowLevel}
                windowWidth={windowWidth}
                onWindowLevelChange={setWindowLevel}
                onWindowWidthChange={setWindowWidth}
                slabThicknessMm={deferredSlabThicknessMm}
                projectionMode={projectionMode}
              />
            </Box>


            <Typography gutterBottom>
              Slice {sliceIndex + 1} of {volume.slices.length}
            </Typography>
            <WindowLevelControls
              windowLevel={windowLevel}
              windowWidth={windowWidth}
              onLevelChange={setWindowLevel}
              onWidthChange={setWindowWidth}
            />
            <ThickMprControls
              slabThicknessMm={slabThicknessMm}
              projectionMode={projectionMode}
              onSlabThicknessChange={setSlabThicknessMm}
              onProjectionModeChange={setProjectionMode}
            />
            <Typography>MPR Position: {mprPosition.x.toFixed(1)}, {mprPosition.y.toFixed(1)}, {mprPosition.z.toFixed(1)}</Typography>
            <Button size="small" onClick={() => setMprRotation(IDENTITY_ROTATION)}>
              Reset rotation
            </Button>
          </>
        )}
      </Box>
    </Container>
  );
}

export default App;
