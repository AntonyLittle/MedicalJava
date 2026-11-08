import type { Volume } from '../api/types';
import type { Labelmap } from './labelmap';

export interface OverlayStyle {
  // 256 RGBA entries; label l is drawn when colors[4l + 3] > 0.
  colors: Uint8Array;
  // Opacity of the fill inside a segment, 0..1; its outline is always opaque.
  fillOpacity: number;
  outline: boolean;
  // Voxels whose stored value lies in [low, high] are tinted, previewing a threshold.
  preview?: { low: number; high: number; color: [number, number, number] } | null;
}

const PREVIEW_ALPHA = 0.35;

// Writes the overlay for an image whose pixels show the voxels in `indices` (-1 = outside) into rgba (width × height
// RGBA). Returns whether anything is visible.
export function renderLabelOverlay(
  volume: Volume,
  labelmap: Labelmap,
  indices: Int32Array,
  width: number,
  height: number,
  style: OverlayStyle,
  rgba: Uint8ClampedArray
): boolean {
  const { data, sliceSize } = labelmap;
  const { colors, preview } = style;
  const fillAlpha = Math.round(Math.min(1, Math.max(0, style.fillOpacity)) * 255);
  const count = width * height;
  rgba.fill(0);

  // Visible label per pixel (0 = none); outline pixels are labelled pixels with a differently labelled neighbour.
  const shown = new Uint8Array(count);
  let any = false;
  for (let p = 0; p < count; p++) {
    const index = indices[p];
    if (index < 0) continue;
    const label = data[index];
    if (label !== 0 && colors[label * 4 + 3] > 0) {
      shown[p] = label;
      any = true;
    }
  }

  if (preview) {
    const slices = volume.slices;
    const [pr, pg, pb] = preview.color;
    const alpha = Math.round(PREVIEW_ALPHA * 255);
    for (let p = 0; p < count; p++) {
      const index = indices[p];
      if (index < 0) continue;
      const k = (index / sliceSize) | 0;
      const value = slices[k].radiodensities[index - k * sliceSize];
      if (value >= preview.low && value <= preview.high) {
        const o = p * 4;
        rgba[o] = pr;
        rgba[o + 1] = pg;
        rgba[o + 2] = pb;
        rgba[o + 3] = alpha;
        any = true;
      }
    }
  }
  if (!any) return false;

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const p = row + x;
      const label = shown[p];
      if (label === 0) continue;
      const edge =
        style.outline &&
        ((x > 0 && shown[p - 1] !== label) ||
          (x < width - 1 && shown[p + 1] !== label) ||
          (y > 0 && shown[p - width] !== label) ||
          (y < height - 1 && shown[p + width] !== label));
      const alpha = edge ? 255 : fillAlpha;
      if (alpha === 0) continue;
      const o = p * 4;
      const c = label * 4;
      const previewAlpha = rgba[o + 3] / 255;
      const a = alpha / 255;
      // Over the preview tint, if any.
      const outA = a + previewAlpha * (1 - a);
      rgba[o] = (colors[c] * a + rgba[o] * previewAlpha * (1 - a)) / outA;
      rgba[o + 1] = (colors[c + 1] * a + rgba[o + 1] * previewAlpha * (1 - a)) / outA;
      rgba[o + 2] = (colors[c + 2] * a + rgba[o + 2] * previewAlpha * (1 - a)) / outA;
      rgba[o + 3] = outA * 255;
    }
  }
  return true;
}

export function hexToRgb(hex: string): [number, number, number] {
  const value = parseInt(hex.slice(1, 7), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}
