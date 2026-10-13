export interface Patient {
  patientId: number;
  name: string;
  volumes: Volume[];
}

export interface Volume {
  volumeId: number;
  patientId: number;
  name: string;
  modality: string;
  slices: Slice[];
}

export interface Slice extends RadioDensities{
  radiodensities: Int16Array;
  sliceId: number;
  volumeId: number;
  patientId: number;
  index: number;
  widthMm: number;
  heightMm: number;
  depthPositionMm: number;
  originXMm: number;
  originYMm: number;
  pixelSpacingXMm: number;
  pixelSpacingYMm: number;
}

// Maps patient-space plane coordinates (mm from the volume centre along the image's right/down axes) to pixels.
export interface ImageGeometry {
  uMinMm: number;
  vMinMm: number;
  spacingMm: number;
}

export interface RadioDensities {
  geometry?: ImageGeometry;
  widthPixels: number;
  heightPixels: number;
  radiodensities: ArrayLike<number>;
}
