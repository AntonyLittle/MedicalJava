import { Box, FormControl, InputLabel, MenuItem, Select, type SelectChangeEvent } from '@mui/material';
import type { Patient, Volume } from '../api/types';

interface HierarchySelectorProps {
  patients: Patient[];
  selectedPatientId: number | null;
  onPatientChange: (patientId: number) => void;
  volumes: Volume[];
  selectedVolumeId: number | null;
  onVolumeChange: (volumeId: number) => void;
}

export function HierarchySelector({
  patients,
  selectedPatientId,
  onPatientChange,
  volumes,
  selectedVolumeId,
  onVolumeChange,
}: HierarchySelectorProps) {
  return (
    <Box sx={{ display: 'flex', gap: 2 }}>
      <FormControl sx={{ minWidth: 200 }}>
        <InputLabel id="patient-label">Patient</InputLabel>
        <Select
          labelId="patient-label"
          label="Patient"
          value={selectedPatientId ?? ''}
          onChange={(event: SelectChangeEvent<number>) => onPatientChange(Number(event.target.value))}
        >
          {patients.map((patient) => (
            <MenuItem key={patient.patientId} value={patient.patientId}>
              {patient.name}
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      <FormControl sx={{ minWidth: 200 }} disabled={selectedPatientId == null}>
        <InputLabel id="volume-label">Volume</InputLabel>
        <Select
          labelId="volume-label"
          label="Volume"
          value={selectedVolumeId ?? ''}
          onChange={(event: SelectChangeEvent<number>) => onVolumeChange(Number(event.target.value))}
        >
          {volumes.map((volume) => (
            <MenuItem key={volume.volumeId} value={volume.volumeId}>
              {volume.name}
            </MenuItem>
          ))}
        </Select>
      </FormControl>
    </Box>
  );
}
