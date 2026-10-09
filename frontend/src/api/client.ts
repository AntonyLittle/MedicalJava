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

export function fetchVolume(patientId: number, volumeId: number): Promise<Volume> {
  return getJson<Volume>(`/api/Patients/${patientId}/Volumes/${volumeId}`);
}
