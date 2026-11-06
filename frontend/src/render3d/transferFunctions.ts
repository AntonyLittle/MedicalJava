export type RgbColor = [number, number, number];

// alpha is the opacity of 1 mm of material; the shader corrects it for the actual step length.
export interface TransferPoint {
  hu: number;
  color: RgbColor;
  alpha: number;
}

export interface TransferPreset {
  id: string;
  name: string;
  points: TransferPoint[];
}

const SKIN: RgbColor = [0.93, 0.75, 0.62];
const MUSCLE: RgbColor = [0.75, 0.3, 0.22];
const BONE: RgbColor = [0.95, 0.9, 0.8];
const VESSEL: RgbColor = [0.85, 0.12, 0.1];
const LUNG: RgbColor = [0.95, 0.65, 0.55];

// Points are in ascending HU; values outside the first/last point take the end values.
export const TRANSFER_PRESETS: TransferPreset[] = [
  {
    id: 'bone',
    name: 'Bone',
    points: [
      { hu: 150, color: [0.7, 0.35, 0.25], alpha: 0 },
      { hu: 300, color: [0.9, 0.75, 0.55], alpha: 0.25 },
      { hu: 700, color: BONE, alpha: 0.7 },
      { hu: 1500, color: [1, 1, 1], alpha: 0.9 },
    ],
  },
  {
    id: 'soft-tissue',
    name: 'Soft tissue',
    points: [
      { hu: -200, color: MUSCLE, alpha: 0 },
      { hu: -50, color: [0.85, 0.5, 0.35], alpha: 0.02 },
      { hu: 60, color: MUSCLE, alpha: 0.08 },
      { hu: 150, color: [0.9, 0.6, 0.4], alpha: 0.12 },
      { hu: 300, color: [0.95, 0.85, 0.7], alpha: 0.5 },
      { hu: 700, color: BONE, alpha: 0.8 },
    ],
  },
  {
    id: 'skin',
    name: 'Skin',
    points: [
      { hu: -600, color: SKIN, alpha: 0 },
      { hu: -350, color: SKIN, alpha: 0.6 },
      { hu: 300, color: SKIN, alpha: 0.8 },
      { hu: 700, color: BONE, alpha: 0.9 },
    ],
  },
  {
    id: 'lung',
    name: 'Lung',
    points: [
      { hu: -950, color: LUNG, alpha: 0 },
      { hu: -850, color: LUNG, alpha: 0.02 },
      { hu: -600, color: [1, 0.8, 0.7], alpha: 0.1 },
      { hu: -450, color: [1, 0.8, 0.7], alpha: 0 },
      { hu: 200, color: BONE, alpha: 0 },
      { hu: 500, color: BONE, alpha: 0.4 },
    ],
  },
  {
    id: 'vessels',
    name: 'Vessels',
    points: [
      { hu: 120, color: VESSEL, alpha: 0 },
      { hu: 200, color: VESSEL, alpha: 0.4 },
      { hu: 350, color: [0.95, 0.6, 0.45], alpha: 0.7 },
      { hu: 700, color: BONE, alpha: 0.9 },
    ],
  },
];

// The store keeps raw CT pixel values: the usual rescale intercept of -1024 is not applied, so HU = value - 1024.
export const CT_VALUE_OFFSET = 1024;

// The LUT is indexed by stored value and covers -1024..3071 HU at 2 per entry; values outside take the end entries.
export const LUT_MIN_VALUE = 0;
export const LUT_STEP = 2;
export const LUT_SIZE = 2048;

export interface TransferLut {
  // RGBA8 texture data.
  rgba: Uint8Array;
  // Opacity per entry exactly as the GPU sees it (rgba alpha / 255).
  alpha: Float32Array;
  // visibleCount[i] = number of entries before i with non-zero opacity.
  visibleCount: Int32Array;
}

function interpolate(points: TransferPoint[], hu: number): { color: RgbColor; alpha: number } {
  if (hu <= points[0].hu) return points[0];
  const last = points[points.length - 1];
  if (hu >= last.hu) return last;
  let i = 1;
  while (points[i].hu < hu) i++;
  const a = points[i - 1];
  const b = points[i];
  const t = (hu - a.hu) / (b.hu - a.hu);
  return {
    color: [0, 1, 2].map((c) => a.color[c] + (b.color[c] - a.color[c]) * t) as RgbColor,
    alpha: a.alpha + (b.alpha - a.alpha) * t,
  };
}

// Preset points are in HU; shiftHu moves the whole preset along the HU axis.
export function buildTransferLut(preset: TransferPreset, shiftHu: number): TransferLut {
  const rgba = new Uint8Array(LUT_SIZE * 4);
  const alpha = new Float32Array(LUT_SIZE);
  const visibleCount = new Int32Array(LUT_SIZE + 1);
  for (let i = 0; i < LUT_SIZE; i++) {
    const { color, alpha: a } = interpolate(preset.points, LUT_MIN_VALUE + i * LUT_STEP - CT_VALUE_OFFSET - shiftHu);
    rgba[i * 4] = Math.round(color[0] * 255);
    rgba[i * 4 + 1] = Math.round(color[1] * 255);
    rgba[i * 4 + 2] = Math.round(color[2] * 255);
    rgba[i * 4 + 3] = Math.round(Math.min(1, Math.max(0, a)) * 255);
    alpha[i] = rgba[i * 4 + 3] / 255;
    visibleCount[i + 1] = visibleCount[i] + (rgba[i * 4 + 3] > 0 ? 1 : 0);
  }
  return { rgba, alpha, visibleCount };
}

// Fractional LUT position of a stored value, clamped to the table.
export function lutPosition(value: number): number {
  return Math.min(LUT_SIZE - 1, Math.max(0, (value - LUT_MIN_VALUE) / LUT_STEP));
}

// Opacity the GPU's linear LUT lookup gives for a stored value.
export function lutAlpha(lut: TransferLut, value: number): number {
  const position = lutPosition(value);
  const i = Math.floor(position);
  const j = Math.min(LUT_SIZE - 1, i + 1);
  const t = position - i;
  return lut.alpha[i] + (lut.alpha[j] - lut.alpha[i]) * t;
}

// Whether any stored value in [min, max] can be visible (including blending with the neighbouring entries).
export function lutRangeVisible(lut: TransferLut, min: number, max: number): boolean {
  const lo = Math.max(0, Math.floor(lutPosition(min)) - 1);
  const hi = Math.min(LUT_SIZE - 1, Math.ceil(lutPosition(max)) + 1);
  return lut.visibleCount[hi + 1] - lut.visibleCount[lo] > 0;
}
