import type { Segment, SegmentAlgorithmType, Segmentation, Volume } from '../api/types';
import { LabelEdit, Labelmap } from './labelmap';
import { hexToRgb } from './overlay';

// Colours for new segments (and labels without one); the server uses the same list.
export const SEGMENT_PALETTE = [
  '#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4', '#46f0f0', '#f032e6', '#bcf60c',
  '#fabebe', '#008080', '#e6beff', '#9a6324', '#fffac8', '#800000', '#aaffc3', '#808000', '#ffd8b1',
];

export function paletteColor(label: number): string {
  return SEGMENT_PALETTE[(label - 1) % SEGMENT_PALETTE.length];
}

export interface SegmentState extends Segment {
  // A view setting; not saved.
  visible: boolean;
}

// Undo history is dropped, oldest first, beyond this many bytes of recorded changes.
const MAX_UNDO_BYTES = 256 * 1024 * 1024;

type Listener = () => void;

// A segmentation being viewed and edited: its labels, segment table and undo history. Mutable for speed; React
// subscribes and re-renders on getVersion() changes.
export class SegmentationSession {
  readonly volume: Volume;
  readonly labelmap: Labelmap;
  // The server's record as of the last load or save.
  saved: Segmentation;
  name: string;
  segments: SegmentState[];
  activeLabel: number;
  private savedLabelVersion: number;
  private metadataChanged = false;
  private undoStack: LabelEdit[] = [];
  private redoStack: LabelEdit[] = [];
  private version = 0;
  private colorTableCache: { key: string; table: Uint8Array } | null = null;
  private readonly listeners = new Set<Listener>();

  constructor(volume: Volume, saved: Segmentation, labels: Uint8Array) {
    const first = volume.slices[0];
    this.volume = volume;
    this.labelmap = new Labelmap(first.widthPixels, first.heightPixels, volume.slices.length, labels);
    this.saved = saved;
    this.name = saved.name;
    this.segments = saved.segments.map((s) => ({ ...s, visible: true }));
    this.activeLabel = this.segments[0]?.label ?? 0;
    this.savedLabelVersion = this.labelmap.version;
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;

  private notify(): void {
    this.version++;
    this.listeners.forEach((listener) => listener());
  }

  get labelsChanged(): boolean {
    return this.labelmap.version !== this.savedLabelVersion;
  }

  get metadataDirty(): boolean {
    return this.metadataChanged;
  }

  get dirty(): boolean {
    return this.labelsChanged || this.metadataChanged;
  }

  get activeSegment(): SegmentState | undefined {
    return this.segments.find((s) => s.label === this.activeLabel);
  }

  segmentFor(label: number): SegmentState | undefined {
    return this.segments.find((s) => s.label === label);
  }

  // ---- labels ----

  beginEdit(description: string): LabelEdit {
    return new LabelEdit(this.labelmap, description);
  }

  // Shows the edit's changes so far, e.g. during a stroke.
  preview(edit: LabelEdit): void {
    const before = this.labelmap.version;
    edit.flush();
    if (this.labelmap.version !== before) this.notify();
  }

  // Finishes an edit: it becomes undoable, and segments it changed are no longer purely automatic.
  commit(edit: LabelEdit): void {
    edit.flush();
    if (edit.length === 0) {
      this.notify();
      return;
    }
    this.undoStack.push(edit);
    this.redoStack = [];
    let bytes = this.undoStack.reduce((sum, e) => sum + e.byteSize, 0);
    while (bytes > MAX_UNDO_BYTES && this.undoStack.length > 1) bytes -= this.undoStack.shift()!.byteSize;
    for (const label of edit.touchedLabels()) {
      const segment = this.segmentFor(label);
      if (segment?.algorithmType === 'AUTOMATIC') this.setSegment(label, { algorithmType: 'SEMIAUTOMATIC' }, false);
    }
    this.notify();
  }

  // Reverts an unfinished edit (cancelled or failed); it isn't added to the history.
  discard(edit: LabelEdit): void {
    edit.flush();
    edit.undo();
    this.notify();
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get undoDescription(): string | undefined {
    return this.undoStack.at(-1)?.description;
  }

  get redoDescription(): string | undefined {
    return this.redoStack.at(-1)?.description;
  }

  undo(): void {
    const edit = this.undoStack.pop();
    if (!edit) return;
    edit.undo();
    this.redoStack.push(edit);
    this.notify();
  }

  redo(): void {
    const edit = this.redoStack.pop();
    if (!edit) return;
    edit.redo();
    this.undoStack.push(edit);
    this.notify();
  }

  // ---- segment table ----

  setActive(label: number): void {
    this.activeLabel = label;
    this.notify();
  }

  rename(name: string): void {
    this.name = name;
    this.metadataChanged = true;
    this.notify();
  }

  // Adds a segment with the lowest free label and makes it active; null when all 255 labels are taken.
  addSegment(name?: string): SegmentState | null {
    const used = new Set(this.segments.map((s) => s.label));
    let label = 1;
    while (label < 256 && (used.has(label) || this.labelmap.counts[label] > 0)) label++;
    if (label > 255) return null;
    const segment: SegmentState = {
      label,
      name: name ?? `Segment ${label}`,
      color: paletteColor(label),
      algorithmType: 'MANUAL',
      visible: true,
    };
    this.segments = [...this.segments, segment].sort((a, b) => a.label - b.label);
    this.activeLabel = label;
    this.metadataChanged = true;
    this.notify();
    return segment;
  }

  setSegment(label: number, changes: Partial<Omit<SegmentState, 'label'>>, notify = true): void {
    const persistent = Object.keys(changes).some((key) => key !== 'visible');
    this.segments = this.segments.map((s) => (s.label === label ? { ...s, ...changes } : s));
    if (persistent) this.metadataChanged = true;
    if (notify) this.notify();
  }

  // Removes the segment from the table; its voxels must be cleared separately (as an undoable edit).
  removeSegment(label: number): void {
    this.segments = this.segments.filter((s) => s.label !== label);
    if (this.activeLabel === label) this.activeLabel = this.segments[0]?.label ?? 0;
    this.metadataChanged = true;
    this.notify();
  }

  setAllVisible(visible: boolean): void {
    this.segments = this.segments.map((s) => ({ ...s, visible }));
    this.notify();
  }

  // RGBA per label (alpha 0 = hidden). Labels without a segment are shown in a palette colour. The same array is
  // returned until a colour or visibility changes.
  colorTable(): Uint8Array {
    const key = this.segments.map((s) => `${s.label}${s.color}${s.visible ? 1 : 0}`).join();
    if (this.colorTableCache?.key === key) return this.colorTableCache.table;
    const table = new Uint8Array(256 * 4);
    for (let label = 1; label < 256; label++) {
      const segment = this.segmentFor(label);
      const [r, g, b] = hexToRgb(segment?.color ?? paletteColor(label));
      table.set([r, g, b, segment && !segment.visible ? 0 : 255], label * 4);
    }
    this.colorTableCache = { key, table };
    return table;
  }

  // ---- saving ----

  segmentsForSave(): Segment[] {
    return this.segments.map(({ label, name, color, algorithmType }) => ({
      label,
      name,
      color,
      algorithmType: algorithmType as SegmentAlgorithmType,
    }));
  }

  // Records a successful save. labelVersion is the labelmap version that was uploaded (edits made while saving
  // stay unsaved); null when the labels weren't part of the save.
  markSaved(saved: Segmentation, labelVersion: number | null, metadataSaved: boolean): void {
    this.saved = saved;
    if (labelVersion !== null) this.savedLabelVersion = labelVersion;
    if (metadataSaved) this.metadataChanged = false;
    this.notify();
  }
}
