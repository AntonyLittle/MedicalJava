package com.medicaljava.volumerestservice.repository;

import com.medicaljava.volumerestservice.model.Patient;
import com.medicaljava.volumerestservice.model.Volume;

import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody;

import java.util.List;

public interface PatientRepository {

    List<Patient> getPatientSummaries();

    Patient getPatient(int patientId);

    List<Volume> getVolumeSummaries(int patientId);

    Volume getVolume(int patientId, int volumeId);

    StreamingResponseBody getVolumeBinary(int patientId, int volumeId);

    void deletePatient(int patientId);

    void deleteVolume(int patientId, int volumeId);
}
