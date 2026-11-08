import type { Volume } from '../api/types';
import type { CameraFrame } from './camera';
import { clippedBox, type ClipBox, type CutPlane } from './clipping';
import { createProgram, uniformLocator } from './gl';
import { affineToMat4 } from './affine';
import { LUT_SIZE, lutRangeVisible, type RgbColor, type TransferLut } from './transferFunctions';
import { BRICK_SIZE } from './volumeGrid';
import { uploadVolume, type GpuVolume } from './volumeTexture';
import vertexSource from './shaders/raycast.vert?raw';
import fragmentSource from './shaders/raycast.frag?raw';

export type RenderMode = 'dvr' | 'mip' | 'minip' | 'average' | 'iso';

// Keep in sync with the MODE_* constants in raycast.frag.
const MODE_INDEX: Record<RenderMode, number> = { dvr: 0, mip: 1, minip: 2, average: 3, iso: 4 };

export interface RenderParams {
  mode: RenderMode;
  camera: CameraFrame;
  lut: TransferLut;
  // Multiplies the LUT opacity.
  opacityScale: number;
  // 0 = flat colours, 1 = fully lit.
  shading: number;
  windowLevel: number;
  windowWidth: number;
  // Stored value of the isosurface.
  isoValue: number;
  isoColor: RgbColor;
  clipBox: ClipBox;
  cutPlane: CutPlane | null;
  // Ray step as a fraction of the smallest voxel spacing.
  stepFactor: number;
  skipEmpty: boolean;
}

interface OccupancyInputs {
  mode: RenderMode;
  lut: TransferLut;
  windowLow: number;
  windowHigh: number;
  isoValue: number;
}

function windowRange(params: Pick<RenderParams, 'windowLevel' | 'windowWidth'>): [number, number] {
  const half = Math.max(0.5, params.windowWidth / 2);
  return [params.windowLevel - half, params.windowLevel + half];
}

// Bricks that can change the image in this mode; the rest are skipped by the ray caster.
function occupancy(volume: GpuVolume, inputs: OccupancyInputs): Uint8Array {
  const { min, max } = volume.bricks;
  const result = new Uint8Array(min.length);
  for (let i = 0; i < result.length; i++) {
    let visible: boolean;
    switch (inputs.mode) {
      case 'dvr':
        visible = lutRangeVisible(inputs.lut, min[i], max[i]);
        break;
      case 'mip':
        visible = max[i] >= inputs.windowLow;
        break;
      case 'minip':
        visible = min[i] <= inputs.windowHigh;
        break;
      case 'iso':
        visible = max[i] >= inputs.isoValue;
        break;
      default:
        visible = true;
    }
    result[i] = visible ? 1 : 0;
  }
  return result;
}

function sameOccupancyInputs(a: OccupancyInputs | null, b: OccupancyInputs): boolean {
  if (!a || a.mode !== b.mode) return false;
  switch (b.mode) {
    case 'dvr':
      return a.lut === b.lut;
    case 'mip':
      return a.windowLow === b.windowLow;
    case 'minip':
      return a.windowHigh === b.windowHigh;
    case 'iso':
      return a.isoValue === b.isoValue;
    default:
      return true;
  }
}

// Owns the GL resources for ray casting one volume into the context's default framebuffer.
export class VolumeRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly uniform: (name: string) => WebGLUniformLocation | null;
  private readonly vertexArray: WebGLVertexArrayObject;
  private readonly lutTexture: WebGLTexture;
  private readonly occupancyTexture: WebGLTexture;
  private volume: GpuVolume | null = null;
  private source: Volume | null = null;
  private uploadError: Error | null = null;
  private uploadedLut: TransferLut | null = null;
  private occupancyInputs: OccupancyInputs | null = null;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.program = createProgram(gl, vertexSource, fragmentSource);
    this.uniform = uniformLocator(gl, this.program);
    this.vertexArray = gl.createVertexArray();

    this.lutTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.lutTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, LUT_SIZE, 1);

    // Integer textures can't be filtered.
    this.occupancyTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, this.occupancyTexture);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  }

  get grid() {
    return this.volume?.grid ?? null;
  }

  // Uploads the volume unless it is the one already on the GPU. A failed upload is remembered and rethrown rather than
  // retried on every frame.
  setVolume(volume: Volume | null): void {
    if (volume === this.source) {
      if (this.uploadError) throw this.uploadError;
      return;
    }
    if (this.volume) this.gl.deleteTexture(this.volume.texture);
    this.volume = null;
    this.source = volume;
    this.uploadError = null;
    this.occupancyInputs = null;
    if (!volume) return;

    try {
      this.volume = uploadVolume(this.gl, volume);
    } catch (e) {
      this.uploadError = e instanceof Error ? e : new Error(String(e));
      throw this.uploadError;
    }
    const [bx, by, bz] = this.volume.bricks.dims;
    this.gl.bindTexture(this.gl.TEXTURE_3D, this.occupancyTexture);
    this.gl.texImage3D(this.gl.TEXTURE_3D, 0, this.gl.R8UI, bx, by, bz, 0, this.gl.RED_INTEGER, this.gl.UNSIGNED_BYTE, null);
  }

  private updateLut(lut: TransferLut): void {
    if (lut === this.uploadedLut) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.lutTexture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, LUT_SIZE, 1, gl.RGBA, gl.UNSIGNED_BYTE, lut.rgba);
    this.uploadedLut = lut;
  }

  private updateOccupancy(volume: GpuVolume, inputs: OccupancyInputs): void {
    if (sameOccupancyInputs(this.occupancyInputs, inputs)) return;
    const gl = this.gl;
    const [bx, by, bz] = volume.bricks.dims;
    gl.bindTexture(gl.TEXTURE_3D, this.occupancyTexture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage3D(gl.TEXTURE_3D, 0, 0, 0, 0, bx, by, bz, gl.RED_INTEGER, gl.UNSIGNED_BYTE, occupancy(volume, inputs));
    this.occupancyInputs = inputs;
  }

  render(params: RenderParams): void {
    const gl = this.gl;
    const u = this.uniform;
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const volume = this.volume;
    if (!volume) return;

    const [windowLow, windowHigh] = windowRange(params);
    const skipEmpty = params.skipEmpty && params.mode !== 'average';
    if (params.mode === 'dvr') this.updateLut(params.lut);
    if (skipEmpty) {
      this.updateOccupancy(volume, {
        mode: params.mode,
        lut: params.lut,
        windowLow,
        windowHigh,
        isoValue: params.isoValue,
      });
    }

    const { grid } = volume;
    const { spacing, dims, voxelBox } = grid;
    const clip = clippedBox(grid.bounds, params.clipBox);
    const stepMm = Math.min(spacing.x, spacing.y, spacing.z) * params.stepFactor;
    const diagonal = Math.hypot(clip.max.x - clip.min.x, clip.max.y - clip.min.y, clip.max.z - clip.min.z);
    const camera = params.camera;

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vertexArray);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, volume.texture);
    gl.uniform1i(u('uVolume'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTexture);
    gl.uniform1i(u('uTransfer'), 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_3D, this.occupancyTexture);
    gl.uniform1i(u('uOccupancy'), 2);

    gl.uniform1i(u('uMode'), MODE_INDEX[params.mode]);
    gl.uniform3f(u('uCamTarget'), camera.target.x, camera.target.y, camera.target.z);
    gl.uniform3f(u('uCamRight'), camera.right.x, camera.right.y, camera.right.z);
    gl.uniform3f(u('uCamDown'), camera.down.x, camera.down.y, camera.down.z);
    gl.uniform3f(u('uCamForward'), camera.forward.x, camera.forward.y, camera.forward.z);
    gl.uniform2f(u('uHalfSizeMm'), camera.halfWidthMm, camera.halfHeightMm);
    gl.uniform1f(u('uPerspectiveDistanceMm'), camera.perspectiveDistanceMm);

    gl.uniformMatrix4fv(u('uPatientToVoxel'), false, affineToMat4(grid.patientToVoxel));
    gl.uniform3f(u('uDims'), dims[0], dims[1], dims[2]);
    gl.uniform3f(u('uVoxelBoxMin'), voxelBox.min.x, voxelBox.min.y, voxelBox.min.z);
    gl.uniform3f(u('uVoxelBoxMax'), voxelBox.max.x, voxelBox.max.y, voxelBox.max.z);
    gl.uniform3f(u('uClipMin'), clip.min.x, clip.min.y, clip.min.z);
    gl.uniform3f(u('uClipMax'), clip.max.x, clip.max.y, clip.max.z);
    const cut = params.cutPlane;
    gl.uniform1i(u('uCutEnabled'), cut ? 1 : 0);
    if (cut) gl.uniform4f(u('uCutPlane'), cut.normal.x, cut.normal.y, cut.normal.z, cut.offsetMm);

    gl.uniform1f(u('uStepMm'), stepMm);
    gl.uniform1i(u('uMaxSteps'), Math.ceil(diagonal / stepMm) + 2);

    gl.uniform1i(u('uSkipEmpty'), skipEmpty ? 1 : 0);
    gl.uniform1f(u('uBrickSize'), BRICK_SIZE);
    const [bx, by, bz] = volume.bricks.dims;
    gl.uniform3i(u('uBrickDims'), bx, by, bz);

    // Texture x of entry i is (i + 0.5) / LUT_SIZE, for value lut.minValue + i * lut.step.
    const lut = params.lut;
    gl.uniform1f(u('uLutScale'), 1 / (lut.step * LUT_SIZE));
    gl.uniform1f(u('uLutOffset'), (0.5 - lut.minValue / lut.step) / LUT_SIZE);
    gl.uniform1f(u('uOpacityScale'), params.opacityScale);
    gl.uniform1f(u('uShading'), params.shading);

    gl.uniform1f(u('uWindowLow'), windowLow);
    gl.uniform1f(u('uWindowHigh'), windowHigh);
    gl.uniform1f(u('uIsoValue'), params.isoValue);
    gl.uniform3f(u('uIsoColor'), params.isoColor[0], params.isoColor[1], params.isoColor[2]);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  dispose(): void {
    const gl = this.gl;
    if (this.volume) gl.deleteTexture(this.volume.texture);
    this.volume = null;
    this.source = null;
    gl.deleteTexture(this.lutTexture);
    gl.deleteTexture(this.occupancyTexture);
    gl.deleteVertexArray(this.vertexArray);
    gl.deleteProgram(this.program);
  }
}
