import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import { Alert, Box } from '@mui/material';
import type { Volume } from '../api/types';
import { useOrbitCamera } from '../hooks/useOrbitCamera';
import { useSegmentation } from '../hooks/segmentationContext';
import { useSharedGpu } from '../hooks/useSharedGpu';
import { usePointerDragMode, type DragStarter } from '../hooks/usePointerDragMode';
import { useWlwwDrag } from '../hooks/useWlwwDrag';
import { projectToCanvas, rayForPixel, type CameraFrame } from '../render3d/camera';
import { cutPlaneFromViewablePlane, FULL_CLIP_BOX } from '../render3d/clipping';
import { pickPoint } from '../render3d/pick';
import {
  buildTransferLut,
  presetPoints,
  TRANSFER_PRESETS,
  windowRampPoints,
  type RgbColor,
} from '../render3d/transferFunctions';
import { VolumeRenderer, type RenderParams } from '../render3d/VolumeRenderer';
import { clamp, type Coordinate, type MprPlanes } from '../utils/canvasMath';
import { MPR_COLOR_BY_ORIENTATION } from '../utils/mprColors';
import { getVolumeBounds, volumeCentre, type PlaneOrientation } from '../utils/mprSampler';
import { planeIntersectionInVolume, planeOutlineInVolume } from '../utils/planeOverlay';
import {
  defaultWindow,
  isHounsfield,
  realRange,
  storedRange,
  toStoredValue,
  valueUnits,
} from '../utils/volumeValues';
import {
  MAX_OPACITY_SCALE,
  MAX_SHIFT_HU,
  MIN_OPACITY_SCALE,
  MIN_SHIFT_HU,
  VolumeRenderControls,
  type RenderQuality,
  type VolumeRenderSettings,
} from './VolumeRenderControls';

const WIDTH = 512;
const HEIGHT = 512;

// While the view is changing it is drawn at reduced resolution with longer steps, then refined once input pauses.
const PREVIEW_RESOLUTION_SCALE = 0.5;
const PREVIEW_STEP_MULTIPLIER = 2;
const REFINE_DELAY_MS = 150;

// Ray step as a fraction of the smallest voxel spacing.
const STEP_FACTOR: Record<RenderQuality, number> = { fast: 1, standard: 0.5, high: 0.25 };

const ISO_COLOR: RgbColor = [0.92, 0.86, 0.76];

// Left+right drag sensitivity for the transfer function and iso threshold.
const HU_PER_PIXEL = 2;
// For other units the threshold moves by this fraction of the value range per pixel.
const RANGE_FRACTION_PER_PIXEL = 1 / 2000;
// Bone, for CT; other data starts at its default window level.
const DEFAULT_ISO_HU = 300;
const OPACITY_EXPONENT_PER_PIXEL = 0.01;

const ORIENTATIONS: PlaneOrientation[] = ['axial', 'coronal', 'sagittal'];
const INTERSECTING_PAIRS: [PlaneOrientation, PlaneOrientation][] = [
  ['axial', 'coronal'],
  ['axial', 'sagittal'],
  ['coronal', 'sagittal'],
];

const DEFAULT_SETTINGS: VolumeRenderSettings = {
  mode: 'dvr',
  presetId: TRANSFER_PRESETS[0].id,
  shiftHu: 0,
  opacityScale: 1,
  shading: true,
  isoValue: null,
  projection: 'orthographic',
  quality: 'standard',
  clipBox: FULL_CLIP_BOX,
  cutPlane: 'none',
  flipCut: false,
  showMprPlanes: true,
  labelTint: false,
};

// windowLevel/windowWidth are in stored values, like the other viewers'.
interface VolumeRenderViewerProps {
  volume: Volume;
  planes: MprPlanes;
  windowLevel: number;
  windowWidth: number;
  onWindowLevelChange: (level: number) => void;
  onWindowWidthChange: (width: number) => void;
  onMprPositionChange: (position: Coordinate) => void;
}

function drawMprPlanes(context: CanvasRenderingContext2D, volume: Volume, planes: MprPlanes, frame: CameraFrame) {
  const project = (point: Coordinate) => projectToCanvas(frame, point, WIDTH, HEIGHT);
  context.lineWidth = 2;
  for (const orientation of ORIENTATIONS) {
    const outline = planeOutlineInVolume(volume, planes[orientation]).map(project);
    if (outline.length < 3 || outline.some((p) => !p)) continue;
    context.beginPath();
    outline.forEach((p, i) => (i === 0 ? context.moveTo(p!.x, p!.y) : context.lineTo(p!.x, p!.y)));
    context.closePath();
    context.strokeStyle = MPR_COLOR_BY_ORIENTATION[orientation];
    context.stroke();
  }

  context.strokeStyle = '#ffffff';
  context.setLineDash([6, 4]);
  for (const [first, second] of INTERSECTING_PAIRS) {
    const segment = planeIntersectionInVolume(volume, planes[first], planes[second]);
    const start = segment && project(segment[0]);
    const end = segment && project(segment[1]);
    if (!start || !end) continue;
    context.beginPath();
    context.moveTo(start.x, start.y);
    context.lineTo(end.x, end.y);
    context.stroke();
  }
  context.setLineDash([]);
}

export function VolumeRenderViewer({
  volume,
  planes,
  windowLevel,
  windowWidth,
  onWindowLevelChange,
  onWindowWidthChange,
  onMprPositionChange,
}: VolumeRenderViewerProps) {
  const [settings, setSettings] = useState<VolumeRenderSettings>(DEFAULT_SETTINGS);
  const updateSettings = useCallback((update: Partial<VolumeRenderSettings>) => {
    setSettings((s) => ({ ...s, ...update }));
  }, []);
  // Thresholds and clip fractions belong to one volume; a newly loaded one starts from its defaults.
  const [settingsVolume, setSettingsVolume] = useState(volume);
  if (settingsVolume !== volume) {
    setSettingsVolume(volume);
    setSettings((s) => ({ ...s, isoValue: null, clipBox: FULL_CLIP_BOX }));
  }

  const segmentation = useSegmentation();
  const session = segmentation?.session?.volume === volume ? segmentation.session : null;
  // Read on every render: the context re-renders this view whenever the session changes.
  const labelVersion = session?.labelmap.version;
  const labelColors = session?.colorTable();
  const surfaceOpacity = segmentation?.display.surfaceOpacity ?? 1;
  // Segment surfaces need a segmentation; without one the view falls back to VR.
  const mode = settings.mode === 'labels' && !session ? 'dvr' : settings.mode;

  const hounsfield = isHounsfield(volume);
  const units = valueUnits(volume);
  const valueRange = useMemo(() => realRange(volume), [volume]);
  const isoValue = settings.isoValue ?? (hounsfield ? DEFAULT_ISO_HU : defaultWindow(volume).level);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<VolumeRenderer | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The version changes when a lost context is restored, to rebuild every GPU resource.
  const { gpu, version: contextVersion } = useSharedGpu();

  const centre = useMemo(() => volumeCentre(volume), [volume]);
  const fitRadiusMm = useMemo(() => {
    const { min, max } = getVolumeBounds(volume);
    return Math.max(1, Math.hypot(max.x - min.x, max.y - min.y, max.z - min.z) / 2);
  }, [volume]);
  const orbit = useOrbitCamera({ centre, fitRadiusMm, width: WIDTH, height: HEIGHT, projection: settings.projection });
  const { frame, reset: resetCamera } = orbit;

  useEffect(() => {
    resetCamera();
  }, [volume, resetCamera]);

  // The window only affects the greyscale modes, and volume rendering of data without Hounsfield units (whose
  // opacity ramps across the window); ignoring it otherwise avoids needless re-renders.
  const usesWindow = mode === 'mip' || mode === 'minip' || mode === 'average' || (!hounsfield && mode === 'dvr');
  const renderWindowLevel = usesWindow ? windowLevel : 0;
  const renderWindowWidth = usesWindow ? windowWidth : 1;

  const preset = TRANSFER_PRESETS.find((p) => p.id === settings.presetId) ?? TRANSFER_PRESETS[0];
  const lut = useMemo(() => {
    const [min, max] = storedRange(volume);
    const points = hounsfield
      ? presetPoints(preset, settings.shiftHu, (hu) => toStoredValue(volume, hu))
      : windowRampPoints(renderWindowLevel - renderWindowWidth / 2, renderWindowLevel + renderWindowWidth / 2);
    return buildTransferLut(points, min, max);
  }, [volume, hounsfield, preset, settings.shiftHu, renderWindowLevel, renderWindowWidth]);

  const cutOrientation = settings.cutPlane;
  const cutViewablePlane = cutOrientation === 'none' ? null : planes[cutOrientation];
  const cutPlane = useMemo(
    () => (cutViewablePlane ? cutPlaneFromViewablePlane(cutViewablePlane, settings.flipCut) : null),
    [cutViewablePlane, settings.flipCut]
  );

  const labels = useMemo(() => {
    if (!session || (mode !== 'labels' && !(mode === 'dvr' && settings.labelTint))) return null;
    // The labels are edited in place; a new version re-renders the view as they are painted.
    void labelVersion;
    return { labelmap: session.labelmap, colors: labelColors!, opacity: surfaceOpacity, tint: settings.labelTint };
  }, [session, mode, settings.labelTint, surfaceOpacity, labelVersion, labelColors]);

  const renderParams = useMemo<RenderParams>(
    () => ({
      mode,
      camera: frame,
      lut,
      opacityScale: settings.opacityScale,
      shading: settings.shading ? 1 : 0,
      windowLevel: renderWindowLevel,
      windowWidth: renderWindowWidth,
      isoValue: toStoredValue(volume, isoValue),
      isoColor: ISO_COLOR,
      clipBox: settings.clipBox,
      cutPlane,
      stepFactor: STEP_FACTOR[settings.quality],
      skipEmpty: true,
      labels,
    }),
    [mode, settings, frame, lut, renderWindowLevel, renderWindowWidth, cutPlane, volume, isoValue, labels]
  );

  // The renderer is created lazily in draw(); a restored context needs a new one.
  useEffect(
    () => () => {
      rendererRef.current?.dispose();
      rendererRef.current = null;
    },
    [gpu, contextVersion]
  );

  // Preview immediately, refine once the parameters have been stable for a moment. The image is rendered in the
  // context shared with the MPR views (so the volume is on the GPU once) and copied into this canvas.
  useEffect(() => {
    const context = canvasRef.current?.getContext('2d');
    if (!context) return;
    const draw = (preview: boolean) => {
      try {
        if (!gpu) throw new Error('3D rendering needs WebGL2, which this browser does not provide.');
        if (gpu.isLost()) return;
        let renderer = rendererRef.current;
        if (!renderer) {
          renderer = new VolumeRenderer(gpu);
          rendererRef.current = renderer;
        }
        renderer.setVolume(volume);

        const scale = preview ? PREVIEW_RESOLUTION_SCALE : 1;
        const width = Math.round(WIDTH * scale);
        const height = Math.round(HEIGHT * scale);
        renderer.render(
          { ...renderParams, stepFactor: renderParams.stepFactor * (preview ? PREVIEW_STEP_MULTIPLIER : 1) },
          width,
          height
        );
        gpu.copyTo(context, width, height, 0, 0, WIDTH, HEIGHT);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    };

    let frameId = requestAnimationFrame(() => draw(true));
    const timer = setTimeout(() => {
      frameId = requestAnimationFrame(() => draw(false));
    }, REFINE_DELAY_MS);
    return () => {
      cancelAnimationFrame(frameId);
      clearTimeout(timer);
    };
  }, [gpu, volume, renderParams, contextVersion]);

  useEffect(() => {
    const overlay = overlayRef.current;
    const context = overlay?.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, WIDTH, HEIGHT);
    if (settings.showMprPlanes) drawMprPlanes(context, volume, planes, frame);
  }, [settings.showMprPlanes, volume, planes, frame]);

  const startWlww = useWlwwDrag(windowLevel, windowWidth, onWindowLevelChange, onWindowWidthChange);
  const startAdjust = useCallback<DragStarter>(
    (startX, startY) => {
      const start = settings;
      const startIso = isoValue;
      const [minValue, maxValue] = valueRange;
      const perPixel = hounsfield ? HU_PER_PIXEL : (maxValue - minValue) * RANGE_FRACTION_PER_PIXEL;
      return (clientX, clientY) => {
        const dx = clientX - startX;
        const dy = clientY - startY;
        if (mode === 'dvr') {
          updateSettings({
            shiftHu: Math.round(clamp(start.shiftHu + dx * HU_PER_PIXEL, MIN_SHIFT_HU, MAX_SHIFT_HU)),
            opacityScale: clamp(
              start.opacityScale * Math.exp(-dy * OPACITY_EXPONENT_PER_PIXEL),
              MIN_OPACITY_SCALE,
              MAX_OPACITY_SCALE
            ),
          });
        } else if (mode === 'iso') {
          const value = clamp(startIso + dx * perPixel, minValue, maxValue);
          updateSettings({ isoValue: hounsfield ? Math.round(value) : value });
        }
      };
    },
    [settings, mode, isoValue, valueRange, hounsfield, updateSettings]
  );
  const handleDrag = usePointerDragMode({
    1: orbit.startRotate,
    2: orbit.startZoom,
    3: usesWindow ? startWlww : startAdjust,
    4: orbit.startPan,
  });

  const pick = useCallback(
    (e: PointerEvent<HTMLCanvasElement>) => {
      const grid = rendererRef.current?.grid;
      if (!grid) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * WIDTH;
      const y = ((e.clientY - rect.top) / rect.height) * HEIGHT;
      const point = pickPoint(volume, grid, rayForPixel(frame, x, y, WIDTH, HEIGHT), {
        mode,
        lut,
        opacityScale: settings.opacityScale,
        isoValue: toStoredValue(volume, isoValue),
        clipBox: settings.clipBox,
        cutPlane,
        perspective: frame.perspectiveDistanceMm > 0,
        labels,
      });
      if (point) onMprPositionChange(point);
    },
    [volume, frame, mode, settings, isoValue, lut, cutPlane, labels, onMprPositionChange]
  );

  // A shift+click picks; the rest of that press is ignored so it doesn't turn into a rotation.
  const pickingRef = useRef(false);
  const handlePointerEvent = useCallback(
    (e: PointerEvent<HTMLCanvasElement>) => {
      if (e.type === 'pointerdown' && e.shiftKey && e.button === 0 && e.buttons === 1) {
        pickingRef.current = true;
        pick(e);
      }
      if (pickingRef.current) {
        if (e.buttons === 0) pickingRef.current = false;
        return;
      }
      handleDrag(e);
    },
    [pick, handleDrag]
  );

  // React's wheel listener is passive, so preventDefault (to stop the page scrolling) needs a native one.
  const { zoomByWheel } = orbit;
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomByWheel(e.deltaY);
    };
    canvas.addEventListener('wheel', handleWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', handleWheel);
  }, [zoomByWheel]);

  return (
    <Box sx={{ display: 'flex', gap: 2, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <Box sx={{ position: 'relative', width: WIDTH, height: HEIGHT, maxWidth: '100%', flexShrink: 0 }}>
        <canvas
          ref={canvasRef}
          width={WIDTH}
          height={HEIGHT}
          style={{ width: '100%', height: '100%', display: 'block', backgroundColor: '#000', touchAction: 'none' }}
          onContextMenu={(e) => e.preventDefault()}
          // Stops the browser's middle-click autoscroll/paste so the middle button can drag.
          onMouseDown={(e) => {
            if (e.button === 1) e.preventDefault();
          }}
          onDoubleClick={resetCamera}
          onPointerDown={handlePointerEvent}
          onPointerMove={handlePointerEvent}
          onPointerUp={handlePointerEvent}
        />
        <canvas
          ref={overlayRef}
          width={WIDTH}
          height={HEIGHT}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
        />
        {error && (
          <Alert severity="error" sx={{ position: 'absolute', left: 8, right: 8, top: 8 }}>
            {error}
          </Alert>
        )}
      </Box>
      <VolumeRenderControls
        settings={{ ...settings, mode }}
        hasSegmentation={!!session}
        surfaceOpacity={surfaceOpacity}
        onSurfaceOpacityChange={(opacity) => segmentation?.setDisplay({ surfaceOpacity: opacity })}
        isoValue={isoValue}
        valueRange={valueRange}
        units={units}
        hounsfield={hounsfield}
        onChange={updateSettings}
        onResetView={resetCamera}
      />
    </Box>
  );
}
