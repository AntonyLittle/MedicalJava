package com.medicaljava.volumerestservice.controller;

import com.medicaljava.volumerestservice.repository.PatientRepository;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.ArrayList;

@RestController
@RequestMapping("/api/Patients/{patientId}/Volumes")
public class VolumesController {

    private final PatientRepository repo;

    public VolumesController(PatientRepository repo) {
        this.repo = repo;
    }

    @GetMapping
    public ResponseEntity<?> get(@PathVariable int patientId) {
        try {
            return ResponseEntity.ok(new ArrayList<>(repo.getVolumeSummaries(patientId)));
        } catch (Exception e) {
            return ResponseEntity.badRequest().build();
        }
    }

    @GetMapping("/{id}")
    public ResponseEntity<?> get(@PathVariable int patientId, @PathVariable int id) {
        try {
            return ResponseEntity.ok(repo.getVolume(patientId, id));
        } catch (Exception e) {
            return ResponseEntity.badRequest().build();
        }
    }

    @PostMapping
    public void post(@PathVariable int patientId, @RequestBody String value) {
    }

    @PutMapping("/{id}")
    public void put(@PathVariable int patientId, @PathVariable int id, @RequestBody String value) {
    }

    @DeleteMapping("/{id}")
    public void delete(@PathVariable int patientId, @PathVariable int id) {
    }
}
