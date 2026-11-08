import { createContext, useContext } from 'react';
import type { LabelEdit } from '../segmentation/labelmap';
import type { SegmentationSession } from '../segmentation/session';

export type SegmentationTool = 'navigate' | 'brush' | 'eraser' | 'grow';

export interface SegmentationToolSettings {
  tool: SegmentationTool;
  brushRadiusMm: number;
  // A ball instead of a disc in the view plane.
  sphere: boolean;
  // Painting, growing and filling may replace other segments' voxels.
  overwrite: boolean;
  // Brush, threshold and region growing only take voxels in `range` (real units, e.g. HU).
  rangeEnabled: boolean;
  range: [number, number];
  // Shows the voxels in range on the 2D views.
  previewRange: boolean;
  // Region growing without a range takes voxels within this much (real units) of the seed's value.
  growTolerance: number;
}

export interface SegmentationDisplaySettings {
  showOverlay: boolean;
  // Fill opacity on the 2D views; outlines are opaque.
  fillOpacity: number;
  outline: boolean;
  // Opacity of segment surfaces in the 3D view.
  surfaceOpacity: number;
}

export interface SegmentationBusy {
  description: string;
  progress: number;
}

export interface SegmentationContextValue {
  session: SegmentationSession | null;
  // Changes whenever the session does, so consumers re-render.
  version: number;
  setSession: (session: SegmentationSession | null) => void;
  tools: SegmentationToolSettings;
  setTools: (changes: Partial<SegmentationToolSettings>) => void;
  display: SegmentationDisplaySettings;
  setDisplay: (changes: Partial<SegmentationDisplaySettings>) => void;
  // A long-running edit in progress, which blocks others.
  busy: SegmentationBusy | null;
  // Runs a time-sliced edit of the session's labels as one undoable step; resolves with its result.
  runEdit: <T>(description: string, job: (edit: LabelEdit) => Generator<number, T, void>) => Promise<T | undefined>;
  // Runs other long work (statistics, meshes) with the same progress display.
  runTask: <T>(description: string, job: Generator<number, T, void>) => Promise<T | undefined>;
  // Asks before discarding unsaved changes; true when there are none or the user agrees.
  confirmDiscard: () => boolean;
  error: string | null;
  setError: (error: string | null) => void;
}

export const DEFAULT_TOOLS: SegmentationToolSettings = {
  tool: 'navigate',
  brushRadiusMm: 5,
  sphere: false,
  overwrite: false,
  rangeEnabled: false,
  range: [200, 3000],
  previewRange: false,
  growTolerance: 100,
};

export const DEFAULT_DISPLAY: SegmentationDisplaySettings = {
  showOverlay: true,
  fillOpacity: 0.4,
  outline: true,
  surfaceOpacity: 1,
};

export const SegmentationContext = createContext<SegmentationContextValue | null>(null);

// The segmentation state; null outside a SegmentationProvider (viewers then show no segmentation).
export function useSegmentation(): SegmentationContextValue | null {
  return useContext(SegmentationContext);
}
