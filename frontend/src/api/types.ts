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

export interface Slice {
  sliceId: number;
  volumeId: number;
  patientId: number;
  index: number;
  width: number;
  height: number;
  radiodensities: number[];
}
