import type { Volume } from '../api/types';
import type { Labelmap } from '../segmentation/labelmap';
import { createLabelTexture, updateLabelTexture, type GpuLabels } from './labelTexture';
import { uploadVolume, type GpuVolume } from './volumeTexture';

const CONTEXT_ATTRIBUTES: WebGLContextAttributes = {
  alpha: false,
  antialias: false,
  depth: false,
  powerPreference: 'high-performance',
};

// Largest image, along either axis, that a view may render.
export const MAX_IMAGE_SIZE = 2048;

type Listener = () => void;

// One WebGL2 context, on a canvas that is never shown, renders every GPU view, so the volume is uploaded only once.
// A view renders into the top-left corner of the drawing buffer and copies it into its own canvas straight away.
export class SharedGpu {
  readonly gl: WebGL2RenderingContext;
  private readonly canvas: HTMLCanvasElement;
  private source: Volume | null = null;
  private uploaded: GpuVolume | null = null;
  private uploadError: Error | null = null;
  private uploadedLabels: GpuLabels | null = null;
  private readonly resources = new Map<(gl: WebGL2RenderingContext) => unknown, unknown>();
  private version = 0;
  private readonly listeners = new Set<Listener>();

  constructor(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext) {
    this.canvas = canvas;
    this.gl = gl;
    canvas.addEventListener('webglcontextlost', (e) => e.preventDefault());
    canvas.addEventListener('webglcontextrestored', () => {
      // Every GL object died with the context.
      this.source = null;
      this.uploaded = null;
      this.uploadError = null;
      this.uploadedLabels = null;
      this.resources.clear();
      this.version++;
      this.listeners.forEach((listener) => listener());
    });
  }

  isLost(): boolean {
    return this.gl.isContextLost();
  }

  // Bumped when the context is restored; anything holding GL objects must recreate them.
  getVersion = (): number => this.version;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  // The volume's texture, uploading it (and releasing the previous volume's) unless it is already on the GPU.
  // A failed upload is remembered and rethrown rather than retried by every view on every frame.
  volume(volume: Volume): GpuVolume {
    if (volume === this.source) {
      if (this.uploadError) throw this.uploadError;
      return this.uploaded!;
    }
    if (this.uploaded) this.gl.deleteTexture(this.uploaded.texture);
    this.releaseLabels();
    this.uploaded = null;
    this.source = volume;
    this.uploadError = null;
    try {
      this.uploaded = uploadVolume(this.gl, volume);
    } catch (e) {
      this.uploadError = e instanceof Error ? e : new Error(String(e));
      throw this.uploadError;
    }
    return this.uploaded;
  }

  // The labelmap's texture, on the grid of the volume's texture: created on first use, then kept up to date with
  // the labelmap's edits. Only one labelmap is on the GPU at a time.
  labels(volume: Volume, labelmap: Labelmap): GpuLabels {
    const uploaded = this.volume(volume);
    if (this.uploadedLabels?.labelmap !== labelmap) {
      this.releaseLabels();
      this.uploadedLabels = createLabelTexture(this.gl, uploaded, labelmap);
    } else {
      updateLabelTexture(this.gl, uploaded, this.uploadedLabels);
    }
    return this.uploadedLabels;
  }

  private releaseLabels(): void {
    if (this.uploadedLabels) this.gl.deleteTexture(this.uploadedLabels.texture);
    this.uploadedLabels = null;
  }

  // A GL object shared by every view, created on first use (and again after a context restore).
  resource<T>(create: (gl: WebGL2RenderingContext) => T): T {
    if (!this.resources.has(create)) this.resources.set(create, create(this.gl));
    return this.resources.get(create) as T;
  }

  // Sets the viewport to a width × height image in the top-left corner, growing the drawing buffer if needed.
  begin(width: number, height: number): void {
    const canvas = this.canvas;
    // Resizing reallocates the drawing buffer, so it only grows.
    if (width > canvas.width) canvas.width = width;
    if (height > canvas.height) canvas.height = height;
    this.gl.viewport(0, this.gl.drawingBufferHeight - height, width, height);
  }

  // Height of the drawing buffer; gl_FragCoord.y counts up from its bottom edge.
  get drawingBufferHeight(): number {
    return this.gl.drawingBufferHeight;
  }

  // Copies the image rendered since begin() into a 2D context, scaled to the destination rectangle.
  copyTo(
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
    dx = 0,
    dy = 0,
    dWidth = width,
    dHeight = height
  ): void {
    context.drawImage(this.canvas, 0, 0, width, height, dx, dy, dWidth, dHeight);
  }
}

let instance: SharedGpu | null | undefined;

// The page's shared context, or null when the browser has no WebGL2.
export function sharedGpu(): SharedGpu | null {
  if (instance === undefined) {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const gl = canvas.getContext('webgl2', CONTEXT_ATTRIBUTES);
    instance = gl ? new SharedGpu(canvas, gl) : null;
  }
  return instance;
}
