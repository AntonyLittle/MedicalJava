package com.medicaljava.volumerestservice.controller;

import com.medicaljava.volumerestservice.repository.PatientRepository;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/Patients")
public class PatientsController {

    private final PatientRepository repo;

    public PatientsController(PatientRepository repo) {
        this.repo = repo;
    }

    @GetMapping
    public ResponseEntity<?> get() {
        try {
            return ResponseEntity.ok(repo.getPatientSummaries());
        } catch (Exception e) {
            return ResponseEntity.badRequest().build();
        }
    }

    @GetMapping("/{id}")
    public ResponseEntity<?> get(@PathVariable int id) {
        try {
            return ResponseEntity.ok(repo.getPatient(id));
        } catch (Exception e) {
            return ResponseEntity.badRequest().build();
        }
    }

    @PostMapping
    public void post(@RequestBody String value) {
    }

    @PutMapping("/{id}")
    public void put(@PathVariable int id, @RequestBody String value) {
    }

    @DeleteMapping("/{id}")
    public void delete(@PathVariable int id) {
    }
}
