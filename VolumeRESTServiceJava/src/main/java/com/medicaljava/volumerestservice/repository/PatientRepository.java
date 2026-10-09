package com.medicaljava.volumerestservice.repository;

import com.medicaljava.volumerestservice.model.Patient;
import com.medicaljava.volumerestservice.model.Volume;

import java.util.List;

public interface PatientRepository {

    List<Patient> getPatientSummaries();

    Patient getPatient(int patientId);

    List<Volume> getVolumeSummaries(int patientId);

    Volume getVolume(int patientId, int volumeId);
}
