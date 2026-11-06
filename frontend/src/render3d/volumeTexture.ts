import type { Volume } from '../api/types';
import {
  accumulateBrickStats,
  createBrickStats,
  dilateBrickStats,
  planVolumeGrid,
  type BrickStats,
  type VolumeGrid,
} from './volumeGrid';

export interface GpuVolume {
  grid: VolumeGrid;
  bricks: BrickStats;
  texture: WebGLTexture;
}

// Uploads the volume as a half-float 3D texture (linearly filterable in core WebGL2), one slice at a time so the only
// temporary is a single float slice. Brick value ranges for empty-space skipping are gathered on the way.
export function uploadVolume(gl: WebGL2RenderingContext, volume: Volume): GpuVolume {
  const maxSize = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) as number;
  const { grid, fillSlice } = planVolumeGrid(volume, maxSize);
  const [nx, ny, nz] = grid.dims;
  const bricks = createBrickStats(grid);

  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_3D, texture);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
  gl.texStorage3D(gl.TEXTURE_3D, 1, gl.R16F, nx, ny, nz);
  if (gl.getError() === gl.OUT_OF_MEMORY) {
    gl.deleteTexture(texture);
    throw new Error(`Not enough GPU memory for a ${nx}×${ny}×${nz} volume`);
  }

  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  const slice = new Float32Array(nx * ny);
  for (let k = 0; k < nz; k++) {
    fillSlice(k, slice);
    accumulateBrickStats(bricks, grid, k, slice);
    gl.texSubImage3D(gl.TEXTURE_3D, 0, 0, 0, k, nx, ny, 1, gl.RED, gl.FLOAT, slice);
  }
  dilateBrickStats(bricks);

  return { grid, bricks, texture };
}
