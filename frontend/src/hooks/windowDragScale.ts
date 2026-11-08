import { createContext } from 'react';

// Multiplies window level/width drag sensitivity (tuned for CT's ~4000 values) so that a drag covers a similar
// fraction of the loaded volume's stored value range.
export const WindowDragScaleContext = createContext(1);

// Stored value span that the base drag sensitivity was tuned for.
const REFERENCE_SPAN = 4000;

export function windowDragScale(storedMin: number, storedMax: number): number {
  return Math.max(1e-6, (storedMax - storedMin) / REFERENCE_SPAN);
}
