import { useCallback, useMemo, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import type { Volume } from '../api/types';
import type { OverlayDrawer } from '../components/CanvasRenderer';
import { regionGrowJob } from '../segmentation/algorithms';
import { strokeBrush, stampBrush, type BrushOptions } from '../segmentation/brush';
import type { LabelEdit } from '../segmentation/labelmap';
import { hexToRgb, renderLabelOverlay } from '../segmentation/overlay';
import {
  imagePointToPatient,
  sampleVoxelIndices,
  voxelAt,
  voxelSpace,
  type ImageMapping,
} from '../segmentation/voxelSpace';
import { canvasToSource, type Coordinate, type ViewTransform } from '../utils/canvasMath';
import { toStoredValue, valueSlope } from '../utils/volumeValues';
import { useSegmentation } from './segmentationContext';

const RANGE_PREVIEW_COLOR: [number, number, number] = [255, 214, 0];

interface SegmentationViewParams {
  volume: Volume;
  // How the displayed image sits in patient space; null while there is no image.
  mapping: ImageMapping | null;
  canvasWidth: number;
  canvasHeight: number;
  viewTransform: ViewTransform;
}

export interface SegmentationView {
  // Draws the labels (and the brush outline) over the image; undefined without a segmentation.
  drawOverlay: OverlayDrawer | undefined;
  // Handles the event when a segmentation tool uses it; returns false to let the viewer's navigation have it.
  handlePointer: (e: PointerEvent<HTMLCanvasElement>) => boolean;
  handlePointerLeave: () => void;
}

interface Stroke {
  edit: LabelEdit;
  last: Coordinate;
  options: BrushOptions;
}

interface OverlayImage {
  canvas: HTMLCanvasElement;
}

function length(v: Coordinate): number {
  return Math.hypot(v.x, v.y, v.z);
}

// The segmentation layer of a 2D view: overlay drawing and the brush, eraser and region-growing tools. Left drag
// (or click) uses the active tool; Ctrl + left drag still pans.
export function useSegmentationView({
  volume,
  mapping,
  canvasWidth,
  canvasHeight,
  viewTransform,
}: SegmentationViewParams): SegmentationView {
  const segmentation = useSegmentation();
  const session = segmentation?.session?.volume === volume ? segmentation.session : null;
  // Read on every render: the context re-renders this view whenever the session changes.
  const labelVersion = session?.labelmap.version;
  const colors = session?.colorTable();
  const tools = segmentation?.tools;
  const display = segmentation?.display;
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const strokeRef = useRef<Stroke | null>(null);

  const indices = useMemo(
    () => (session && mapping ? sampleVoxelIndices(voxelSpace(volume), mapping) : null),
    [session, mapping, volume]
  );

  const previewing = !!tools?.rangeEnabled && !!tools.previewRange;
  const range = tools?.range;
  const rangePreview = useMemo(() => {
    if (!previewing || !range) return null;
    return { low: toStoredValue(volume, range[0]), high: toStoredValue(volume, range[1]), color: RANGE_PREVIEW_COLOR };
  }, [previewing, range, volume]);

  // Reused while the image keeps its size.
  const width = mapping?.widthPixels ?? 0;
  const height = mapping?.heightPixels ?? 0;
  const target = useMemo(() => {
    if (!session || width === 0 || height === 0) return null;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    return context && { canvas, context, image: context.createImageData(width, height) };
  }, [session, width, height]);

  const overlay = useMemo<OverlayImage | null>(() => {
    if (!session || !indices || !target || !display?.showOverlay) return null;
    const style = { colors: colors!, fillOpacity: display.fillOpacity, outline: display.outline, preview: rangePreview };
    // The labels are edited in place; their version says when they changed.
    void labelVersion;
    if (!renderLabelOverlay(volume, session.labelmap, indices, width, height, style, target.image.data)) return null;
    target.context.putImageData(target.image, 0, 0);
    return { canvas: target.canvas };
  }, [session, indices, target, width, height, display?.showOverlay, display?.fillOpacity, display?.outline, rangePreview, labelVersion, colors, volume]);

  const brushing = !!session && (tools?.tool === 'brush' || tools?.tool === 'eraser');
  const activeColor = session?.activeSegment?.color ?? '#ffffff';
  const drawOverlay = useCallback<OverlayDrawer>(
    (context, project) => {
      const origin = project(0, 0);
      const right = project(1, 0);
      const down = project(0, 1);
      const scaleX = right.x - origin.x;
      const scaleY = down.y - origin.y;
      if (overlay) {
        context.save();
        context.imageSmoothingEnabled = false;
        context.setTransform(scaleX, 0, 0, scaleY, origin.x - scaleX / 2, origin.y - scaleY / 2);
        context.drawImage(overlay.canvas, 0, 0);
        context.restore();
      }
      if (brushing && cursor && mapping && tools) {
        const radiusX = (tools.brushRadiusMm * scaleX) / length(mapping.columnStep);
        const radiusY = (tools.brushRadiusMm * scaleY) / length(mapping.rowStep);
        const [r, g, b] = hexToRgb(activeColor);
        context.save();
        context.strokeStyle = `rgb(${r}, ${g}, ${b})`;
        context.lineWidth = 1.5;
        if (tools.tool === 'eraser') context.setLineDash([4, 3]);
        context.beginPath();
        context.ellipse(cursor.x, cursor.y, Math.max(1, radiusX), Math.max(1, radiusY), 0, 0, 2 * Math.PI);
        context.stroke();
        context.restore();
      }
    },
    [overlay, brushing, cursor, mapping, tools, activeColor]
  );

  // Canvas drawing-buffer position of the pointer (the canvas may be scaled and has a border).
  const canvasPoint = useCallback(
    (e: PointerEvent<HTMLCanvasElement>) => {
      const canvas = e.currentTarget;
      const rect = canvas.getBoundingClientRect();
      return {
        x: ((e.clientX - rect.left - canvas.clientLeft) * canvasWidth) / canvas.clientWidth,
        y: ((e.clientY - rect.top - canvas.clientTop) * canvasHeight) / canvas.clientHeight,
      };
    },
    [canvasWidth, canvasHeight]
  );

  const patientPoint = useCallback(
    (point: { x: number; y: number }): Coordinate | null => {
      if (!mapping) return null;
      const spacing = { u: length(mapping.columnStep), v: length(mapping.rowStep) };
      const source = canvasToSource(
        point.x,
        point.y,
        mapping.widthPixels,
        mapping.heightPixels,
        canvasWidth,
        canvasHeight,
        viewTransform,
        spacing
      );
      return imagePointToPatient(mapping, source.x, source.y);
    },
    [mapping, canvasWidth, canvasHeight, viewTransform]
  );

  const handlePointer = useCallback(
    (e: PointerEvent<HTMLCanvasElement>): boolean => {
      if (!segmentation || !session || !mapping || !tools) return false;
      const stroke = strokeRef.current;
      if (stroke) {
        const point = canvasPoint(e);
        setCursor(point);
        if (e.type === 'pointermove' && e.buttons & 1) {
          const patient = patientPoint(point);
          if (patient) {
            strokeBrush(volume, stroke.edit, stroke.last, patient, stroke.options);
            stroke.last = patient;
            session.preview(stroke.edit);
          }
        }
        if (e.buttons === 0 || e.type === 'pointerup' || e.type === 'pointercancel') {
          strokeRef.current = null;
          session.commit(stroke.edit);
          if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
        }
        e.preventDefault();
        return true;
      }

      const { tool } = tools;
      if (tool === 'navigate') return false;
      if (e.type === 'pointermove' && e.buttons === 0) {
        if (tool === 'brush' || tool === 'eraser') setCursor(canvasPoint(e));
        return false;
      }
      if (e.type !== 'pointerdown' || e.button !== 0 || e.buttons !== 1 || e.ctrlKey || e.metaKey) return false;
      e.preventDefault();
      if (segmentation.busy) return true;
      const label = session.activeLabel;
      if (!label) {
        segmentation.setError('Add a segment to the segmentation first.');
        return true;
      }
      const patient = patientPoint(canvasPoint(e));
      if (!patient) return true;
      const storedRange: [number, number] | null = tools.rangeEnabled
        ? [toStoredValue(volume, tools.range[0]), toStoredValue(volume, tools.range[1])]
        : null;

      if (tool === 'grow') {
        const seed = voxelAt(voxelSpace(volume), patient);
        if (!seed) return true;
        let [low, high] = storedRange ?? [0, 0];
        if (!storedRange) {
          const value = volume.slices[seed.k].radiodensities[seed.j * volume.slices[seed.k].widthPixels + seed.i];
          const tolerance = tools.growTolerance / valueSlope(volume);
          [low, high] = [value - tolerance, value + tolerance];
        }
        void segmentation.runEdit('Region growing', (edit) =>
          regionGrowJob(volume, edit, seed, { label, low, high, overwrite: tools.overwrite })
        );
        return true;
      }

      const options: BrushOptions = {
        radiusMm: tools.brushRadiusMm,
        sphere: tools.sphere,
        planeNormal: mapping.normal,
        label,
        erase: tool === 'eraser',
        overwrite: tools.overwrite,
        range: storedRange,
      };
      const edit = session.beginEdit(tool === 'eraser' ? 'Erase' : 'Paint');
      stampBrush(volume, edit, patient, options);
      session.preview(edit);
      strokeRef.current = { edit, last: patient, options };
      e.currentTarget.setPointerCapture(e.pointerId);
      return true;
    },
    [segmentation, session, mapping, tools, canvasPoint, patientPoint, volume]
  );

  const handlePointerLeave = useCallback(() => {
    if (!strokeRef.current) setCursor(null);
  }, []);

  return { drawOverlay: session ? drawOverlay : undefined, handlePointer, handlePointerLeave };
}
