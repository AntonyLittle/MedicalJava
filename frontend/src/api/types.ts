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
  spacingUMm: number;
  spacingVMm: number;
}

export interface RadioDensities {
  geometry?: ImageGeometry;
  widthPixels: number;
  heightPixels: number;
  radiodensities: ArrayLike<number>;
}

// Summary returned by POST /api/import and included in GET /api/import/status.
export interface ScanResult {
  startedAt: string;
  finishedAt: string;
  imported: number;
  updated: number;
  unchanged: number;
  excluded: number;
  failed: number;
}

export interface ImportFailure {
  sourcePath: string;
  fingerprint: string;
  error: string;
  failedAt: string;
}

export interface ImportStatus {
  running: boolean;
  lastScan: ScanResult | null;
  failures: ImportFailure[];
}
