import { parseBinaryVolume } from './binaryVolume';
import type {
  ImportStatus,
  Patient,
  ScanResult,
  Segment,
  Segmentation,
  SegmentationJob,
  SegmentationModelList,
  Volume,
} from './types';

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

// Store errors come back as RFC 9457 problem details; Spring's fallback error body uses `message`.
function errorMessage(url: string, status: number, body: string): string {
  if (status === 413) return 'Upload is too large for the server';
  try {
    const parsed = JSON.parse(body) as { detail?: string; message?: string };
    const detail = parsed.detail || parsed.message;
    if (detail) return detail;
  } catch {
    // Not JSON; fall through to the generic message.
  }
  if (status === 404) return 'Not found – it may have been deleted. Try refreshing.';
  return `Request to ${url} failed with status ${status}`;
}

async function request(url: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new ApiError(response.status, errorMessage(url, response.status, await response.text()));
  }
  return response;
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  return (await request(url, init)).json() as Promise<T>;
}

export function fetchPatients(): Promise<Patient[]> {
  return getJson<Patient[]>('/api/Patients');
}

export function fetchVolumes(patientId: number): Promise<Volume[]> {
  return getJson<Volume[]>(`/api/Patients/${patientId}/Volumes`);
}

export async function fetchVolume(patientId: number, volumeId: number): Promise<Volume> {
  const response = await request(`/api/Patients/${patientId}/Volumes/${volumeId}/binary`);
  return parseBinaryVolume(await response.arrayBuffer());
}

// Reading the empty 204 body stops Chromium reporting the request as aborted.
export async function deleteVolume(patientId: number, volumeId: number): Promise<void> {
  await (await request(`/api/Patients/${patientId}/Volumes/${volumeId}`, { method: 'DELETE' })).text();
}

export async function deletePatient(patientId: number): Promise<void> {
  await (await request(`/api/Patients/${patientId}`, { method: 'DELETE' })).text();
}

export function rescanDataDirectory(): Promise<ScanResult> {
  return getJson<ScanResult>('/api/import', { method: 'POST' });
}

export function fetchImportStatus(): Promise<ImportStatus> {
  return getJson<ImportStatus>('/api/import/status');
}

export interface UploadOptions {
  // Upload into this patient; when null, the server files each series under the patient named in its DICOM tags.
  patientId: number | null;
  files: File[];
  // Fraction of the request body sent, 0..1. Reaches 1 before the server has finished decoding.
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

// Uses XMLHttpRequest because fetch() cannot report upload progress. Resolves with one volume per uploaded series.
export function uploadVolumes({ patientId, files, onProgress, signal }: UploadOptions): Promise<Volume[]> {
  const url = patientId == null ? '/api/Volumes' : `/api/Patients/${patientId}/Volumes`;
  const form = new FormData();
  for (const file of files) form.append('files', file, file.name);

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded / event.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(JSON.parse(xhr.responseText) as Volume[]);
      } else {
        reject(new ApiError(xhr.status, errorMessage(url, xhr.status, xhr.responseText)));
      }
    };
    xhr.onerror = () => reject(new ApiError(0, 'Upload failed: could not reach the server'));
    xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));

    if (signal?.aborted) {
      xhr.abort();
      return;
    }
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(form);
  });
}

// ---- segmentations ----

function segmentationsUrl(patientId: number, volumeId: number): string {
  return `/api/Patients/${patientId}/Volumes/${volumeId}/Segmentations`;
}

function jsonInit(method: string, body: unknown, revision?: number): RequestInit {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (revision !== undefined) headers['If-Match'] = `"${revision}"`;
  return { method, headers, body: JSON.stringify(body) };
}

export function fetchSegmentations(patientId: number, volumeId: number): Promise<Segmentation[]> {
  return getJson<Segmentation[]>(segmentationsUrl(patientId, volumeId));
}

export function createSegmentation(
  patientId: number,
  volumeId: number,
  name: string,
  segments: Segment[]
): Promise<Segmentation> {
  return getJson<Segmentation>(segmentationsUrl(patientId, volumeId), jsonInit('POST', { name, segments }));
}

export function updateSegmentation(
  segmentation: Segmentation,
  changes: { name?: string; segments?: Segment[] }
): Promise<Segmentation> {
  const url = `${segmentationsUrl(segmentation.patientId, segmentation.volumeId)}/${segmentation.segmentationId}`;
  return getJson<Segmentation>(url, jsonInit('PATCH', changes, segmentation.revision));
}

export async function deleteSegmentation(segmentation: Segmentation): Promise<void> {
  const url = `${segmentationsUrl(segmentation.patientId, segmentation.volumeId)}/${segmentation.segmentationId}`;
  await (await request(url, { method: 'DELETE' })).text();
}

// The browser undoes the server's gzip Content-Encoding.
export async function fetchLabels(segmentation: Segmentation): Promise<Uint8Array> {
  const url = `${segmentationsUrl(segmentation.patientId, segmentation.volumeId)}/${segmentation.segmentationId}/labels`;
  return new Uint8Array(await (await request(url)).arrayBuffer());
}

// Labels are mostly background, so they are gzipped for the upload (typically a hundredth of the size).
export async function saveLabels(segmentation: Segmentation, labels: Uint8Array): Promise<Segmentation> {
  const url = `${segmentationsUrl(segmentation.patientId, segmentation.volumeId)}/${segmentation.segmentationId}/labels`;
  const compressed = await new Response(
    new Blob([labels as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'))
  ).arrayBuffer();
  return getJson<Segmentation>(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'gzip',
      'If-Match': `"${segmentation.revision}"`,
    },
    body: compressed,
  });
}

export function dicomSegUrl(segmentation: Segmentation): string {
  return `${segmentationsUrl(segmentation.patientId, segmentation.volumeId)}/${segmentation.segmentationId}/dicom`;
}

export function importDicomSeg(patientId: number, volumeId: number, file: File): Promise<Segmentation> {
  const form = new FormData();
  form.append('file', file, file.name);
  return getJson<Segmentation>(`${segmentationsUrl(patientId, volumeId)}/dicom`, { method: 'POST', body: form });
}

export function fetchSegmentationModels(): Promise<SegmentationModelList> {
  return getJson<SegmentationModelList>('/api/segmentation/models');
}

export function startAutoSegmentation(
  patientId: number,
  volumeId: number,
  model: string,
  name?: string
): Promise<SegmentationJob> {
  return getJson<SegmentationJob>(`${segmentationsUrl(patientId, volumeId)}/auto`, jsonInit('POST', { model, name }));
}

export function fetchSegmentationJob(jobId: string): Promise<SegmentationJob> {
  return getJson<SegmentationJob>(`/api/segmentation/jobs/${encodeURIComponent(jobId)}`);
}
