import { describe, expect, it } from 'vitest';
import { makeVolume } from './testVolumes';
import { defaultWindow, minWindowWidth, outsideValue, realRange, toStoredWindow } from './volumeValues';

describe('volumeValues', () => {
  it('uses a soft-tissue window for Hounsfield units', () => {
    const volume = makeVolume({ width: 4, height: 4, depths: [0, 1], value: (i) => i * 100 - 1024 });
    expect(defaultWindow(volume)).toEqual({ level: 40, width: 400 });
    expect(outsideValue(volume)).toBe(-1024);
  });

  it('keeps sub-unit windows for small-range data', () => {
    // Real values 0..0.003 (e.g. diffusion in mm²/s), requantised over the int16 range.
    const slope = 0.003 / 65535;
    const intercept = 0.0015 - 0.5 * slope;
    const volume = makeVolume({ width: 50, height: 50, depths: [0, 1], value: (i, j) => -32768 + (i * 50 + j) * 26 });
    Object.assign(volume, { valueSlope: slope, valueIntercept: intercept, valueUnits: '', minValue: 0, maxValue: 0.003 });

    const window = defaultWindow(volume);
    expect(window.width).toBeGreaterThan(minWindowWidth(volume));
    expect(window.width).toBeLessThan(0.004);
    expect(window.level).toBeGreaterThan(0);
    expect(window.level).toBeLessThan(0.003);
    expect(realRange(volume)[1]).toBeCloseTo(0.003, 9);

    // The same window over stored values spans a sensible part of the int16 range.
    const stored = toStoredWindow(volume, window);
    expect(stored.width).toBeGreaterThan(1000);
    expect(stored.width).toBeLessThan(70000);
  });
});
