package com.medicaljava.volumerestservice.controller;

import com.medicaljava.volumerestservice.model.Patient;
import com.medicaljava.volumerestservice.repository.PatientRepository;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

@RestController
@RequestMapping("/api/Patients")
public class PatientsController {

    private final PatientRepository repo;

    public PatientsController(PatientRepository repo) {
        this.repo = repo;
    }

    @GetMapping
    public ResponseEntity<List<Patient>> get() {
        return ResponseEntity.ok(repo.getPatientSummaries());
    }

    @GetMapping("/{id}")
    public ResponseEntity<Patient> get(@PathVariable int id) {
        return ResponseEntity.ok(repo.getPatient(id));
    }
}
