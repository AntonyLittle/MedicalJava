import { useGpuMprImage } from '../hooks/useGpuMprImage';
import { useThickMprRadioDensities } from '../hooks/useThickMprRadioDensities';
import type { ProjectionMode } from '../utils/mprSampler';
import { MprViewerCanvas, type MprViewerCanvasProps } from './MprViewerCanvas';

interface ThickMprVolumeViewerProps extends MprViewerCanvasProps {
  slabThicknessMm: number;
  projectionMode: ProjectionMode;
}

export function ThickMprVolumeViewer({ slabThicknessMm, projectionMode, ...canvasProps }: ThickMprVolumeViewerProps) {
  const gpu = useGpuMprImage(canvasProps.volume, canvasProps.viewablePlane, canvasProps.windowLevel, canvasProps.windowWidth, {
    slab: { thicknessMm: slabThicknessMm, mode: projectionMode },
  });
  const radioDensities = useThickMprRadioDensities(
    canvasProps.volume,
    canvasProps.viewablePlane,
    slabThicknessMm,
    projectionMode,
    !gpu.active
  );

  return <MprViewerCanvas image={gpu.image} radioDensities={radioDensities} {...canvasProps} />;
}
