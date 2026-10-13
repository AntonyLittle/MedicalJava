import type { Volume } from './types';

// Layout (little-endian), as written by VolumesController.getBinary: uint32 metadata length N, N bytes of UTF-8 JSON
// (slices carry empty radiodensities), zero padding to a 4-byte boundary, then every slice's int16 pixels in order.
export function parseBinaryVolume(buffer: ArrayBuffer): Volume {
  const metadataLength = new DataView(buffer).getUint32(0, true);
  const metadataBytes = new Uint8Array(buffer, 4, metadataLength);
  const volume = JSON.parse(new TextDecoder().decode(metadataBytes)) as Volume;

  let offset = (4 + metadataLength + 3) & ~3;
  for (const slice of volume.slices) {
    const pixelCount = slice.widthPixels * slice.heightPixels;
    // A view onto the response buffer: no per-slice copy or conversion.
    slice.radiodensities = new Int16Array(buffer, offset, pixelCount);
    offset += pixelCount * Int16Array.BYTES_PER_ELEMENT;
  }
  return volume;
}
