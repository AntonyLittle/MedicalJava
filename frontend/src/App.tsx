import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';
import { buildMprPlanes, IDENTITY_ROTATION, type Coordinate, type Quaternion, type ViewablePlane } from './utils/canvasMath';
import { volumeCentre, type ProjectionMode } from './utils/mprSampler';
import { acquisitionPlane } from './utils/volumeGeometry';
import {
  defaultWindow,
  minWindowWidth,
  realRange,
  storedRange,
  toRealValue,
  toStoredWindow,
  valueSlope,
  valueUnits,
} from './utils/volumeValues';
import { WindowDragScaleContext, windowDragScale } from './hooks/windowDragScale';
import { Alert, Box, Button, CircularProgress, Container, Snackbar, Typography } from '@mui/material';
import { fetchPatients, fetchVolume, fetchVolumes } from './api/client';
import type { Patient, ScanResult, Volume } from './api/types';
import { HierarchySelector } from './components/HierarchySelector';
import { DataManagementToolbar } from './components/DataManagementToolbar';
import { useImportStatus } from './hooks/useImportStatus';
import { formatScanSummary } from './utils/formatScanSummary';
import { CineVolumeViewer } from './components/CineVolumeViewer';
import { WindowLevelControls } from './components/WindowLevelControls';
import { ThinMprVolumeViewer } from './components/ThinMprVolumeViewer';
import { ThickMprVolumeViewer } from './components/ThickMprVolumeViewer';
import { ThickMprControls } from './components/ThickMprControls';
import { MprOverviewViewer } from './components/MprOverviewViewer';
import { VolumeRenderViewer } from './components/VolumeRenderViewer';

// Used until a volume is loaded; each volume then starts with its own default window.
const DEFAULT_WINDOW_LEVEL = 40;
const DEFAULT_WINDOW_WIDTH = 400;
const DEFAULT_SLAB_THICKNESS_MM = 10;

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

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
  const handleMprPlaneChange = useCallback((plane: ViewablePlane) => setMprPosition(plane.positionXyz), []);

  const [slabThicknessMm, setSlabThicknessMm] = useState(DEFAULT_SLAB_THICKNESS_MM);
  const deferredSlabThicknessMm = useDeferredValue(slabThicknessMm);
  const [projectionMode, setProjectionMode] = useState<ProjectionMode>('average');

  // In real units (e.g. HU); the viewers work on stored values, so they get and report a converted window.
  const [windowLevel, setWindowLevel] = useState(DEFAULT_WINDOW_LEVEL);
  const [windowWidth, setWindowWidth] = useState(DEFAULT_WINDOW_WIDTH);

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loadingVolume, setLoadingVolume] = useState(false);

  // Bumped to reload the lists after the store changes, without disturbing the loaded volume.
  const [patientsVersion, setPatientsVersion] = useState(0);
  const [volumesVersion, setVolumesVersion] = useState(0);
  const reloadLists = useCallback(() => {
    setPatientsVersion((v) => v + 1);
    setVolumesVersion((v) => v + 1);
  }, []);

  const { status: importStatus, refresh: refreshImportStatus } = useImportStatus(reloadLists);

  const selectPatient = useCallback((patientId: number | null) => {
    setSelectedPatientId(patientId);
    setSelectedVolumeId(null);
    setVolumes([]);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchPatients()
      .then((p) => !cancelled && setPatients(p))
      .catch((e) => !cancelled && setError(describeError(e)));
    return () => {
      cancelled = true;
    };
  }, [patientsVersion]);

  useEffect(() => {
    if (selectedPatientId == null) return;
    let cancelled = false;
    fetchVolumes(selectedPatientId)
      .then((v) => !cancelled && setVolumes(v))
      .catch((e) => !cancelled && setError(describeError(e)));
    return () => {
      cancelled = true;
    };
  }, [selectedPatientId, volumesVersion]);

  useEffect(() => {
    setVolume(null);
    setSliceIndex(0);

    if (selectedPatientId == null || selectedVolumeId == null) return;

    let cancelled = false;
    setLoadingVolume(true);
    fetchVolume(selectedPatientId, selectedVolumeId)
      .then((v) => {
        if (cancelled) return;
        setVolume(v);
        setMprRotation(IDENTITY_ROTATION);
        if (v.slices.length > 0) {
          setMprPosition(volumeCentre(v));
          const window = defaultWindow(v);
          setWindowLevel(window.level);
          setWindowWidth(window.width);
        }
      })
      .catch((e) => !cancelled && setError(describeError(e)))
      .finally(() => !cancelled && setLoadingVolume(false));
    return () => {
      cancelled = true;
    };
  }, [selectedPatientId, selectedVolumeId]);

  const valueRange = useMemo<[number, number]>(
    () => (volume && volume.slices.length > 0 ? realRange(volume) : [-1024, 3071]),
    [volume]
  );
  const minWidth = volume ? minWindowWidth(volume) : 1;
  const maxWindowWidth = Math.max(minWidth, (valueRange[1] - valueRange[0]) * 2);
  const dragScale = useMemo(() => {
    if (!volume || volume.slices.length === 0) return 1;
    const [min, max] = storedRange(volume);
    return windowDragScale(min, max);
  }, [volume]);
  // Integer-valued data (e.g. HU) keeps whole-number windows, as drags with a scaled sensitivity land between.
  const integral = minWidth === 1 && (!volume || Number.isInteger(volume.valueIntercept ?? 0));
  const changeWindowLevel = useCallback(
    (level: number) => {
      const clamped = Math.min(valueRange[1], Math.max(valueRange[0], level));
      setWindowLevel(integral ? Math.round(clamped) : clamped);
    },
    [valueRange, integral]
  );
  const changeWindowWidth = useCallback(
    (width: number) => {
      const clamped = Math.min(maxWindowWidth, Math.max(minWidth, width));
      setWindowWidth(integral ? Math.round(clamped) : clamped);
    },
    [minWidth, maxWindowWidth, integral]
  );

  const storedWindow = useMemo(
    () => (volume ? toStoredWindow(volume, { level: windowLevel, width: windowWidth }) : { level: windowLevel, width: windowWidth }),
    [volume, windowLevel, windowWidth]
  );
  const changeStoredWindowLevel = useCallback(
    (stored: number) => changeWindowLevel(volume ? toRealValue(volume, stored) : stored),
    [volume, changeWindowLevel]
  );
  const changeStoredWindowWidth = useCallback(
    (stored: number) => changeWindowWidth(volume ? stored * valueSlope(volume) : stored),
    [volume, changeWindowWidth]
  );

  const selectedPatient = patients.find((p) => p.patientId === selectedPatientId) ?? null;
  const selectedVolume = volumes.find((v) => v.volumeId === selectedVolumeId) ?? null;

  const handleUploaded = useCallback(
    (uploaded: Volume[]) => {
      reloadLists();
      const [first] = uploaded;
      if (first) {
        if (first.patientId !== selectedPatientId) selectPatient(first.patientId);
        setSelectedVolumeId(first.volumeId);
      }
      setNotice(`Uploaded ${plural(uploaded.length, 'volume')}`);
    },
    [reloadLists, selectPatient, selectedPatientId]
  );

  const handleVolumeDeleted = useCallback((deleted: Volume) => {
    setSelectedVolumeId((current) => (current === deleted.volumeId ? null : current));
    setVolumesVersion((v) => v + 1);
    setNotice(`Deleted volume ${deleted.name}`);
  }, []);

  const handlePatientDeleted = useCallback(
    (deleted: Patient) => {
      if (deleted.patientId === selectedPatientId) selectPatient(null);
      setPatientsVersion((v) => v + 1);
      setNotice(`Deleted patient ${deleted.name}`);
    },
    [selectPatient, selectedPatientId]
  );

  const handleRescanned = useCallback(
    (result: ScanResult) => {
      reloadLists();
      refreshImportStatus();
      setNotice(`Rescan finished: ${formatScanSummary(result)}`);
    },
    [reloadLists, refreshImportStatus]
  );

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
        onPatientChange={selectPatient}
        volumes={volumes}
        selectedVolumeId={selectedVolumeId}
        onVolumeChange={setSelectedVolumeId}
      />

      <DataManagementToolbar
        selectedPatient={selectedPatient}
        selectedVolume={selectedVolume}
        patientVolumeCount={volumes.length}
        importStatus={importStatus}
        onUploaded={handleUploaded}
        onVolumeDeleted={handleVolumeDeleted}
        onPatientDeleted={handlePatientDeleted}
        onRescanned={handleRescanned}
        onError={setError}
      />

      <Snackbar
        open={notice != null}
        autoHideDuration={6000}
        onClose={(_, reason) => reason !== 'clickaway' && setNotice(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      >
        <Alert severity="success" variant="filled" onClose={() => setNotice(null)}>
          {notice}
        </Alert>
      </Snackbar>

      <WindowDragScaleContext value={dragScale}>
      <Box sx={{ mt: 4 }}>
        {loadingVolume && <CircularProgress />}
        {!loadingVolume && volume && (
          <>
            {(volume.formatVersion ?? 0) < 1 && (
              <Alert severity="warning" sx={{ mb: 2 }}>
                This volume was stored before orientation and value scaling were decoded, so it is shown as an axial
                stack of raw values. Rescan the data folder (or upload it again) to update it.
              </Alert>
            )}
            <Box sx={{ display: 'flex', flexWrap: 'wrap', flexDirection: 'row', alignItems: 'center', gap: 2, mb: 2 }}>
              <CineVolumeViewer
                volume={volume}
                sliceIndex={sliceIndex}
                onSliceIndexChange={setSliceIndex}
                windowLevel={storedWindow.level}
                windowWidth={storedWindow.width}
                onWindowLevelChange={changeStoredWindowLevel}
                onWindowWidthChange={changeStoredWindowWidth}
              />
              <MprOverviewViewer
                volume={volume}
                planes={mprPlanes}
                projectionMode={projectionMode}
                windowLevel={storedWindow.level}
                windowWidth={storedWindow.width}
                onWindowLevelChange={changeStoredWindowLevel}
                onWindowWidthChange={changeStoredWindowWidth}
              />
            </Box>
            <Box sx={{ mb: 2 }}>
              <VolumeRenderViewer
                volume={volume}
                planes={mprPlanes}
                windowLevel={storedWindow.level}
                windowWidth={storedWindow.width}
                onWindowLevelChange={changeStoredWindowLevel}
                onWindowWidthChange={changeStoredWindowWidth}
                onMprPositionChange={setMprPosition}
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
                windowLevel={storedWindow.level}
                windowWidth={storedWindow.width}
                onWindowLevelChange={changeStoredWindowLevel}
                onWindowWidthChange={changeStoredWindowWidth}
              />
              <ThickMprVolumeViewer
                volume={volume}
                orientation="axial"
                viewablePlane={axialPlane}
                mprRotation={mprRotation}
                onMprRotationChange={setMprRotation}
                onViewablePlaneChange={handleMprPlaneChange}
                windowLevel={storedWindow.level}
                windowWidth={storedWindow.width}
                onWindowLevelChange={changeStoredWindowLevel}
                onWindowWidthChange={changeStoredWindowWidth}
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
                windowLevel={storedWindow.level}
                windowWidth={storedWindow.width}
                onWindowLevelChange={changeStoredWindowLevel}
                onWindowWidthChange={changeStoredWindowWidth}
              />
              <ThickMprVolumeViewer
                volume={volume}
                orientation="coronal"
                viewablePlane={coronalPlane}
                mprRotation={mprRotation}
                onMprRotationChange={setMprRotation}
                onViewablePlaneChange={handleMprPlaneChange}
                windowLevel={storedWindow.level}
                windowWidth={storedWindow.width}
                onWindowLevelChange={changeStoredWindowLevel}
                onWindowWidthChange={changeStoredWindowWidth}
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
                windowLevel={storedWindow.level}
                windowWidth={storedWindow.width}
                onWindowLevelChange={changeStoredWindowLevel}
                onWindowWidthChange={changeStoredWindowWidth}
              />
              <ThickMprVolumeViewer
                volume={volume}
                orientation="sagittal"
                viewablePlane={sagittalPlane}
                mprRotation={mprRotation}
                onMprRotationChange={setMprRotation}
                onViewablePlaneChange={handleMprPlaneChange}
                windowLevel={storedWindow.level}
                windowWidth={storedWindow.width}
                onWindowLevelChange={changeStoredWindowLevel}
                onWindowWidthChange={changeStoredWindowWidth}
                slabThicknessMm={deferredSlabThicknessMm}
                projectionMode={projectionMode}
              />
            </Box>


            <Typography gutterBottom>
              Slice {sliceIndex + 1} of {volume.slices.length} ({acquisitionPlane(volume)} acquisition)
            </Typography>
            <WindowLevelControls
              windowLevel={windowLevel}
              windowWidth={windowWidth}
              minLevel={valueRange[0]}
              maxLevel={valueRange[1]}
              maxWidth={maxWindowWidth}
              units={valueUnits(volume)}
              onLevelChange={changeWindowLevel}
              onWidthChange={changeWindowWidth}
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
      </WindowDragScaleContext>
    </Container>
  );
}

export default App;
