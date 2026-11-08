// A segmentation's labels: one uint8 per voxel of the volume (0 = background), slices back to back in the volume's
// order, so voxel (i, j, k) is at k * width * height + j * width + i. Edits go through LabelEdit, which keeps the
// per-label voxel counts current and records what changed for undo and for consumers that update incrementally.

// Inclusive voxel index ranges.
export interface VoxelBox {
  min: [number, number, number];
  max: [number, number, number];
}

interface Change {
  version: number;
  box: VoxelBox;
}

// Consumers further behind than this many changes reload everything.
const CHANGE_LOG_SIZE = 64;

export function emptyBox(): VoxelBox {
  return { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
}

export function isEmptyBox(box: VoxelBox): boolean {
  return box.min[0] > box.max[0];
}

export function unionBox(a: VoxelBox, b: VoxelBox): VoxelBox {
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
  };
}

export class Labelmap {
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  readonly sliceSize: number;
  readonly data: Uint8Array;
  // Voxels per label.
  readonly counts = new Float64Array(256);
  // Increases with every published change.
  version = 0;
  private changes: Change[] = [];

  constructor(width: number, height: number, depth: number, data?: Uint8Array) {
    this.width = width;
    this.height = height;
    this.depth = depth;
    this.sliceSize = width * height;
    const size = this.sliceSize * depth;
    if (data && data.length !== size) throw new Error(`Expected ${size} labels, got ${data.length}`);
    this.data = data ?? new Uint8Array(size);
    for (let i = 0; i < this.data.length; i++) this.counts[this.data[i]]++;
  }

  index(i: number, j: number, k: number): number {
    return k * this.sliceSize + j * this.width + i;
  }

  get fullBox(): VoxelBox {
    return { min: [0, 0, 0], max: [this.width - 1, this.height - 1, this.depth - 1] };
  }

  // Records that the voxels in box changed; returns the new version.
  publish(box: VoxelBox): number {
    this.version++;
    this.changes.push({ version: this.version, box });
    if (this.changes.length > CHANGE_LOG_SIZE) this.changes.shift();
    return this.version;
  }

  // The region changed after `version`: null when nothing did, 'all' when the log no longer reaches back that far.
  changedSince(version: number): VoxelBox | 'all' | null {
    if (version >= this.version) return null;
    const first = this.changes[0];
    if (!first || first.version > version + 1) return 'all';
    let box = emptyBox();
    for (const change of this.changes) if (change.version > version) box = unionBox(box, change.box);
    return box;
  }

  // Bounding box of the voxels with the label, or null when there are none.
  boundsOf(label: number): VoxelBox | null {
    if (this.counts[label] === 0) return null;
    const box = emptyBox();
    const { width, height, depth, data } = this;
    for (let k = 0; k < depth; k++) {
      const base = k * this.sliceSize;
      for (let j = 0; j < height; j++) {
        const row = base + j * width;
        for (let i = 0; i < width; i++) {
          if (data[row + i] !== label) continue;
          if (i < box.min[0]) box.min[0] = i;
          if (i > box.max[0]) box.max[0] = i;
          if (j < box.min[1]) box.min[1] = j;
          if (j > box.max[1]) box.max[1] = j;
          if (k < box.min[2]) box.min[2] = k;
          if (k > box.max[2]) box.max[2] = k;
        }
      }
    }
    return box;
  }
}

// Changes made by one user action (a brush stroke, a threshold, ...): the voxels' indices with their values before
// and after, in the order they were made, so undo replays `before` backwards and redo replays `after` forwards.
export class LabelEdit {
  readonly labelmap: Labelmap;
  readonly description: string;
  private indices = new Uint32Array(1024);
  private before = new Uint8Array(1024);
  private after = new Uint8Array(1024);
  length = 0;
  // Everything this edit touched, and what changed since the last flush().
  box = emptyBox();
  private pending = emptyBox();

  constructor(labelmap: Labelmap, description: string) {
    this.labelmap = labelmap;
    this.description = description;
  }

  get byteSize(): number {
    return this.length * 6;
  }

  // Sets voxel `index` to `value`; returns whether it changed.
  set(index: number, value: number): boolean {
    const map = this.labelmap;
    const old = map.data[index];
    if (old === value) return false;
    if (this.length === this.indices.length) this.grow();
    this.indices[this.length] = index;
    this.before[this.length] = old;
    this.after[this.length] = value;
    this.length++;
    map.data[index] = value;
    map.counts[old]--;
    map.counts[value]++;

    const k = (index / map.sliceSize) | 0;
    const rest = index - k * map.sliceSize;
    const j = (rest / map.width) | 0;
    const i = rest - j * map.width;
    const p = this.pending;
    if (i < p.min[0]) p.min[0] = i;
    if (i > p.max[0]) p.max[0] = i;
    if (j < p.min[1]) p.min[1] = j;
    if (j > p.max[1]) p.max[1] = j;
    if (k < p.min[2]) p.min[2] = k;
    if (k > p.max[2]) p.max[2] = k;
    return true;
  }

  // Publishes the changes made since the last flush, so views can show a stroke while it is drawn.
  flush(): void {
    if (isEmptyBox(this.pending)) return;
    this.box = unionBox(this.box, this.pending);
    this.labelmap.publish(this.pending);
    this.pending = emptyBox();
  }

  undo(): void {
    const { data, counts } = this.labelmap;
    for (let n = this.length - 1; n >= 0; n--) {
      const index = this.indices[n];
      counts[data[index]]--;
      data[index] = this.before[n];
      counts[this.before[n]]++;
    }
    if (this.length > 0) this.labelmap.publish(this.box);
  }

  redo(): void {
    const { data, counts } = this.labelmap;
    for (let n = 0; n < this.length; n++) {
      const index = this.indices[n];
      counts[data[index]]--;
      data[index] = this.after[n];
      counts[this.after[n]]++;
    }
    if (this.length > 0) this.labelmap.publish(this.box);
  }

  // Labels whose voxels this edit added or removed.
  touchedLabels(): Set<number> {
    const labels = new Set<number>();
    for (let n = 0; n < this.length; n++) {
      labels.add(this.before[n]);
      labels.add(this.after[n]);
    }
    labels.delete(0);
    return labels;
  }

  private grow(): void {
    const size = this.indices.length * 2;
    const indices = new Uint32Array(size);
    indices.set(this.indices);
    const before = new Uint8Array(size);
    before.set(this.before);
    const after = new Uint8Array(size);
    after.set(this.after);
    this.indices = indices;
    this.before = before;
    this.after = after;
  }
}
