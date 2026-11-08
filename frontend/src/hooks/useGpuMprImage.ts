import { useEffect, useMemo, useState } from 'react';
import type { Volume } from '../api/types';
import type { PaintedImage } from '../components/CanvasRenderer';
import { createMprRenderer } from '../render3d/MprRenderer';
import {
  planMprSampling,
  PREVIEW_SLAB_STEP_FACTOR,
  SLAB_STEP_FACTOR,
  type SlabSettings,
} from '../render3d/mprSampling';
import { MAX_IMAGE_SIZE } from '../render3d/sharedGpu';
import type { ViewablePlane } from '../utils/canvasMath';
import { planeFromParams } from '../utils/mprSampler';
import { outsideValue } from '../utils/volumeValues';
import { usePlaneParams } from './usePlaneParams';
import { useSharedGpu } from './useSharedGpu';

// Slabs are sampled more coarsely while they move, and finely once they have been still this long.
const REFINE_DELAY_MS = 150;

export interface GpuMprSettings {
  // A projection through a slab centred on the plane; a single plane when absent.
  slab?: SlabSettings | null;
  spacingScale?: number;
  // Extra spacing multiplier while a slab is moving.
  previewSpacingScale?: number;
}

export interface GpuMprImage {
  image: PaintedImage | undefined;
  // False without WebGL2 or after the volume failed to upload; the caller should then sample on the CPU.
  active: boolean;
}

// Renders the plane (or a slab around it) on the GPU, windowed, in the context shared with the volume renderer.
// windowLevel/windowWidth are stored values.
export function useGpuMprImage(
  volume: Volume,
  viewablePlane: ViewablePlane,
  windowLevel: number,
  windowWidth: number,
  settings: GpuMprSettings = {}
): GpuMprImage {
  const { gpu, version } = useSharedGpu();
  const [failedVolume, setFailedVolume] = useState<Volume | null>(null);
  const active = gpu !== null && failedVolume !== volume && volume.slices.length > 0;

  const params = usePlaneParams(volume, viewablePlane);
  const thicknessMm = settings.slab?.thicknessMm;
  const mode = settings.slab?.mode ?? 'average';
  const spacingScale = settings.spacingScale ?? 1;
  const previewSpacingScale = settings.previewSpacingScale ?? 1;
  const progressive = thicknessMm !== undefined;

  // A new object whenever the sampled region changes; the fine image waits until it has stopped changing.
  const region = useMemo(
    () => ({ volume, params, thicknessMm, mode, spacingScale }),
    [volume, params, thicknessMm, mode, spacingScale]
  );
  const [settledRegion, setSettledRegion] = useState<object | null>(null);
  useEffect(() => {
    if (!progressive || !active) return;
    const timer = setTimeout(() => setSettledRegion(region), REFINE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [progressive, active, region]);
  const preview = progressive && settledRegion !== region;

  const sampling = useMemo(() => {
    if (!active) return null;
    const plane = planeFromParams(volume, params);
    const slab = thicknessMm === undefined ? null : { thicknessMm, mode };
    const stepFactor = preview ? PREVIEW_SLAB_STEP_FACTOR : SLAB_STEP_FACTOR;
    let scale = spacingScale * (preview ? previewSpacingScale : 1);
    let planned = planMprSampling(volume, plane, { slab, spacingScale: scale, stepFactor });
    const largest = Math.max(planned.widthPixels, planned.heightPixels);
    if (largest > MAX_IMAGE_SIZE) {
      scale *= largest / MAX_IMAGE_SIZE;
      planned = planMprSampling(volume, plane, { slab, spacingScale: scale, stepFactor });
    }
    return planned;
  }, [active, volume, params, thicknessMm, mode, spacingScale, previewSpacingScale, preview]);

  const image = useMemo<PaintedImage | undefined>(() => {
    if (!gpu || !sampling) return undefined;
    const window = { windowLevel, windowWidth, outsideValue: outsideValue(volume) };
    return {
      widthPixels: sampling.widthPixels,
      heightPixels: sampling.heightPixels,
      geometry: sampling.geometry,
      // Runs while the canvas redraws. After a context restore the view re-renders with a new image anyway.
      paint: (context) => {
        if (gpu.isLost() || gpu.getVersion() !== version) return;
        try {
          const uploaded = gpu.volume(volume);
          gpu.resource(createMprRenderer).render(gpu, uploaded, sampling, window);
          gpu.copyTo(context, sampling.widthPixels, sampling.heightPixels);
        } catch (e) {
          console.error('GPU MPR failed; falling back to CPU sampling', e);
          setFailedVolume(volume);
        }
      },
    };
  }, [gpu, version, sampling, volume, windowLevel, windowWidth]);

  return { image, active };
}
