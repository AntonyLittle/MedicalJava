import type { Patient, Volume } from './types';

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request to ${url} failed with status ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export function fetchPatients(): Promise<Patient[]> {
  return getJson<Patient[]>('/api/Patients');
}

export function fetchVolumes(patientId: number): Promise<Volume[]> {
  return getJson<Volume[]>(`/api/Patients/${patientId}/Volumes`);
}

export async function fetchVolume(patientId: number, volumeId: number): Promise<Volume> {
  const volume = await getJson<Volume>(`/api/Patients/${patientId}/Volumes/${volumeId}`);
  // The JSON arrives as plain number[]; Int16Array is about 4x smaller and faster to index.
  for (const slice of volume.slices) {
    slice.radiodensities = Int16Array.from(slice.radiodensities);
  }
  return volume;
}
