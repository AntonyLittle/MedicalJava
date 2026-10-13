import type { PlaneOrientation } from './mprSampler';

// Keyed by the view's identity, not its current normal, so the colour is stable while the frame is rotated.
export const MPR_COLOR_BY_ORIENTATION: Record<PlaneOrientation, string> = {
  axial: '#e53935',
  coronal: '#43a047',
  sagittal: '#fdd835',
};
