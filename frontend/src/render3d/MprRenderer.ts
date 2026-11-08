import { applyAffine, applyLinear } from './affine';
import { createProgram, uniformLocator } from './gl';
import type { MprSampling } from './mprSampling';
import type { SharedGpu } from './sharedGpu';
import type { GpuVolume } from './volumeTexture';
import type { ProjectionMode } from '../utils/mprSampler';
import vertexSource from './shaders/raycast.vert?raw';
import fragmentSource from './shaders/mpr.frag?raw';

// Keep in sync with the MODE_* constants in mpr.frag.
const MODE_INDEX: Record<ProjectionMode, number> = { average: 0, max: 1, min: 2 };

export interface MprWindow {
  // Stored values.
  windowLevel: number;
  windowWidth: number;
  outsideValue: number;
}

// Renders windowed MPR images (single planes and slab projections) from the shared volume texture.
export class MprRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly uniform: (name: string) => WebGLUniformLocation | null;
  private readonly vertexArray: WebGLVertexArrayObject;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.program = createProgram(gl, vertexSource, fragmentSource);
    this.uniform = uniformLocator(gl, this.program);
    this.vertexArray = gl.createVertexArray();
  }

  // Draws the image into the top-left corner of the drawing buffer; copy it out with gpu.copyTo().
  render(gpu: SharedGpu, volume: GpuVolume, sampling: MprSampling, window: MprWindow): void {
    const gl = this.gl;
    const u = this.uniform;
    const { grid } = volume;
    const toVoxel = grid.patientToVoxel;
    const vec3 = (name: string, v: { x: number; y: number; z: number }) => gl.uniform3f(u(name), v.x, v.y, v.z);

    gpu.begin(sampling.widthPixels, sampling.heightPixels);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vertexArray);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, volume.texture);
    gl.uniform1i(u('uVolume'), 0);

    gl.uniform3f(u('uDims'), grid.dims[0], grid.dims[1], grid.dims[2]);
    vec3('uVoxelBoxMin', grid.voxelBox.min);
    vec3('uVoxelBoxMax', grid.voxelBox.max);
    vec3('uOrigin', applyAffine(toVoxel, sampling.origin));
    vec3('uColumnStep', applyLinear(toVoxel, sampling.columnStep));
    vec3('uRowStep', applyLinear(toVoxel, sampling.rowStep));
    vec3('uSampleStep', applyLinear(toVoxel, sampling.sampleStep));
    gl.uniform1i(u('uSampleCount'), sampling.sampleCount);
    gl.uniform1i(u('uMode'), MODE_INDEX[sampling.mode]);
    gl.uniform1f(u('uDrawingBufferHeight'), gpu.drawingBufferHeight);

    const halfWidth = Math.max(1e-6, window.windowWidth / 2);
    gl.uniform1f(u('uOutsideValue'), window.outsideValue);
    gl.uniform1f(u('uWindowLow'), window.windowLevel - halfWidth);
    gl.uniform1f(u('uWindowHigh'), window.windowLevel + halfWidth);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}

export function createMprRenderer(gl: WebGL2RenderingContext): MprRenderer {
  return new MprRenderer(gl);
}
