import { describe, expect, it } from 'vitest';
import type { Segmentation, Volume } from '../api/types';
import { makeVolume } from '../utils/testVolumes';
import {
  clearLabelJob,
  dilateJob,
  erodeJob,
  fillHolesJob,
  interpolateSlicesJob,
  keepLargestComponentJob,
  regionGrowJob,
  statisticsJob,
  thresholdJob,
} from './algorithms';
import { stampBrush } from './brush';
import { runJobSync } from './jobs';
import { LabelEdit, Labelmap } from './labelmap';
import { meshVolume, surfaceMeshJob } from './mesh';
import { renderLabelOverlay } from './overlay';
import { SegmentationSession } from './session';
import { mprImageMapping, sampleVoxelIndices, sliceImageMapping, voxelAt, voxelSpace } from './voxelSpace';
import { imageLayout } from '../utils/mprSampler';
import { buildMprPlanes, IDENTITY_ROTATION } from '../utils/canvasMath';

function cube(size = 12, depths?: number[], value = (i: number, j: number, k: number) => i + j * 100 + k * 10000) {
  return makeVolume({ width: size, height: size, depths: depths ?? Array.from({ length: size }, (_, k) => k), value });
}

function labelmapFor(volume: Volume): Labelmap {
  return new Labelmap(volume.slices[0].widthPixels, volume.slices[0].heightPixels, volume.slices.length);
}

function count(map: Labelmap, label: number): number {
  return map.data.reduce((n, l) => n + (l === label ? 1 : 0), 0);
}

function fillBox(map: Labelmap, label: number, [i0, j0, k0]: number[], [i1, j1, k1]: number[]): LabelEdit {
  const edit = new LabelEdit(map, 'box');
  for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) edit.set(map.index(i, j, k), label);
  edit.flush();
  return edit;
}


describe('Labelmap and LabelEdit', () => {
  it('tracks counts, changed regions and undo/redo', () => {
    const map = new Labelmap(4, 3, 2);
    expect(map.counts[0]).toBe(24);
    const edit = new LabelEdit(map, 'test');
    expect(edit.set(map.index(1, 2, 1), 5)).toBe(true);
    expect(edit.set(map.index(1, 2, 1), 5)).toBe(false);
    edit.set(map.index(3, 0, 0), 5);
    edit.set(map.index(3, 0, 0), 7);
    edit.flush();
    expect(map.counts[5]).toBe(1);
    expect(map.counts[7]).toBe(1);
    expect(map.changedSince(0)).toEqual({ min: [1, 0, 0], max: [3, 2, 1] });
    expect(map.changedSince(map.version)).toBeNull();

    edit.undo();
    expect(map.counts[0]).toBe(24);
    expect(map.data.every((l) => l === 0)).toBe(true);
    edit.redo();
    expect(map.data[map.index(3, 0, 0)]).toBe(7);
    expect(map.data[map.index(1, 2, 1)]).toBe(5);
    expect(edit.touchedLabels()).toEqual(new Set([5, 7]));
  });
});

describe('voxel lookups', () => {
  it('finds the nearest voxel of sheared, unevenly spaced stacks', () => {
    const volume = makeVolume({ width: 5, height: 4, depths: [0, 1, 3], spacingX: 2, shear: { x: 0.5, y: 0 }, value: () => 0 });
    const space = voxelSpace(volume);
    // Slice 2 is at depth 3 and shifted by 1.5 mm along x.
    expect(voxelAt(space, { x: 2 * 2 + 1.5, y: 1, z: 3.4 })).toEqual({ i: 2, j: 1, k: 2 });
    expect(voxelAt(space, { x: 0, y: 0, z: 1.9 })).toEqual({ i: 0, j: 0, k: 1 });
    expect(voxelAt(space, { x: 0, y: 0, z: 5 })).toBeNull();
    expect(voxelAt(space, { x: -3, y: 0, z: 0 })).toBeNull();
  });

  it('maps acquired slices and MPR images onto voxel indices', () => {
    const volume = cube(6);
    const space = voxelSpace(volume);
    const slice = sampleVoxelIndices(space, sliceImageMapping(volume, 2));
    expect(Array.from(slice.slice(0, 3))).toEqual([2 * 36, 2 * 36 + 1, 2 * 36 + 2]);

    // The axial MPR at z = 2 shows slice 2.
    const planes = buildMprPlanes({ x: 2.5, y: 2, z: 2 }, IDENTITY_ROTATION);
    const layout = imageLayout(volume, planes.axial);
    const indices = sampleVoxelIndices(space, mprImageMapping(volume, planes.axial, layout));
    expect(indices[0]).toBe(2 * 36);
    // The coronal plane at y = 2 shows row 2 of every slice; its top row is the last slice.
    const coronal = imageLayout(volume, planes.coronal);
    const coronalIndices = sampleVoxelIndices(space, mprImageMapping(volume, planes.coronal, coronal));
    expect(coronalIndices[0]).toBe(5 * 36 + 2 * 6);
  });
});

describe('brush', () => {
  it('paints a disc one voxel thick in the view plane, and a ball in 3D', () => {
    const volume = cube(11);
    const map = labelmapFor(volume);
    const edit = new LabelEdit(map, 'brush');
    const options = { radiusMm: 2, sphere: false, planeNormal: { x: 0, y: 0, z: 1 }, label: 1, erase: false, overwrite: false, range: null };
    stampBrush(volume, edit, { x: 5, y: 5, z: 5 }, options);
    // Integer points within radius 2 of a point: 13 in a disc.
    expect(count(map, 1)).toBe(13);
    expect(map.data[map.index(5, 5, 4)]).toBe(0);

    stampBrush(volume, edit, { x: 5, y: 5, z: 5 }, { ...options, label: 2, sphere: true, overwrite: false });
    // A ball of radius 2 holds 33 integer points; the 13 disc voxels belong to segment 1 and aren't overwritten.
    expect(count(map, 2)).toBe(33 - 13);
    stampBrush(volume, edit, { x: 5, y: 5, z: 5 }, { ...options, label: 2, sphere: true, overwrite: true });
    expect(count(map, 2)).toBe(33);

    stampBrush(volume, edit, { x: 5, y: 5, z: 5 }, { ...options, label: 2, erase: true });
    expect(count(map, 2)).toBe(33 - 13);
  });

  it('respects the value range', () => {
    const volume = cube(11, undefined, (i) => i);
    const map = labelmapFor(volume);
    const edit = new LabelEdit(map, 'brush');
    stampBrush(volume, edit, { x: 5, y: 5, z: 5 }, {
      radiusMm: 3, sphere: false, planeNormal: { x: 0, y: 0, z: 1 }, label: 1, erase: false, overwrite: false, range: [5, 100],
    });
    for (let i = 0; i < 11; i++) {
      if (i < 5) expect(map.data[map.index(i, 5, 5)]).toBe(0);
      else if (i <= 8) expect(map.data[map.index(i, 5, 5)]).toBe(1);
    }
  });
});

describe('algorithms', () => {
  it('thresholds and grows regions within a value range', () => {
    // Two bright blocks separated by a dark gap along x.
    const volume = cube(10, undefined, (i, j, k) => ((i < 4 || i > 5) && j > 1 && j < 8 && k > 1 && k < 8 ? 100 : 0));
    const map = labelmapFor(volume);
    const threshold = new LabelEdit(map, 'threshold');
    expect(runJobSync(thresholdJob(volume, threshold, { label: 1, low: 50, high: 200, overwrite: false }))).toBe(2 * 4 * 6 * 6);
    threshold.undo();

    const grow = new LabelEdit(map, 'grow');
    const grown = runJobSync(regionGrowJob(volume, grow, { i: 1, j: 4, k: 4 }, { label: 2, low: 50, high: 200, overwrite: false }));
    expect(grown).toBe(4 * 6 * 6);
    expect(map.data[map.index(8, 4, 4)]).toBe(0);
    // A seed outside the range does nothing.
    expect(runJobSync(regionGrowJob(volume, grow, { i: 4, j: 4, k: 4 }, { label: 2, low: 50, high: 200, overwrite: false }))).toBe(0);
  });

  it('dilates and erodes by a distance in millimetres', () => {
    const volume = cube(15, undefined, () => 0);
    const map = labelmapFor(volume);
    fillBox(map, 1, [7, 7, 7], [7, 7, 7]);
    runJobSync(dilateJob(volume, new LabelEdit(map, 'dilate'), { label: 1, radiusMm: 2, overwrite: false }));
    expect(count(map, 1)).toBe(33);
    runJobSync(erodeJob(volume, new LabelEdit(map, 'erode'), { label: 1, radiusMm: 1, overwrite: false }));
    // Only voxels more than 1 mm from the outside remain: the centre and its 6 neighbours.
    expect(count(map, 1)).toBe(7);
  });

  it('fills cavities, keeps the largest piece, clears and interpolates', () => {
    const volume = cube(12, undefined, () => 0);
    const map = labelmapFor(volume);
    fillBox(map, 1, [2, 2, 2], [8, 8, 8]);
    const hollow = new LabelEdit(map, 'hollow');
    for (let k = 4; k <= 6; k++) for (let j = 4; j <= 6; j++) for (let i = 4; i <= 6; i++) hollow.set(map.index(i, j, k), 0);
    fillBox(map, 1, [10, 10, 10], [10, 10, 10]);
    expect(count(map, 1)).toBe(343 - 27 + 1);

    runJobSync(fillHolesJob(new LabelEdit(map, 'fill'), 1, false, false));
    expect(count(map, 1)).toBe(343 + 1);
    runJobSync(keepLargestComponentJob(new LabelEdit(map, 'largest'), 1));
    expect(count(map, 1)).toBe(343);
    runJobSync(clearLabelJob(new LabelEdit(map, 'clear'), 1));
    expect(count(map, 1)).toBe(0);

    // Squares of side 3 on slices 2 and 8 become squares on every slice in between.
    fillBox(map, 3, [4, 4, 2], [6, 6, 2]);
    fillBox(map, 3, [4, 4, 8], [6, 6, 8]);
    runJobSync(interpolateSlicesJob(volume, new LabelEdit(map, 'interpolate'), 3, false));
    for (let k = 2; k <= 8; k++) {
      expect(map.data[map.index(5, 5, k)]).toBe(3);
      expect(map.data[map.index(3, 5, k)]).toBe(0);
    }
    expect(count(map, 3)).toBe(7 * 9);
  });

  it('computes statistics with each slice as thick as its share of the stack', () => {
    const volume = cube(4, [0, 1, 3, 4], (i) => i * 10);
    const map = labelmapFor(volume);
    fillBox(map, 1, [0, 0, 1], [3, 0, 2]);
    const [stats] = runJobSync(statisticsJob(volume, map));
    expect(stats.voxelCount).toBe(8);
    expect(stats.mean).toBe(15);
    expect(stats.min).toBe(0);
    expect(stats.max).toBe(30);
    // Slices 1 and 2 stand for 1.5 mm each.
    expect(stats.volumeMl).toBeCloseTo((8 * 1.5) / 1000);
  });
});

describe('surface mesh', () => {
  it('encloses about the segment volume, facing outwards', () => {
    const volume = cube(16, undefined, () => 0);
    const map = labelmapFor(volume);
    fillBox(map, 1, [3, 3, 3], [10, 10, 10]);
    const mesh = runJobSync(surfaceMeshJob(volume, map, 1))!;
    expect(mesh.triangles.length % 3).toBe(0);
    const enclosed = meshVolume(mesh);
    // Surface nets cut the corners of the 8³ voxel block (8³ mm³ when every voxel counts in full).
    expect(enclosed).toBeGreaterThan(7 * 7 * 7);
    expect(enclosed).toBeLessThan(8 * 8 * 8);
    expect(runJobSync(surfaceMeshJob(volume, map, 2))).toBeNull();
  });
});

describe('overlay and session', () => {
  const saved: Segmentation = {
    segmentationId: 1, volumeId: 1, patientId: 1, name: 'S', source: 'manual', revision: 1, createdAt: '', modifiedAt: '',
    voxelCount: 0, stale: false, segments: [{ label: 1, name: 'A', color: '#ff0000', algorithmType: 'AUTOMATIC' }],
  };

  it('draws filled segments with opaque outlines, hiding invisible ones', () => {
    const volume = cube(6, undefined, () => 0);
    const session = new SegmentationSession(volume, { ...saved, voxelCount: 216 }, new Uint8Array(216));
    const edit = session.beginEdit('box');
    for (let j = 1; j <= 3; j++) for (let i = 1; i <= 3; i++) edit.set(session.labelmap.index(i, j, 0), 1);
    session.commit(edit);
    expect(session.dirty).toBe(true);
    // Editing an automatic segment makes it semi-automatic.
    expect(session.segments[0].algorithmType).toBe('SEMIAUTOMATIC');

    const space = voxelSpace(volume);
    const indices = sampleVoxelIndices(space, sliceImageMapping(volume, 0));
    const rgba = new Uint8ClampedArray(36 * 4);
    const style = { colors: session.colorTable(), fillOpacity: 0.5, outline: true };
    expect(renderLabelOverlay(volume, session.labelmap, indices, 6, 6, style, rgba)).toBe(true);
    const at = (i: number, j: number) => Array.from(rgba.slice((j * 6 + i) * 4, (j * 6 + i) * 4 + 4));
    expect(at(1, 1)).toEqual([255, 0, 0, 255]);
    expect(at(2, 2)).toEqual([255, 0, 0, 128]);
    expect(at(0, 0)[3]).toBe(0);

    session.setSegment(1, { visible: false });
    const hidden = { ...style, colors: session.colorTable() };
    expect(renderLabelOverlay(volume, session.labelmap, indices, 6, 6, hidden, rgba)).toBe(false);

    session.undo();
    expect(session.labelmap.counts[1]).toBe(0);
    session.redo();
    expect(session.labelmap.counts[1]).toBe(9);
    const version = session.labelmap.version;
    session.markSaved({ ...saved, revision: 2 }, version, true);
    expect(session.dirty).toBe(false);
  });
});
