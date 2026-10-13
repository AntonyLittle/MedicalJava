const MIN_WINDOW_LEVEL = -2000;
const MAX_WINDOW_LEVEL = 2000;
const MIN_WINDOW_WIDTH = 1;
const MAX_WINDOW_WIDTH = 4000;

// Drag sensitivity: pixels of mouse movement per unit of change.
const WINDOW_LEVEL_PER_PIXEL = 2;
const WINDOW_WIDTH_PER_PIXEL = 4;
const ZOOM_EXPONENT_PER_PIXEL = 0.01;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 16;

// Wheel sensitivity: deltaY units (varies by device) per slice step.
const WHEEL_DELTA_PER_SLICE = 50;

// Pan is a canvas-pixel offset of the image centre; zoom is a scale factor about the canvas centre.
export interface ViewTransform {
  panX: number;
  panY: number;
  zoom: number;
}

export const IDENTITY_VIEW_TRANSFORM: ViewTransform = { panX: 0, panY: 0, zoom: 1 };

export type Coordinate = {
  x: number;
  y: number;
  z: number
};

export type ViewablePlane = {
  positionXyz: Coordinate;
  normalXyz: Coordinate;
};

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function clampToBounds(Coordinate: Coordinate, min: Coordinate, max: Coordinate): Coordinate {
  return {
    x: clamp(Coordinate.x, min.x, max.x),
    y: clamp(Coordinate.y, min.y, max.y),
    z: clamp(Coordinate.z, min.z, max.z)
  };
}

export function moveViewablePlaneForward(viewablePlane: ViewablePlane, distanceMm: number): ViewablePlane {
  return {
    positionXyz: {
      x: viewablePlane.positionXyz.x + (viewablePlane.normalXyz.x * distanceMm),
      y: viewablePlane.positionXyz.y + (viewablePlane.normalXyz.y * distanceMm),
      z: viewablePlane.positionXyz.z + (viewablePlane.normalXyz.z * distanceMm),
    },
    normalXyz: { ...viewablePlane.normalXyz },
  };
}

export function computeWindowLevelFromDrag(startLevel: number, startX: number, clientX: number): number {
  const newLevel = startLevel + (clientX - startX) * WINDOW_LEVEL_PER_PIXEL;
  return clamp(newLevel, MIN_WINDOW_LEVEL, MAX_WINDOW_LEVEL);
}

export function computeWindowWidthFromDrag(startWidth: number, startY: number, clientY: number): number {
  const newWidth = startWidth + (startY - clientY) * WINDOW_WIDTH_PER_PIXEL;
  return clamp(newWidth, MIN_WINDOW_WIDTH, MAX_WINDOW_WIDTH);
}

export function computePanFromDrag(
  start: ViewTransform,
  startX: number,
  startY: number,
  clientX: number,
  clientY: number
): ViewTransform {
  return { ...start, panX: start.panX + (clientX - startX), panY: start.panY + (clientY - startY) };
}

// Drag up zooms in; pan scales with zoom so the point at the canvas centre stays fixed.
export function computeZoomFromDrag(start: ViewTransform, startY: number, clientY: number): ViewTransform {
  const zoom = clamp(start.zoom * Math.exp((startY - clientY) * ZOOM_EXPONENT_PER_PIXEL), MIN_ZOOM, MAX_ZOOM);
  const ratio = zoom / start.zoom;
  return { panX: start.panX * ratio, panY: start.panY * ratio, zoom };
}

export function computeWheelSliceSteps(accumulated: number): { steps: number; remainder: number } {
  const steps = Math.trunc(accumulated / WHEEL_DELTA_PER_SLICE);
  return { steps, remainder: accumulated - steps * WHEEL_DELTA_PER_SLICE };
}
