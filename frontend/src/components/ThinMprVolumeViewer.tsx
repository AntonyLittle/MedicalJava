import { useGpuMprImage } from '../hooks/useGpuMprImage';
import { useThinMprRadioDensities } from '../hooks/useThinMprRadioDensities';
import { MprViewerCanvas, type MprViewerCanvasProps } from './MprViewerCanvas';

export function ThinMprVolumeViewer(props: MprViewerCanvasProps) {
  const gpu = useGpuMprImage(props.volume, props.viewablePlane, props.windowLevel, props.windowWidth);
  const radioDensities = useThinMprRadioDensities(props.volume, props.viewablePlane, !gpu.active);

  return <MprViewerCanvas image={gpu.image} radioDensities={radioDensities} {...props} />;
}
