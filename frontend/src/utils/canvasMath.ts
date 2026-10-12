const MIN_WINDOW_LEVEL = -2000;
const MAX_WINDOW_LEVEL = 2000;
const MIN_WINDOW_WIDTH = 1;
const MAX_WINDOW_WIDTH = 4000;

// Drag sensitivity: pixels of mouse movement per unit of change.
const PIXELS_PER_SLICE = 4;
const WINDOW_LEVEL_PER_PIXEL = 2;
const WINDOW_WIDTH_PER_PIXEL = 4;

// Wheel sensitivity: deltaY units (varies by device) per slice step.
const WHEEL_DELTA_PER_SLICE = 50;

// Right-drag-only = slice scrub, right+left-drag = window level/width (DICOM viewer convention).
export type DragMode = 'slice' | 'wlww' | null;

export interface DragAnchor {
  x: number;
  y: number;
  sliceIndex: number;
  windowLevel: number;
  windowWidth: number;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function computeSliceDragIndex(
  anchor: Pick<DragAnchor, 'y' | 'sliceIndex'>,
  clientY: number,
  maxIndex: number
): number {
  const delta = Math.round((anchor.y - clientY) / PIXELS_PER_SLICE);
  return clamp(anchor.sliceIndex + delta, 0, maxIndex);
}

export function computeWindowLevelFromDrag(anchor: Pick<DragAnchor, 'x' | 'windowLevel'>, clientX: number): number {
  const newLevel = anchor.windowLevel + (clientX - anchor.x) * WINDOW_LEVEL_PER_PIXEL;
  return clamp(newLevel, MIN_WINDOW_LEVEL, MAX_WINDOW_LEVEL);
}

export function computeWindowWidthFromDrag(anchor: Pick<DragAnchor, 'y' | 'windowWidth'>, clientY: number): number {
  const newWidth = anchor.windowWidth + (anchor.y - clientY) * WINDOW_WIDTH_PER_PIXEL;
  return clamp(newWidth, MIN_WINDOW_WIDTH, MAX_WINDOW_WIDTH);
}

export function computeWheelSliceSteps(accumulated: number): { steps: number; remainder: number } {
  const steps = Math.trunc(accumulated / WHEEL_DELTA_PER_SLICE);
  return { steps, remainder: accumulated - steps * WHEEL_DELTA_PER_SLICE };
}
