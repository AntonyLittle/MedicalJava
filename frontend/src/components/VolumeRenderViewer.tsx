import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import { Alert, Box } from '@mui/material';
import type { Volume } from '../api/types';
import { useOrbitCamera } from '../hooks/useOrbitCamera';
import { usePointerDragMode, type DragStarter } from '../hooks/usePointerDragMode';
import { useWlwwDrag } from '../hooks/useWlwwDrag';
import { projectToCanvas, rayForPixel, type CameraFrame } from '../render3d/camera';
import { cutPlaneFromViewablePlane, FULL_CLIP_BOX } from '../render3d/clipping';
import { pickPoint } from '../render3d/pick';
import { buildTransferLut, CT_VALUE_OFFSET, TRANSFER_PRESETS, type RgbColor } from '../render3d/transferFunctions';
import { VolumeRenderer, type RenderParams } from '../render3d/VolumeRenderer';
import { clamp, type Coordinate, type MprPlanes } from '../utils/canvasMath';
import { MPR_COLOR_BY_ORIENTATION } from '../utils/mprColors';
import { getVolumeBounds, volumeCentre, type PlaneOrientation } from '../utils/mprSampler';
import { planeIntersectionInVolume, planeOutlineInVolume } from '../utils/planeOverlay';
import {
  MAX_ISO_HU,
  MAX_OPACITY_SCALE,
  MAX_SHIFT_HU,
  MIN_ISO_HU,
  MIN_OPACITY_SCALE,
  MIN_SHIFT_HU,
  VolumeRenderControls,
  type RenderQuality,
  type VolumeRenderSettings,
} from './VolumeRenderControls';

const WIDTH = 512;
const CONTEXT_ATTRIBUTES: WebGLContextAttributes = {
  alpha: false,
  antialias: false,
  depth: false,
  powerPreference: 'high-performance',
};
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
  isoValue: 300,
  projection: 'orthographic',
  quality: 'standard',
  clipBox: FULL_CLIP_BOX,
  cutPlane: 'none',
  flipCut: false,
  showMprPlanes: true,
};

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

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<VolumeRenderer | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped when a lost WebGL context is restored, to rebuild every GPU resource.
  const [contextVersion, setContextVersion] = useState(0);

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

  const preset = TRANSFER_PRESETS.find((p) => p.id === settings.presetId) ?? TRANSFER_PRESETS[0];
  const lut = useMemo(() => buildTransferLut(preset, settings.shiftHu), [preset, settings.shiftHu]);

  const cutOrientation = settings.cutPlane;
  const cutViewablePlane = cutOrientation === 'none' ? null : planes[cutOrientation];
  const cutPlane = useMemo(
    () => (cutViewablePlane ? cutPlaneFromViewablePlane(cutViewablePlane, settings.flipCut) : null),
    [cutViewablePlane, settings.flipCut]
  );

  // The window only affects the greyscale modes; ignoring it otherwise avoids needless re-renders.
  const usesWindow = settings.mode === 'mip' || settings.mode === 'minip' || settings.mode === 'average';
  const renderWindowLevel = usesWindow ? windowLevel : 0;
  const renderWindowWidth = usesWindow ? windowWidth : 1;

  const renderParams = useMemo<RenderParams>(
    () => ({
      mode: settings.mode,
      camera: frame,
      lut,
      opacityScale: settings.opacityScale,
      shading: settings.shading ? 1 : 0,
      windowLevel: renderWindowLevel,
      windowWidth: renderWindowWidth,
      isoValue: settings.isoValue + CT_VALUE_OFFSET,
      isoColor: ISO_COLOR,
      clipBox: settings.clipBox,
      cutPlane,
      stepFactor: STEP_FACTOR[settings.quality],
      skipEmpty: true,
    }),
    [settings, frame, lut, renderWindowLevel, renderWindowWidth, cutPlane]
  );

  // The renderer is created lazily in draw(); losing the context invalidates it, and a restore triggers a redraw.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handleLost = (e: Event) => {
      e.preventDefault();
      rendererRef.current = null;
    };
    const handleRestored = () => setContextVersion((v) => v + 1);
    canvas.addEventListener('webglcontextlost', handleLost);
    canvas.addEventListener('webglcontextrestored', handleRestored);
    return () => {
      canvas.removeEventListener('webglcontextlost', handleLost);
      canvas.removeEventListener('webglcontextrestored', handleRestored);
      rendererRef.current?.dispose();
      rendererRef.current = null;
    };
  }, []);

  // Preview immediately, refine once the parameters have been stable for a moment.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const draw = (preview: boolean) => {
      try {
        let renderer = rendererRef.current;
        if (!renderer) {
          const gl = canvas.getContext('webgl2', CONTEXT_ATTRIBUTES);
          if (!gl) throw new Error('3D rendering needs WebGL2, which this browser does not provide.');
          if (gl.isContextLost()) return;
          renderer = new VolumeRenderer(gl);
          rendererRef.current = renderer;
        }
        renderer.setVolume(volume);

        const scale = preview ? PREVIEW_RESOLUTION_SCALE : 1;
        const width = Math.round(WIDTH * scale);
        const height = Math.round(HEIGHT * scale);
        // Assigning the size reallocates the drawing buffer, so only do it when it changes.
        if (canvas.width !== width) canvas.width = width;
        if (canvas.height !== height) canvas.height = height;
        renderer.render({
          ...renderParams,
          stepFactor: renderParams.stepFactor * (preview ? PREVIEW_STEP_MULTIPLIER : 1),
        });
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
  }, [volume, renderParams, contextVersion]);

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
      return (clientX, clientY) => {
        const dx = clientX - startX;
        const dy = clientY - startY;
        if (start.mode === 'dvr') {
          updateSettings({
            shiftHu: Math.round(clamp(start.shiftHu + dx * HU_PER_PIXEL, MIN_SHIFT_HU, MAX_SHIFT_HU)),
            opacityScale: clamp(
              start.opacityScale * Math.exp(-dy * OPACITY_EXPONENT_PER_PIXEL),
              MIN_OPACITY_SCALE,
              MAX_OPACITY_SCALE
            ),
          });
        } else if (start.mode === 'iso') {
          updateSettings({ isoValue: Math.round(clamp(start.isoValue + dx * HU_PER_PIXEL, MIN_ISO_HU, MAX_ISO_HU)) });
        }
      };
    },
    [settings, updateSettings]
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
        mode: settings.mode,
        lut,
        opacityScale: settings.opacityScale,
        isoValue: settings.isoValue + CT_VALUE_OFFSET,
        clipBox: settings.clipBox,
        cutPlane,
        perspective: frame.perspectiveDistanceMm > 0,
      });
      if (point) onMprPositionChange(point);
    },
    [volume, frame, settings, lut, cutPlane, onMprPositionChange]
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
      <VolumeRenderControls settings={settings} onChange={updateSettings} onResetView={resetCamera} />
    </Box>
  );
}
