package com.medicaljava.volumerestservice.controller;

import com.medicaljava.volumerestservice.model.Volume;
import com.medicaljava.volumerestservice.repository.PatientRepository;
import com.medicaljava.volumerestservice.store.VolumeImporter;
import com.medicaljava.volumerestservice.store.VolumeStore.VolumeKey;

import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody;
import org.springframework.web.servlet.support.ServletUriComponentsBuilder;

import java.io.IOException;
import java.util.List;

@RestController
@RequestMapping("/api/Patients/{patientId}/Volumes")
public class VolumesController {

    private final PatientRepository repo;
    private final VolumeImporter importer;

    public VolumesController(PatientRepository repo, VolumeImporter importer) {
        this.repo = repo;
        this.importer = importer;
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

    /** Uploads DICOM files and/or zip archives; one volume is created per series. */
    @PostMapping(consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ResponseEntity<List<Volume>> upload(@PathVariable int patientId,
            @RequestParam("files") List<MultipartFile> files) throws IOException {
        return created(repo, importer.importUpload(patientId, files));
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Void> delete(@PathVariable int patientId, @PathVariable int id) {
        repo.deleteVolume(patientId, id);
        return ResponseEntity.noContent().build();
    }

    // Location points at the volume when exactly one was created.
    static ResponseEntity<List<Volume>> created(PatientRepository repo, List<VolumeKey> keys) {
        var volumes = keys.stream()
                .map(k -> repo.getVolumeSummaries(k.patientId()).stream()
                        .filter(v -> v.volumeId() == k.volumeId())
                        .findFirst()
                        .orElseThrow())
                .toList();
        var response = ResponseEntity.status(201);
        if (keys.size() == 1) {
            response.location(ServletUriComponentsBuilder.fromCurrentContextPath()
                    .path("/api/Patients/{patientId}/Volumes/{id}")
                    .buildAndExpand(keys.getFirst().patientId(), keys.getFirst().volumeId())
                    .toUri());
        }
        return response.body(volumes);
    }
}
