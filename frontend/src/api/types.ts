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
  sliceId: number;
  volumeId: number;
  patientId: number;
  index: number;
  widthMm: number;
  heightMm: number;
  depthPositionMm: number;
}

export interface RadioDensities {
  widthPixels: number;
  heightPixels: number;
  radiodensities: number[];
}
