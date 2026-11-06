import { rotateVector, type Coordinate, type Quaternion } from '../utils/canvasMath';

export type Projection = 'orthographic' | 'perspective';

// Vertical field of view of the perspective camera.
const TAN_HALF_FOV = Math.tan((30 * Math.PI) / 180 / 2);
// Leaves a margin round the volume at zoom 1.
const FIT_MARGIN = 1.05;

// Orbit about the volume centre: identity rotation is a frontal (anterior) view with the head up.
export interface OrbitCameraState {
  rotation: Quaternion;
  // Offset of the orbit target from the volume centre.
  panMm: Coordinate;
  zoom: number;
}

// right × down = forward; forward points away from the viewer.
export interface CameraFrame {
  target: Coordinate;
  right: Coordinate;
  down: Coordinate;
  forward: Coordinate;
  // Half the view size at the target.
  halfWidthMm: number;
  halfHeightMm: number;
  // Eye distance from the target; 0 for an orthographic camera.
  perspectiveDistanceMm: number;
}

export interface Ray {
  origin: Coordinate;
  direction: Coordinate;
}

export function add(a: Coordinate, b: Coordinate): Coordinate {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function subtract(a: Coordinate, b: Coordinate): Coordinate {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function scale(a: Coordinate, s: number): Coordinate {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

export function dot(a: Coordinate, b: Coordinate): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function normalize(a: Coordinate): Coordinate {
  const length = Math.hypot(a.x, a.y, a.z);
  return length > 0 ? scale(a, 1 / length) : a;
}

export function cameraAxes(rotation: Quaternion): Pick<CameraFrame, 'right' | 'down' | 'forward'> {
  return {
    right: rotateVector(rotation, { x: 1, y: 0, z: 0 }),
    down: rotateVector(rotation, { x: 0, y: 0, z: -1 }),
    forward: rotateVector(rotation, { x: 0, y: 1, z: 0 }),
  };
}

// fitRadiusMm is the radius of a sphere that should just fit in the view at zoom 1.
export function cameraFrame(
  state: OrbitCameraState,
  centre: Coordinate,
  fitRadiusMm: number,
  aspect: number,
  projection: Projection
): CameraFrame {
  const fitHalf = (fitRadiusMm * FIT_MARGIN) / state.zoom;
  const halfHeightMm = aspect >= 1 ? fitHalf : fitHalf / aspect;
  return {
    ...cameraAxes(state.rotation),
    target: add(centre, state.panMm),
    halfWidthMm: halfHeightMm * aspect,
    halfHeightMm,
    perspectiveDistanceMm: projection === 'perspective' ? halfHeightMm / TAN_HALF_FOV : 0,
  };
}

export function cameraEye(frame: CameraFrame): Coordinate {
  return subtract(frame.target, scale(frame.forward, frame.perspectiveDistanceMm));
}

// Canvas position (x right, y down, in pixels) to ray; matches the ray set-up in raycast.frag.
export function rayForPixel(frame: CameraFrame, x: number, y: number, width: number, height: number): Ray {
  const ndcX = (x / width) * 2 - 1;
  const ndcDown = (y / height) * 2 - 1;
  const offset = add(scale(frame.right, ndcX * frame.halfWidthMm), scale(frame.down, ndcDown * frame.halfHeightMm));
  if (frame.perspectiveDistanceMm > 0) {
    return {
      origin: cameraEye(frame),
      direction: normalize(add(scale(frame.forward, frame.perspectiveDistanceMm), offset)),
    };
  }
  return { origin: add(frame.target, offset), direction: frame.forward };
}

// Canvas pixel position of a point; null when it is behind a perspective camera.
export function projectToCanvas(
  frame: CameraFrame,
  point: Coordinate,
  width: number,
  height: number
): { x: number; y: number } | null {
  let ndcX: number;
  let ndcDown: number;
  if (frame.perspectiveDistanceMm > 0) {
    const relative = subtract(point, cameraEye(frame));
    const depth = dot(relative, frame.forward);
    if (depth <= 1e-3) return null;
    const perspective = frame.perspectiveDistanceMm / depth;
    ndcX = (dot(relative, frame.right) * perspective) / frame.halfWidthMm;
    ndcDown = (dot(relative, frame.down) * perspective) / frame.halfHeightMm;
  } else {
    const relative = subtract(point, frame.target);
    ndcX = dot(relative, frame.right) / frame.halfWidthMm;
    ndcDown = dot(relative, frame.down) / frame.halfHeightMm;
  }
  return { x: ((ndcX + 1) / 2) * width, y: ((ndcDown + 1) / 2) * height };
}
