import { forwardRef, useCallback, useEffect, useMemo, useRef } from 'react';
import type { PointerEvent } from 'react';
import type { RadioDensities } from '../api/types';
import { fitImageScale, IDENTITY_VIEW_TRANSFORM, sourceToCanvas, type ViewTransform } from '../utils/canvasMath';
import { mergeRefs } from '../utils/mergeRefs';

// Canvas pixels per source pixel at which the image switches from smoothed to blocky voxels.
const VOXEL_VIEW_MAGNIFICATION = 4;

// project() maps image pixel coordinates of the radioDensities to canvas coordinates, including pan and zoom.
export type OverlayDrawer = (
  context: CanvasRenderingContext2D,
  project: (imageX: number, imageY: number) => { x: number; y: number }
) => void;

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
  onDoubleClick?: () => void;
  borderColor?: string;
  drawOverlay?: OverlayDrawer;
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

// Indexed by value + LUT_OFFSET so any 16-bit voxel value maps without per-pixel window arithmetic.
const LUT_OFFSET = 32768;
const LUT_SIZE = 65536;

function buildGrayLut(windowLevel: number, windowWidth: number): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(LUT_SIZE);
  for (let i = 0; i < LUT_SIZE; i++) lut[i] = voxelToGray(i - LUT_OFFSET, windowLevel, windowWidth);
  return lut;
}

// The windowed image at source resolution; panning and zooming only redraw it, they don't rebuild it.
interface SourceImage {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  imageData: ImageData;
  densities: RadioDensities;
  lut: Uint8ClampedArray;
}

function paintSourceImage(previous: SourceImage | null, densities: RadioDensities, lut: Uint8ClampedArray): SourceImage | null {
  const { widthPixels, heightPixels, radiodensities } = densities;

  let canvas = previous?.canvas;
  let context = previous?.context;
  let imageData = previous?.imageData;
  if (!canvas || !context || !imageData || canvas.width !== widthPixels || canvas.height !== heightPixels) {
    canvas = document.createElement('canvas');
    canvas.width = widthPixels;
    canvas.height = heightPixels;
    context = canvas.getContext('2d') ?? undefined;
    if (!context) return null;
    imageData = context.createImageData(widthPixels, heightPixels);
  }

  const data = imageData.data;
  const pixelCount = widthPixels * heightPixels;
  for (let i = 0, offset = 0; i < pixelCount; i++, offset += 4) {
    const index = Math.min(LUT_SIZE - 1, Math.max(0, Math.round(radiodensities[i]) + LUT_OFFSET));
    const gray = lut[index];
    data[offset] = gray;
    data[offset + 1] = gray;
    data[offset + 2] = gray;
    data[offset + 3] = 255;
  }
  context.putImageData(imageData, 0, 0);

  return { canvas, context, imageData, densities, lut };
}

export const CanvasRenderer = forwardRef<HTMLCanvasElement, CanvasRendererProps>(function CanvasRenderer(
  { width, height, radioDensities, windowLevel, windowWidth, viewTransform = IDENTITY_VIEW_TRANSFORM, onPointerDown, onPointerMove, onPointerUp, onDoubleClick, borderColor, drawOverlay },
  forwardedRef
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const setCanvasRef = useCallback(
    (node: HTMLCanvasElement | null) => mergeRefs(canvasRef, forwardedRef)(node),
    [forwardedRef]
  );

  const lut = useMemo(() => buildGrayLut(windowLevel, windowWidth), [windowLevel, windowWidth]);
  const sourceImageRef = useRef<SourceImage | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!radioDensities || !canvas) return;

    // Assigning width/height clears and reallocates the canvas, so only do it when the size changed.
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;

    const context = canvas.getContext('2d');
    if (!context) return;

    let source = sourceImageRef.current;
    if (!source || source.densities !== radioDensities || source.lut !== lut) {
      source = paintSourceImage(source, radioDensities, lut);
      sourceImageRef.current = source;
    }
    if (!source) return;

    const { widthPixels, heightPixels, geometry } = radioDensities;
    const spacing = geometry && { u: geometry.spacingUMm, v: geometry.spacingVMm };
    const imageScale = fitImageScale(widthPixels, heightPixels, width, height, spacing);

    context.setTransform(1, 0, 0, 1, 0, 0);
    context.fillStyle = '#000';
    context.fillRect(0, 0, width, height);
    // Smooth normally, but show individual voxels once they are magnified enough to be worth seeing.
    const magnification = Math.min(imageScale.x, imageScale.y) * viewTransform.zoom;
    context.imageSmoothingEnabled = magnification < VOXEL_VIEW_MAGNIFICATION;
    context.imageSmoothingQuality = 'high';
    // Zoom about the canvas centre, then pan.
    context.setTransform(
      imageScale.x * viewTransform.zoom,
      0,
      0,
      imageScale.y * viewTransform.zoom,
      (width / 2) * (1 - viewTransform.zoom) + viewTransform.panX,
      (height / 2) * (1 - viewTransform.zoom) + viewTransform.panY
    );
    context.drawImage(source.canvas, 0, 0);
    context.setTransform(1, 0, 0, 1, 0, 0);

    drawOverlay?.(context, (imageX, imageY) =>
      sourceToCanvas(imageX, imageY, widthPixels, heightPixels, width, height, viewTransform, spacing)
    );
  }, [radioDensities, lut, viewTransform, drawOverlay, width, height]);

  return (
    <canvas
      ref={setCanvasRef}
      style={{
        maxWidth: '100%',
        backgroundColor: '#000',
        touchAction: 'none',
        ...(borderColor && { border: `3px solid ${borderColor}`, boxSizing: 'border-box' }),
      }}
      onContextMenu={(e) => e.preventDefault()}
      // Stops the browser's middle-click autoscroll/paste so the middle button can drag.
      onMouseDown={(e) => {
        if (e.button === 1) e.preventDefault();
      }}
      onDoubleClick={onDoubleClick}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    />
  );
});
