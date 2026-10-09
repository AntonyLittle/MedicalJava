import { useEffect, useRef } from 'react';
import type { Volume } from '../api/types';

interface CanvasRendererProps {
  volume: Volume;
  sliceIndex: number;
  windowLevel: number;
  windowWidth: number;
  onSliceIndexChange: (index: number) => void;
  onWindowLevelChange: (level: number) => void;
  onWindowWidthChange: (width: number) => void;
}

const MIN_WINDOW_LEVEL = -2000;
const MAX_WINDOW_LEVEL = 2000;
const MIN_WINDOW_WIDTH = 1;
const MAX_WINDOW_WIDTH = 4000;

// Drag sensitivity: pixels of mouse movement per unit of change.
const PIXELS_PER_SLICE = 4;
const WINDOW_LEVEL_PER_PIXEL = 2;
const WINDOW_WIDTH_PER_PIXEL = 4;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// Right-drag-only = slice scrub, right+left-drag = window level/width (DICOM viewer convention).
type DragMode = 'slice' | 'wlww' | null;

interface DragAnchor {
  x: number;
  y: number;
  sliceIndex: number;
  windowLevel: number;
  windowWidth: number;
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

export function CanvasRenderer({
  volume,
  sliceIndex,
  windowLevel,
  windowWidth,
  onSliceIndexChange,
  onWindowLevelChange,
  onWindowWidthChange,
}: CanvasRendererProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragModeRef = useRef<DragMode>(null);
  const dragAnchorRef = useRef<DragAnchor | null>(null);
  const lastButtonsRef = useRef(0);

  useEffect(() => {
    const slice = volume.slices[sliceIndex];
    const canvas = canvasRef.current;
    if (!slice || !canvas) return;

    canvas.width = slice.width;
    canvas.height = slice.height;

    const context = canvas.getContext('2d');
    if (!context) return;

    const imageData = context.createImageData(slice.width, slice.height);
    const data = imageData.data;
    const { radiodensities } = slice;

    for (let i = 0; i < radiodensities.length; i++) {
      const gray = voxelToGray(radiodensities[i], windowLevel, windowWidth);
      const offset = i * 4;
      data[offset] = gray;
      data[offset + 1] = gray;
      data[offset + 2] = gray;
      data[offset + 3] = 255;
    }

    context.putImageData(imageData, 0, 0);
  }, [volume, sliceIndex, windowLevel, windowWidth]);

  // Pressing/releasing a secondary button while another is already held does not fire a new
  // pointerdown/pointerup (only pointermove with an updated `buttons` mask), so every pointer
  // event is routed through here to detect button-combination changes and re-anchor the drag.
  function handlePointerEvent(e: React.PointerEvent<HTMLCanvasElement>) {
    if (e.buttons !== lastButtonsRef.current) {
      lastButtonsRef.current = e.buttons;

      if (e.buttons === 2) {
        dragModeRef.current = 'slice';
        dragAnchorRef.current = { x: e.clientX, y: e.clientY, sliceIndex, windowLevel, windowWidth };
      } else if (e.buttons === 3) {
        dragModeRef.current = 'wlww';
        dragAnchorRef.current = { x: e.clientX, y: e.clientY, sliceIndex, windowLevel, windowWidth };
      } else {
        dragModeRef.current = null;
        dragAnchorRef.current = null;
      }
    }

    if (e.buttons === 0) {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } else {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
    }

    const mode = dragModeRef.current;
    const anchor = dragAnchorRef.current;
    if (!mode || !anchor) return;

    if (mode === 'slice') {
      const maxIndex = volume.slices.length - 1;
      const delta = Math.round((anchor.y - e.clientY) / PIXELS_PER_SLICE);
      onSliceIndexChange(clamp(anchor.sliceIndex + delta, 0, maxIndex));
    } else {
      const newLevel = anchor.windowLevel + (e.clientX - anchor.x) * WINDOW_LEVEL_PER_PIXEL;
      const newWidth = anchor.windowWidth + (anchor.y - e.clientY) * WINDOW_WIDTH_PER_PIXEL;
      onWindowLevelChange(clamp(newLevel, MIN_WINDOW_LEVEL, MAX_WINDOW_LEVEL));
      onWindowWidthChange(clamp(newWidth, MIN_WINDOW_WIDTH, MAX_WINDOW_WIDTH));
    }
  }

  return (
    <canvas
      ref={canvasRef}
      style={{ maxWidth: '100%', backgroundColor: '#000', touchAction: 'none' }}
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={handlePointerEvent}
      onPointerMove={handlePointerEvent}
      onPointerUp={handlePointerEvent}
    />
  );
}
