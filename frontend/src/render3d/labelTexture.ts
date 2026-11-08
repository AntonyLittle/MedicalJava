import type { Labelmap, VoxelBox } from '../segmentation/labelmap';
import type { GpuVolume } from './volumeTexture';

// A segmentation's labels on the GPU, on the same grid as the volume texture (sampled nearest-neighbour, as labels
// can't be interpolated). version is the labelmap version the texture shows.
export interface GpuLabels {
  texture: WebGLTexture;
  labelmap: Labelmap;
  version: number;
}

function uploadBox(gl: WebGL2RenderingContext, volume: GpuVolume, labelmap: Labelmap, box: VoxelBox): void {
  const [nx, ny, nz] = volume.grid.dims;
  const { strideX, strideY, nearestSlice } = volume.source;
  const i0 = Math.max(0, Math.ceil(box.min[0] / strideX));
  const i1 = Math.min(nx - 1, Math.floor(box.max[0] / strideX));
  const j0 = Math.max(0, Math.ceil(box.min[1] / strideY));
  const j1 = Math.min(ny - 1, Math.floor(box.max[1] / strideY));
  if (i0 > i1 || j0 > j1) return;
  const width = i1 - i0 + 1;
  const height = j1 - j0 + 1;
  const buffer = new Uint8Array(width * height);
  const { data, width: sourceWidth, sliceSize } = labelmap;

  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  for (let k = 0; k < nz; k++) {
    const slice = nearestSlice[k];
    if (slice < box.min[2] || slice > box.max[2]) continue;
    const sliceBase = slice * sliceSize;
    for (let j = j0; j <= j1; j++) {
      const sourceRow = sliceBase + j * strideY * sourceWidth;
      const row = (j - j0) * width;
      if (strideX === 1) {
        buffer.set(data.subarray(sourceRow + i0, sourceRow + i0 + width), row);
      } else {
        for (let i = i0; i <= i1; i++) buffer[row + i - i0] = data[sourceRow + i * strideX];
      }
    }
    gl.texSubImage3D(gl.TEXTURE_3D, 0, i0, j0, k, width, height, 1, gl.RED_INTEGER, gl.UNSIGNED_BYTE, buffer);
  }
}

export function createLabelTexture(gl: WebGL2RenderingContext, volume: GpuVolume, labelmap: Labelmap): GpuLabels {
  const [nx, ny, nz] = volume.grid.dims;
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_3D, texture);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
  gl.texStorage3D(gl.TEXTURE_3D, 1, gl.R8UI, nx, ny, nz);
  if (gl.getError() === gl.OUT_OF_MEMORY) {
    gl.deleteTexture(texture);
    throw new Error('Not enough GPU memory for the segmentation');
  }
  uploadBox(gl, volume, labelmap, labelmap.fullBox);
  return { texture, labelmap, version: labelmap.version };
}

// Uploads what changed in the labelmap since the texture was last updated.
export function updateLabelTexture(gl: WebGL2RenderingContext, volume: GpuVolume, labels: GpuLabels): void {
  const changed = labels.labelmap.changedSince(labels.version);
  if (!changed) return;
  gl.bindTexture(gl.TEXTURE_3D, labels.texture);
  uploadBox(gl, volume, labels.labelmap, changed === 'all' ? labels.labelmap.fullBox : changed);
  labels.version = labels.labelmap.version;
}
