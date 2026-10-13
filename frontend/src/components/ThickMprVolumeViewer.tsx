import { useThickMprRadioDensities } from '../hooks/useThickMprRadioDensities';
import type { ProjectionMode } from '../utils/mprSampler';
import { MprViewerCanvas, type MprViewerCanvasProps } from './MprViewerCanvas';

interface ThickMprVolumeViewerProps extends MprViewerCanvasProps {
  slabThicknessMm: number;
  projectionMode: ProjectionMode;
}

export function ThickMprVolumeViewer({ slabThicknessMm, projectionMode, ...canvasProps }: ThickMprVolumeViewerProps) {
  const radioDensities = useThickMprRadioDensities(
    canvasProps.volume,
    canvasProps.viewablePlane,
    slabThicknessMm,
    projectionMode
  );

  return <MprViewerCanvas radioDensities={radioDensities} {...canvasProps} />;
}
