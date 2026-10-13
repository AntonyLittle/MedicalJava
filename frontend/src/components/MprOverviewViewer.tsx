import { useCallback, useMemo, useState } from 'react';
import type { Volume } from '../api/types';
import { useCameraDrag } from '../hooks/useCameraDrag';
import { useFullVolumeRadioDensities } from '../hooks/useFullVolumeRadioDensities';
import { useViewerInteractions } from '../hooks/useViewerInteractions';
import {
  buildMprPlanes,
  multiplyQuaternions,
  normalizeQuaternion,
  quaternionFromAxisAngle,
  type MprPlanes,
  type Quaternion,
} from '../utils/canvasMath';
import { MPR_COLOR_BY_ORIENTATION } from '../utils/mprColors';
import { planeIntersectionInVolume, planeOutlineInVolume, projectToImage } from '../utils/planeOverlay';
import { volumeCentre, type PlaneOrientation, type ProjectionMode } from '../utils/mprSampler';
import { CanvasRenderer, type OverlayDrawer } from './CanvasRenderer';

const ORIENTATIONS: PlaneOrientation[] = ['axial', 'coronal', 'sagittal'];
const PLANE_FILL_ALPHA = 0.2;
const INTERSECTION_COLOR = '#ffffff';
const INTERSECTION_DASH = [6, 4];
const INTERSECTING_PAIRS: [PlaneOrientation, PlaneOrientation][] = [
  ['axial', 'coronal'],
  ['axial', 'sagittal'],
  ['coronal', 'sagittal'],
];

// Tilted so the three planes read as 3D from the start.
const DEFAULT_CAMERA_ROTATION: Quaternion = normalizeQuaternion(
  multiplyQuaternions(
    quaternionFromAxisAngle({ x: 0, y: 1, z: 0 }, (30 * Math.PI) / 180),
    quaternionFromAxisAngle({ x: 1, y: 0, z: 0 }, (-30 * Math.PI) / 180)
  )
);

interface MprOverviewViewerProps {
  volume: Volume;
  planes: MprPlanes;
  projectionMode: ProjectionMode;
  windowLevel: number;
  windowWidth: number;
  onWindowLevelChange: (level: number) => void;
  onWindowWidthChange: (width: number) => void;
}

export function MprOverviewViewer({
  volume,
  planes,
  projectionMode,
  windowLevel,
  windowWidth,
  onWindowLevelChange,
  onWindowWidthChange,
}: MprOverviewViewerProps) {
  const [cameraRotation, setCameraRotation] = useState<Quaternion>(DEFAULT_CAMERA_ROTATION);
  const centre = useMemo(() => volumeCentre(volume), [volume]);
  const camera = useMemo(() => buildMprPlanes(centre, cameraRotation).axial, [centre, cameraRotation]);
  const radioDensities = useFullVolumeRadioDensities(volume, camera, projectionMode);

  const startRotate = useCameraDrag(camera, cameraRotation, setCameraRotation);
  const { viewTransform, handlePointerEvent } = useViewerInteractions({
    windowLevel,
    windowWidth,
    onWindowLevelChange,
    onWindowWidthChange,
    startRotate,
  });

  const drawOverlay = useCallback<OverlayDrawer>(
    (context, project) => {
      const geometry = radioDensities?.geometry;
      if (!geometry) return;

      for (const orientation of ORIENTATIONS) {
        const outline = planeOutlineInVolume(volume, planes[orientation]);
        if (outline.length < 3) continue;

        context.beginPath();
        outline.forEach((point, i) => {
          const image = projectToImage(point, camera, volume, geometry);
          const canvasPoint = project(image.x, image.y);
          if (i === 0) context.moveTo(canvasPoint.x, canvasPoint.y);
          else context.lineTo(canvasPoint.x, canvasPoint.y);
        });
        context.closePath();

        context.fillStyle = MPR_COLOR_BY_ORIENTATION[orientation];
        context.globalAlpha = PLANE_FILL_ALPHA;
        context.fill();
        context.globalAlpha = 1;
        context.strokeStyle = MPR_COLOR_BY_ORIENTATION[orientation];
        context.lineWidth = 2;
        context.stroke();
      }

      context.strokeStyle = INTERSECTION_COLOR;
      context.lineWidth = 2;
      context.setLineDash(INTERSECTION_DASH);
      for (const [first, second] of INTERSECTING_PAIRS) {
        const segment = planeIntersectionInVolume(volume, planes[first], planes[second]);
        if (!segment) continue;

        const [start, end] = segment.map((point) => {
          const image = projectToImage(point, camera, volume, geometry);
          return project(image.x, image.y);
        });
        context.beginPath();
        context.moveTo(start.x, start.y);
        context.lineTo(end.x, end.y);
        context.stroke();
      }
      context.setLineDash([]);
    },
    [radioDensities, volume, planes, camera]
  );

  return (
    <CanvasRenderer
      width={400}
      height={400}
      radioDensities={radioDensities}
      windowLevel={windowLevel}
      windowWidth={windowWidth}
      viewTransform={viewTransform}
      drawOverlay={drawOverlay}
      onPointerDown={handlePointerEvent}
      onPointerMove={handlePointerEvent}
      onPointerUp={handlePointerEvent}
      onDoubleClick={() => setCameraRotation(DEFAULT_CAMERA_ROTATION)}
    />
  );
}
