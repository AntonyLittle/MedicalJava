package com.medicaljava.volumerestservice.controller;

import com.medicaljava.volumerestservice.model.Volume;
import com.medicaljava.volumerestservice.repository.PatientRepository;

import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody;

import java.util.List;

@RestController
@RequestMapping("/api/Patients/{patientId}/Volumes")
public class VolumesController {

    private final PatientRepository repo;

    public VolumesController(PatientRepository repo) {
        this.repo = repo;
    }

    @GetMapping
    public ResponseEntity<List<Volume>> get(@PathVariable int patientId) {
        return ResponseEntity.ok(repo.getVolumeSummaries(patientId));
    }

    @GetMapping("/{id}")
    public ResponseEntity<Volume> get(@PathVariable int patientId, @PathVariable int id) {
        return ResponseEntity.ok(repo.getVolume(patientId, id));
    }

    @GetMapping(value = "/{id}/binary", produces = MediaType.APPLICATION_OCTET_STREAM_VALUE)
    public ResponseEntity<StreamingResponseBody> getBinary(@PathVariable int patientId, @PathVariable int id) {
        return ResponseEntity.ok()
                .contentType(MediaType.APPLICATION_OCTET_STREAM)
                .body(repo.getVolumeBinary(patientId, id));
    }
}
