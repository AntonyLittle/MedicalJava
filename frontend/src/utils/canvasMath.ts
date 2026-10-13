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
const ROTATION_RAD_PER_PIXEL = (0.5 * Math.PI) / 180;

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

// rightXyz/downXyz are the unit in-plane axes of the displayed image (columns increase along right, rows along down).
export type ViewablePlane = {
  positionXyz: Coordinate;
  normalXyz: Coordinate;
  rightXyz: Coordinate;
  downXyz: Coordinate;
};

export type Quaternion = { x: number; y: number; z: number; w: number };

export const IDENTITY_ROTATION: Quaternion = { x: 0, y: 0, z: 0, w: 1 };

export function crossProduct(a: Coordinate, b: Coordinate): Coordinate {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

export function quaternionFromAxisAngle(axis: Coordinate, angleRad: number): Quaternion {
  const s = Math.sin(angleRad / 2);
  return { x: axis.x * s, y: axis.y * s, z: axis.z * s, w: Math.cos(angleRad / 2) };
}

// Applies b first, then a.
export function multiplyQuaternions(a: Quaternion, b: Quaternion): Quaternion {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}

export function normalizeQuaternion(q: Quaternion): Quaternion {
  const length = Math.hypot(q.x, q.y, q.z, q.w);
  return { x: q.x / length, y: q.y / length, z: q.z / length, w: q.w / length };
}

export function rotateVector(q: Quaternion, v: Coordinate): Coordinate {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
}

export interface MprPlanes {
  axial: ViewablePlane;
  coronal: ViewablePlane;
  sagittal: ViewablePlane;
}

// The three planes share one point and stay mutually perpendicular; identity gives the standard orthogonal views.
export function buildMprPlanes(position: Coordinate, rotation: Quaternion): MprPlanes {
  const ex = rotateVector(rotation, { x: 1, y: 0, z: 0 });
  const ey = rotateVector(rotation, { x: 0, y: 1, z: 0 });
  const ez = rotateVector(rotation, { x: 0, y: 0, z: 1 });
  const negEz = { x: -ez.x, y: -ez.y, z: -ez.z };

  return {
    axial: { positionXyz: position, normalXyz: ez, rightXyz: ex, downXyz: ey },
    coronal: { positionXyz: position, normalXyz: ey, rightXyz: ex, downXyz: negEz },
    sagittal: { positionXyz: position, normalXyz: ex, rightXyz: ey, downXyz: negEz },
  };
}

// Drag down rolls the near side of the volume down; the plane tilts about its own image x axis.
export function computeRotationFromDrag(
  start: Quaternion,
  viewablePlane: ViewablePlane,
  startY: number,
  clientY: number
): Quaternion {
  const angle = -(clientY - startY) * ROTATION_RAD_PER_PIXEL;
  return normalizeQuaternion(multiplyQuaternions(quaternionFromAxisAngle(viewablePlane.rightXyz, angle), start));
}

// Free camera for views not tied to the shared MPR frame: vertical drag pitches, horizontal drag yaws.
export function computeCameraRotationFromDrag(
  start: Quaternion,
  viewablePlane: ViewablePlane,
  startX: number,
  startY: number,
  clientX: number,
  clientY: number
): Quaternion {
  const pitch = quaternionFromAxisAngle(viewablePlane.rightXyz, -(clientY - startY) * ROTATION_RAD_PER_PIXEL);
  const yaw = quaternionFromAxisAngle(viewablePlane.downXyz, (clientX - startX) * ROTATION_RAD_PER_PIXEL);
  return normalizeQuaternion(multiplyQuaternions(yaw, multiplyQuaternions(pitch, start)));
}

// Inverse of CanvasRenderer's pixel mapping; returns the canvas position of the centre of a source pixel.
export function sourceToCanvas(
  sourceX: number,
  sourceY: number,
  sourceWidth: number,
  sourceHeight: number,
  canvasWidth: number,
  canvasHeight: number,
  viewTransform: ViewTransform
): { x: number; y: number } {
  const scale = Math.max(sourceWidth / canvasWidth, sourceHeight / canvasHeight);
  const unzoomedX = (sourceX + 0.5) / scale;
  const unzoomedY = (sourceY + 0.5) / scale;
  return {
    x: (unzoomedX - canvasWidth / 2) * viewTransform.zoom + canvasWidth / 2 + viewTransform.panX,
    y: (unzoomedY - canvasHeight / 2) * viewTransform.zoom + canvasHeight / 2 + viewTransform.panY,
  };
}

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
    rightXyz: { ...viewablePlane.rightXyz },
    downXyz: { ...viewablePlane.downXyz },
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
