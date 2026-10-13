import { useThinMprRadioDensities } from '../hooks/useThinMprRadioDensities';
import { MprViewerCanvas, type MprViewerCanvasProps } from './MprViewerCanvas';

export function ThinMprVolumeViewer(props: MprViewerCanvasProps) {
  const radioDensities = useThinMprRadioDensities(props.volume, props.viewablePlane);

  return <MprViewerCanvas radioDensities={radioDensities} {...props} />;
}
