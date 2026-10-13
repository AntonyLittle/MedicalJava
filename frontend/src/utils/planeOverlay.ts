import type { ImageGeometry, Volume } from '../api/types';
import type { Coordinate, ViewablePlane } from './canvasMath';
import { volumeCentre, volumeCorners } from './mprSampler';

const EPSILON = 1e-6;

function subtract(a: Coordinate, b: Coordinate): Coordinate {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function dot(a: Coordinate, b: Coordinate): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function isSamePoint(a: Coordinate, b: Coordinate): boolean {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z) < EPSILON;
}

// Convex polygon where the plane cuts the volume's bounding box, ordered around its centre; empty if it misses.
export function planeOutlineInVolume(volume: Volume, plane: ViewablePlane): Coordinate[] {
  const corners = volumeCorners(volume);
  const distances = corners.map((corner) => dot(subtract(corner, plane.positionXyz), plane.normalXyz));
  const points: Coordinate[] = [];
  const addUnique = (point: Coordinate) => {
    if (!points.some((existing) => isSamePoint(existing, point))) points.push(point);
  };

  for (let i = 0; i < 8; i++) {
    if (Math.abs(distances[i]) < EPSILON) addUnique(corners[i]);
    for (const bit of [1, 2, 4]) {
      if (i & bit) continue;
      const j = i | bit;
      const di = distances[i];
      const dj = distances[j];
      if (Math.abs(di) < EPSILON || Math.abs(dj) < EPSILON || di * dj > 0) continue;

      const t = di / (di - dj);
      addUnique({
        x: corners[i].x + (corners[j].x - corners[i].x) * t,
        y: corners[i].y + (corners[j].y - corners[i].y) * t,
        z: corners[i].z + (corners[j].z - corners[i].z) * t,
      });
    }
  }
  if (points.length < 3) return [];

  const centroid = {
    x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
    y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
    z: points.reduce((sum, p) => sum + p.z, 0) / points.length,
  };
  const angleOf = (p: Coordinate) => {
    const relative = subtract(p, centroid);
    return Math.atan2(dot(relative, plane.downXyz), dot(relative, plane.rightXyz));
  };
  return points.sort((a, b) => angleOf(a) - angleOf(b));
}

// Segment where two planes meet inside the volume: plane A's outline clipped by plane B. Null if parallel or disjoint.
export function planeIntersectionInVolume(
  volume: Volume,
  planeA: ViewablePlane,
  planeB: ViewablePlane
): [Coordinate, Coordinate] | null {
  const outline = planeOutlineInVolume(volume, planeA);
  if (outline.length < 3) return null;

  const distances = outline.map((point) => dot(subtract(point, planeB.positionXyz), planeB.normalXyz));
  if (distances.every((d) => Math.abs(d) < EPSILON)) return null;

  const points: Coordinate[] = [];
  const addUnique = (point: Coordinate) => {
    if (!points.some((existing) => isSamePoint(existing, point))) points.push(point);
  };
  for (let i = 0; i < outline.length; i++) {
    const j = (i + 1) % outline.length;
    const di = distances[i];
    const dj = distances[j];
    if (Math.abs(di) < EPSILON) addUnique(outline[i]);
    if (Math.abs(di) < EPSILON || Math.abs(dj) < EPSILON || di * dj > 0) continue;

    const t = di / (di - dj);
    addUnique({
      x: outline[i].x + (outline[j].x - outline[i].x) * t,
      y: outline[i].y + (outline[j].y - outline[i].y) * t,
      z: outline[i].z + (outline[j].z - outline[i].z) * t,
    });
  }
  return points.length >= 2 ? [points[0], points[1]] : null;
}

// Image pixel coordinates of a patient-space point as seen by a projection image with the given geometry.
export function projectToImage(
  point: Coordinate,
  camera: Pick<ViewablePlane, 'rightXyz' | 'downXyz'>,
  volume: Volume,
  geometry: ImageGeometry
): { x: number; y: number } {
  const relative = subtract(point, volumeCentre(volume));
  return {
    x: (dot(relative, camera.rightXyz) - geometry.uMinMm) / geometry.spacingMm,
    y: (dot(relative, camera.downXyz) - geometry.vMinMm) / geometry.spacingMm,
  };
}
