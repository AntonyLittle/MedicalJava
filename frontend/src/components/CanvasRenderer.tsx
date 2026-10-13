import { forwardRef, useCallback, useEffect, useRef } from 'react';
import type { PointerEvent } from 'react';
import type { RadioDensities } from '../api/types';
import { IDENTITY_VIEW_TRANSFORM, type ViewTransform } from '../utils/canvasMath';
import { mergeRefs } from '../utils/mergeRefs';

interface CanvasRendererProps {
  width: number;
  height: number;
  radioDensities?: RadioDensities;
  windowLevel: number;
  windowWidth: number;
  viewTransform?: ViewTransform;
  onPointerDown?: (e: PointerEvent<HTMLCanvasElement>) => void;
  onPointerMove?: (e: PointerEvent<HTMLCanvasElement>) => void;
  onPointerUp?: (e: PointerEvent<HTMLCanvasElement>) => void;
}

// Maps a Hounsfield Unit value to a 0-255 grayscale value via window level/width.
function voxelToGray(hu: number, windowLevel: number, windowWidth: number): number {
  const halfWidth = windowWidth / 2;
  const lowerBound = windowLevel - halfWidth;
  const upperBound = windowLevel + halfWidth;

  if (hu <= lowerBound) return 0;
  if (hu >= upperBound) return 255;

  return Math.round(((hu - lowerBound) / (upperBound - lowerBound)) * 255);
}

export const CanvasRenderer = forwardRef<HTMLCanvasElement, CanvasRendererProps>(function CanvasRenderer(
  { width, height, radioDensities, windowLevel, windowWidth, viewTransform = IDENTITY_VIEW_TRANSFORM, onPointerDown, onPointerMove, onPointerUp },
  forwardedRef
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const setCanvasRef = useCallback(
    (node: HTMLCanvasElement | null) => mergeRefs(canvasRef, forwardedRef)(node),
    [forwardedRef]
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!radioDensities || !canvas) return;

    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext('2d');
    if (!context) return;

    blitAndScaleRadiodensities(radioDensities.radiodensities, radioDensities.widthPixels, radioDensities.heightPixels, context, width, height);

  }, [radioDensities, windowLevel, windowWidth, viewTransform, width, height]);

  function blitAndScaleRadiodensities(
    radiodensities: ArrayLike<number>,
    radiodensityWidth: number,
    radiodensityHeight: number,
    context: CanvasRenderingContext2D,
    canvasWidth: number,
    canvasHeight: number
  ) {

    const imageData = context.createImageData(canvasWidth, canvasHeight);
    const data = imageData.data;

    let xScale = radiodensityWidth / canvasWidth;
    let yScale = radiodensityHeight / canvasHeight;
    let scale = Math.max(xScale, yScale);

    for (let y = 0; y < canvasHeight; y++) {
      for (let x = 0; x < canvasWidth; x++) {
        const offset = ((y * canvasWidth) + x) * 4;

        // Inverse of the view transform: canvas pixel -> unzoomed, unpanned canvas pixel.
        const unzoomedX = (x - canvasWidth / 2 - viewTransform.panX) / viewTransform.zoom + canvasWidth / 2;
        const unzoomedY = (y - canvasHeight / 2 - viewTransform.panY) / viewTransform.zoom + canvasHeight / 2;
        const radiodensityX = Math.floor(unzoomedX * scale);
        const radiodensityY = Math.floor(unzoomedY * scale);

        if (radiodensityY >= 0 && radiodensityX >= 0 && radiodensityY < radiodensityHeight && radiodensityX < radiodensityWidth) {
          const intensity = (radiodensityY * radiodensityWidth) + radiodensityX;
          const gray = voxelToGray(radiodensities[intensity], windowLevel, windowWidth);

          data[offset] = gray;
          data[offset + 1] = gray;
          data[offset + 2] = gray;
        } else {
          data[offset] = 0;
          data[offset + 1] = 0;
          data[offset + 2] = 0;
        }
        data[offset + 3] = 255;
      }
    }
    context.putImageData(imageData, 0, 0);
  }

  return (
    <canvas
      ref={setCanvasRef}
      style={{ maxWidth: '100%', backgroundColor: '#000', touchAction: 'none' }}
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    />
  );
});
