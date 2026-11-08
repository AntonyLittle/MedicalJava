export interface Patient {
  patientId: number;
  name: string;
  volumes: Volume[];
}

// Slices are parallel images ordered along rowDirection × columnDirection (patient LPS unit vectors).
// Pixel values map to real values (in valueUnits, e.g. 'HU') as value * valueSlope + valueIntercept;
// minValue/maxValue are the real range. formatVersion 0 marks a volume stored before orientation and value
// mapping were decoded (it is treated as an axial stack of raw values).
export interface Volume {
  volumeId: number;
  patientId: number;
  name: string;
  modality: string;
  slices: Slice[];
  rowDirection?: [number, number, number];
  columnDirection?: [number, number, number];
  valueSlope?: number;
  valueIntercept?: number;
  valueUnits?: string;
  minValue?: number;
  maxValue?: number;
  formatVersion?: number;
}

// position*Mm is the patient-space centre of the first pixel. depthPositionMm (distance along the slice normal)
// and originX/YMm are kept for axial-only clients; use utils/volumeGeometry instead.
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
  positionXMm?: number;
  positionYMm?: number;
  positionZMm?: number;
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

// One structure of a segmentation: the voxels labelled `label` (1–255). algorithmType is the DICOM SEG
// SegmentAlgorithmType.
export type SegmentAlgorithmType = 'MANUAL' | 'SEMIAUTOMATIC' | 'AUTOMATIC';

export interface Segment {
  label: number;
  name: string;
  // "#rrggbb"
  color: string;
  algorithmType: SegmentAlgorithmType;
}

// A labelmap on a volume's voxel grid. stale: the volume was re-imported with another geometry since the labels were
// written. revision increases with every change; send it back as If-Match.
export interface Segmentation {
  segmentationId: number;
  volumeId: number;
  patientId: number;
  name: string;
  // 'manual', 'auto:<model>' or 'dicom-seg'
  source: string;
  revision: number;
  createdAt: string;
  modifiedAt: string;
  voxelCount: number;
  stale: boolean;
  segments: Segment[];
}

export interface SegmentationModel {
  id: string;
  name: string;
  description: string;
  available: boolean;
  unavailableReason: string | null;
}

export interface SegmentationModelList {
  workerUrl: string;
  workerAvailable: boolean;
  error: string | null;
  models: SegmentationModel[];
}

export interface SegmentationJob {
  jobId: string;
  patientId: number;
  volumeId: number;
  model: string;
  name: string | null;
  state: 'queued' | 'running' | 'succeeded' | 'failed';
  message: string | null;
  segmentationId: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}
