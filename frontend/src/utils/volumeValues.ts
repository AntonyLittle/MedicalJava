import type { Volume } from '../api/types';

// Volumes store int16 values; real values (in valueUnits) are stored * slope + intercept.
// Everything that touches pixels works on stored values; only the UI shows real ones.

export interface WindowSettings {
  level: number;
  width: number;
}

// Default soft-tissue window for Hounsfield units.
const HU_WINDOW: WindowSettings = { level: 40, width: 400 };
// Other data defaults to this percentile range of its values.
const LOW_PERCENTILE = 0.01;
const HIGH_PERCENTILE = 0.99;
const PERCENTILE_SAMPLES = 200_000;

export function valueSlope(volume: Volume): number {
  return volume.valueSlope && volume.valueSlope > 0 ? volume.valueSlope : 1;
}

export function valueIntercept(volume: Volume): number {
  return volume.valueIntercept ?? 0;
}

export function valueUnits(volume: Volume): string {
  return volume.valueUnits ?? '';
}

export function isHounsfield(volume: Volume): boolean {
  return valueUnits(volume) === 'HU';
}

export function toStoredValue(volume: Volume, real: number): number {
  return (real - valueIntercept(volume)) / valueSlope(volume);
}

export function toRealValue(volume: Volume, stored: number): number {
  return stored * valueSlope(volume) + valueIntercept(volume);
}

// A window in real units as the equivalent window over stored values.
export function toStoredWindow(volume: Volume, window: WindowSettings): WindowSettings {
  return { level: toStoredValue(volume, window.level), width: window.width / valueSlope(volume) };
}

interface ValueStats {
  // Stored values.
  min: number;
  max: number;
  low: number;
  high: number;
}

const statsCache = new WeakMap<Volume, ValueStats>();

// Exact range plus approximate percentiles from an evenly spread sample of voxels.
function valueStats(volume: Volume): ValueStats {
  let stats = statsCache.get(volume);
  if (stats) return stats;

  const total = volume.slices.reduce((sum, s) => sum + s.radiodensities.length, 0);
  const stride = Math.max(1, Math.floor(total / PERCENTILE_SAMPLES));
  const sample: number[] = [];
  let min = Infinity;
  let max = -Infinity;
  let offset = 0;
  for (const slice of volume.slices) {
    const data = slice.radiodensities;
    for (let i = 0; i < data.length; i++) {
      const value = data[i];
      if (value < min) min = value;
      if (value > max) max = value;
    }
    for (let i = (stride - (offset % stride)) % stride; i < data.length; i += stride) sample.push(data[i]);
    offset += data.length;
  }
  if (sample.length === 0) {
    stats = { min: 0, max: 0, low: 0, high: 0 };
  } else {
    sample.sort((a, b) => a - b);
    const at = (fraction: number) => sample[Math.min(sample.length - 1, Math.floor(fraction * sample.length))];
    stats = { min, max, low: at(LOW_PERCENTILE), high: at(HIGH_PERCENTILE) };
  }
  statsCache.set(volume, stats);
  return stats;
}

// Stored value range; uses the server's range when it has one.
export function storedRange(volume: Volume): [number, number] {
  if (volume.minValue !== undefined && volume.maxValue !== undefined && volume.maxValue > volume.minValue) {
    const a = toStoredValue(volume, volume.minValue);
    const b = toStoredValue(volume, volume.maxValue);
    return [Math.min(a, b), Math.max(a, b)];
  }
  const { min, max } = valueStats(volume);
  return [min, max];
}

export function realRange(volume: Volume): [number, number] {
  const [min, max] = storedRange(volume);
  return [toRealValue(volume, min), toRealValue(volume, max)];
}

// Fills image areas outside the volume: the lowest value, so they read as background in any window.
export function outsideValue(volume: Volume): number {
  return storedRange(volume)[0];
}

// Narrowest window: one stored step.
export function minWindowWidth(volume: Volume): number {
  return valueSlope(volume);
}

export function defaultWindow(volume: Volume): WindowSettings {
  if (isHounsfield(volume)) return HU_WINDOW;
  const { low, high } = valueStats(volume);
  const lo = toRealValue(volume, low);
  const hi = toRealValue(volume, Math.max(high, low + 1));
  // Whole numbers for integer-valued data; small-range data (e.g. fractional units) keeps its precision.
  const integral = valueSlope(volume) === 1 && Number.isInteger(valueIntercept(volume));
  const level = (lo + hi) / 2;
  return integral
    ? { level: Math.round(level), width: Math.max(1, Math.round(hi - lo)) }
    : { level, width: Math.max(minWindowWidth(volume), hi - lo) };
}

// Short label for values, e.g. "40 HU".
export function formatValue(volume: Volume, real: number): string {
  const units = valueUnits(volume);
  const rounded = Math.abs(real) >= 100 || Number.isInteger(real) ? Math.round(real) : Number(real.toPrecision(3));
  return units ? `${rounded} ${units}` : `${rounded}`;
}
